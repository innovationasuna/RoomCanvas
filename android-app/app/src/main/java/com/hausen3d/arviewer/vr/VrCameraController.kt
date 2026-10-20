package com.hausen3d.arviewer.vr

import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import dev.romainguy.kotlin.math.rotation
import dev.romainguy.kotlin.math.translation
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 手持漫游的状态式相机控制器。
 *
 * 相机不再由 AR 位姿直驱，而是每帧从一组虚拟状态重新合成：
 *
 * ```
 * B_pos, B_yaw   基准位姿（进入 / 重新居中 / 回起点 / 跟踪重建时确定）
 * p              方向键累计位移
 * φ              滑动累计偏航
 * θ              滑动累计俯仰
 * t_ar           AR 相对参考位姿的位移（只取 x、z，参考相机坐标系）
 * ψ_ar           AR 相对参考位姿的偏航
 *
 * heading = B_yaw + ψ_ar + φ
 * pos     = B_pos + R_y(B_yaw) · t_ar + p
 * C       = T(pos) · R_y(heading) · R_x(θ)
 * ```
 *
 * 关键点：**先求朝向、再按朝向积分位移**，所以“边转边走”会沿当前视线前进；
 * 而位移本身不会被后续转身带着转（旧版 `C_start · ΔAR` 连乘会出现这种跳变）。
 *
 * @param startPosition 房间起点（人眼高度）
 * @param startYawDegrees 房间初始朝向（度，绕 +Y）
 * @param roomMinX/roomMaxX/roomMinZ/roomMaxZ 房间包围盒（未内缩）
 * @param moveGain 真实位移 → 虚拟位移的倍率
 */
class VrCameraController(
    private val startPosition: Float3,
    private val startYawDegrees: Float,
    roomMinX: Float,
    roomMaxX: Float,
    roomMinZ: Float,
    roomMaxZ: Float,
    private val moveGain: Float = 1.0f
) {

    companion object {
        /** 方向键移动速度（米/秒） */
        const val MOVE_SPEED_MPS = 1.2f

        /** 起停平滑系数（1/s），约 0.15 s 达到目标速度 */
        const val SPEED_SMOOTH = 10f

        /** 视角滑动灵敏度（度/像素） */
        const val LOOK_DEG_PER_PX = 0.15f

        /** 俯仰上下限（度） */
        const val PITCH_LIMIT_DEG = 70f

        /** 边界内缩（米） */
        const val BOUNDARY_INSET_M = 0.3f

        private const val DEG_TO_RAD = (Math.PI / 180.0).toFloat()
        private const val RAD_TO_DEG = (180.0 / Math.PI).toFloat()
    }

    // ---------------- 虚拟状态 ----------------

    private var basePosition: Float3 = startPosition
    private var baseYawDegrees: Float = startYawDegrees
    private var moveOffset: Float3 = Float3(0f, 0f, 0f)
    private var lookYawDegrees: Float = 0f
    private var lookPitchDegrees: Float = 0f

    /** 平滑后的移动速度标量（m/s） */
    private var smoothedSpeed: Float = 0f

    /** 无输入减速期间沿用最后一次方向，避免松手瞬间方向乱跳 */
    private var lastMoveDirection: Float3 = Float3(0f, 0f, -1f)

    // ---------------- AR 参考 ----------------

    /** AR 位姿相对参考位姿的位移，已换到参考相机坐标系（只保留 x、z） */
    private var arTranslation: Float3 = Float3(0f, 0f, 0f)
    private var arYawDeltaDegrees: Float = 0f

    private var arReferencePosition: Float3 = Float3(0f, 0f, 0f)

    /** 参考位姿的原始偏航（用于位移方向映射，sin/cos 周期性，无需解卷绕） */
    private var arReferenceRawYawDegrees: Float = 0f

    /** 参考位姿的连续偏航（用于 ψ_ar 解卷绕） */
    private var arReferenceContinuousYawDegrees: Float = 0f

    /** 连续偏航：对帧间差值做 ±180° 解卷绕，跨 ±180° 不跳变 */
    private var continuousYawDegrees: Float = 0f
    private var lastRawYawDegrees: Float? = null

    var hasArReference: Boolean = false
        private set

    // ---------------- 房间边界 ----------------

    private val insetMinX = roomMinX + BOUNDARY_INSET_M
    private val insetMaxX = roomMaxX - BOUNDARY_INSET_M
    private val insetMinZ = roomMinZ + BOUNDARY_INSET_M
    private val insetMaxZ = roomMaxZ - BOUNDARY_INSET_M

    // ---------------- 对外状态 ----------------

    /** 菜单里的速度倍率：0.5× / 1× / 2× */
    var speedScale: Float = 1f

    /** 当前虚拟朝向（度），= B_yaw + ψ_ar + φ */
    val headingDegrees: Float
        get() = baseYawDegrees + arYawDeltaDegrees + lookYawDegrees

    /** 当前虚拟位置（已做边界夹取） */
    fun currentPosition(): Float3 = computePosition()

    // ---------------- AR 位姿 ----------------

    /**
     * 每帧（仅跟踪有效时）调用：更新连续偏航、t_ar、ψ_ar。
     */
    fun updateArPose(pose: Mat4) {
        val rawYaw = extractYawDegrees(pose)
        accumulateYaw(rawYaw)
        val position = pose.translation

        if (!hasArReference) {
            rebuildArReference(position, rawYaw)
            return
        }

        // 真实位移先在参考相机坐标系中表达（只取水平分量），
        // 合成相机时再用 R_y(B_yaw) 映射进房间坐标系。
        val dx = position.x - arReferencePosition.x
        val dz = position.z - arReferencePosition.z
        val inReferenceFrame = rotateY(Float3(dx, 0f, dz), -arReferenceRawYawDegrees)
        arTranslation = Float3(
            inReferenceFrame.x * moveGain,
            0f,
            inReferenceFrame.z * moveGain
        )
        arYawDeltaDegrees = continuousYawDegrees - arReferenceContinuousYawDegrees
    }

    /** 进入漫游时建立参考位姿（不改变虚拟位姿） */
    fun attachArReference(pose: Mat4) {
        val rawYaw = extractYawDegrees(pose)
        accumulateYaw(rawYaw)
        rebuildArReference(pose.translation, rawYaw)
    }

    /**
     * 关闭真实走动：把当前 AR 贡献折算进基准位姿，画面完全不跳变。
     */
    fun detachAr() {
        foldCurrentIntoBase(keepPitch = true)
        clearArReference()
    }

    /** 重新居中：保持当前画面不跳变，清零俯仰与累计位移 */
    fun recenter(arPose: Mat4?) {
        foldCurrentIntoBase(keepPitch = false)
        if (arPose != null) {
            attachArReference(arPose)
        } else {
            clearArReference()
        }
    }

    /** 回到房间起点 */
    fun resetToStart(arPose: Mat4?) {
        basePosition = startPosition
        baseYawDegrees = startYawDegrees
        moveOffset = Float3(0f, 0f, 0f)
        lookYawDegrees = 0f
        lookPitchDegrees = 0f
        smoothedSpeed = 0f
        lastMoveDirection = Float3(0f, 0f, -1f)

        if (arPose != null) {
            attachArReference(arPose)
        } else {
            clearArReference()
        }
    }

    /**
     * 跟踪丢失后恢复 / 屏幕方向变化：AR 可能重定位到新原点。
     * 保持当前虚拟视角，只把参考位姿换成新位姿。
     */
    fun reanchorKeepingView(arPose: Mat4) {
        foldCurrentIntoBase(keepPitch = true)
        attachArReference(arPose)
    }

    // ---------------- 输入 ----------------

    /**
     * 方向键输入。
     *
     * @param forwardAxis +1 前进，-1 后退
     * @param strafeAxis  +1 右移，-1 左移
     * @param dt 帧时间（秒，已夹取上限）
     */
    fun applyMoveInput(forwardAxis: Float, strafeAxis: Float, dt: Float) {
        if (dt <= 0f) return
        val forward = forwardAxis.coerceIn(-1f, 1f)
        val strafe = strafeAxis.coerceIn(-1f, 1f)
        val hasInput = forward != 0f || strafe != 0f

        if (hasInput) {
            val headingRad = headingDegrees * DEG_TO_RAD
            val sinH = sin(headingRad)
            val cosH = cos(headingRad)
            // 相机朝 -Z：forward = (-sin h, 0, -cos h)，right = (cos h, 0, -sin h)
            val dx = -sinH * forward + cosH * strafe
            val dz = -cosH * forward - sinH * strafe
            val length = sqrt(dx * dx + dz * dz)
            if (length > 1e-4f) {
                // 斜向归一化：前 + 左的速度与直行相同
                lastMoveDirection = Float3(dx / length, 0f, dz / length)
            }
        }

        val targetSpeed =
            if (hasInput) MOVE_SPEED_MPS * speedScale.coerceIn(0.1f, 4f) else 0f
        val alpha = 1f - exp(-SPEED_SMOOTH * dt)
        smoothedSpeed += (targetSpeed - smoothedSpeed) * alpha
        if (!hasInput && smoothedSpeed < 0.005f) {
            smoothedSpeed = 0f
            return
        }

        moveOffset = Float3(
            moveOffset.x + lastMoveDirection.x * smoothedSpeed * dt,
            0f,
            moveOffset.z + lastMoveDirection.z * smoothedSpeed * dt
        )
    }

    /** 右半屏滑动：Δx → 偏航，Δy → 俯仰 */
    fun applyLookDelta(dxPixels: Float, dyPixels: Float) {
        // 手指向右滑 = 视线向右转 = 朝向角减小；手指向下滑 = 低头
        lookYawDegrees -= dxPixels * LOOK_DEG_PER_PX
        lookPitchDegrees = (lookPitchDegrees - dyPixels * LOOK_DEG_PER_PX)
            .coerceIn(-PITCH_LIMIT_DEG, PITCH_LIMIT_DEG)
    }

    // ---------------- 合成 ----------------

    fun cameraPose(): Mat4 {
        val position = computePosition()
        return translation(position) *
            rotation(Float3(0f, 1f, 0f), headingDegrees) *
            rotation(Float3(1f, 0f, 0f), lookPitchDegrees)
    }

    fun initialCameraPose(): Mat4 =
        translation(startPosition) * rotation(Float3(0f, 1f, 0f), startYawDegrees)

    private fun computePosition(): Float3 {
        val arOffset = if (hasArReference) {
            rotateY(arTranslation, baseYawDegrees)
        } else {
            Float3(0f, 0f, 0f)
        }

        // AR 贡献先单独夹取：真实走动越界时只让 AR 这一侧饱和。
        // 不能把 AR 的越界量折进 moveOffset，否则人走回屋里时虚拟位置会反向漂移
        // （越界 1 m，走回来后反而比起点多退 1 m）。
        val arX = clampToRange(basePosition.x + arOffset.x, insetMinX, insetMaxX)
        val arZ = clampToRange(basePosition.z + arOffset.z, insetMinZ, insetMaxZ)

        // 方向键位移再叠加并夹取；这里的越界量折回 moveOffset，
        // 否则持续按前进会累积一个“隐形”位移，转身后要先把这段抵消掉才能离开墙边。
        val rawX = arX + moveOffset.x
        val rawZ = arZ + moveOffset.z
        val clampedX = clampToRange(rawX, insetMinX, insetMaxX)
        val clampedZ = clampToRange(rawZ, insetMinZ, insetMaxZ)

        if (clampedX != rawX || clampedZ != rawZ) {
            moveOffset = Float3(
                moveOffset.x + (clampedX - rawX),
                0f,
                moveOffset.z + (clampedZ - rawZ)
            )
        }
        return Float3(clampedX, basePosition.y, clampedZ)
    }

    /** 把当前画面位置/朝向写进基准，随后清零按键与滑动偏移 */
    private fun foldCurrentIntoBase(keepPitch: Boolean) {
        val position = computePosition()
        basePosition = position
        baseYawDegrees = headingDegrees
        moveOffset = Float3(0f, 0f, 0f)
        lookYawDegrees = 0f
        if (!keepPitch) lookPitchDegrees = 0f
        smoothedSpeed = 0f
    }

    private fun rebuildArReference(position: Float3, rawYawDegrees: Float) {
        arReferencePosition = position
        arReferenceRawYawDegrees = rawYawDegrees
        arReferenceContinuousYawDegrees = continuousYawDegrees
        arTranslation = Float3(0f, 0f, 0f)
        arYawDeltaDegrees = 0f
        hasArReference = true
    }

    private fun clearArReference() {
        hasArReference = false
        arTranslation = Float3(0f, 0f, 0f)
        arYawDeltaDegrees = 0f
    }

    // ---------------- 数学工具 ----------------

    private fun accumulateYaw(rawYawDegrees: Float) {
        val last = lastRawYawDegrees
        if (last == null) {
            continuousYawDegrees = rawYawDegrees
        } else {
            var delta = rawYawDegrees - last
            while (delta > 180f) delta -= 360f
            while (delta < -180f) delta += 360f
            continuousYawDegrees += delta
        }
        lastRawYawDegrees = rawYawDegrees
    }

    /**
     * 从 camera-to-world 位姿提取水平偏航：
     * 前向轴 = 位姿的 -Z 列，投影到水平面后 `yaw = atan2(-f.x, -f.z)`。
     *
     * 手机接近垂直朝下时前向轴的水平分量趋近 0，此时改用右向轴兜底，
     * 避免在“游戏握姿”下偏航剧烈抖动。
     */
    private fun extractYawDegrees(pose: Mat4): Float {
        val forwardX = -pose.z.x
        val forwardZ = -pose.z.z
        val horizontalSquared = forwardX * forwardX + forwardZ * forwardZ
        val yawRad = if (horizontalSquared > 0.09f) {
            atan2(-forwardX, -forwardZ)
        } else {
            // right = 位姿的 +X 列；水平投影下 h = atan2(-right.z, right.x)
            atan2(-pose.x.z, pose.x.x)
        }
        return yawRad * RAD_TO_DEG
    }

    private fun rotateY(v: Float3, degrees: Float): Float3 {
        val rad = degrees * DEG_TO_RAD
        val cosA = cos(rad)
        val sinA = sin(rad)
        return Float3(
            v.x * cosA + v.z * sinA,
            v.y,
            -v.x * sinA + v.z * cosA
        )
    }

    private fun clampToRange(value: Float, min: Float, max: Float): Float =
        if (max < min) (min + max) * 0.5f else value.coerceIn(min, max)
}
