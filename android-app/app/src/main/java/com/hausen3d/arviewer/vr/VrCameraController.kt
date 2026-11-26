package com.hausen3d.arviewer.vr

import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import dev.romainguy.kotlin.math.rotation
import dev.romainguy.kotlin.math.translation
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * 手持漫游的状态式相机控制器。
 *
 * 相机不把 AR 矩阵直接连乘到场景上，而是每帧从一组虚拟状态重新合成：
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
 * AR 位姿恢复参与相机合成，但平移和偏航分别需要线性加速度计与陀螺仪确认。
 * 两个通道都按帧增量累积，静止时冻结而不是回退到参考点；AR 原始值仍保留用于日志。
 *
 * @param startPosition 房间起点（人眼高度）
 * @param startYawDegrees 房间初始朝向（度，绕 +Y）
 * @param roomMinX/roomMaxX/roomMinZ/roomMaxZ 房间包围盒（未内缩）
 * @param roomMinY/roomMaxY 房间竖直包围盒（未内缩），用于限制升降范围
 * @param moveGain 真实位移 → 虚拟位移的倍率
 */
class VrCameraController(
    private val startPosition: Float3,
    private val startYawDegrees: Float,
    roomMinX: Float,
    roomMaxX: Float,
    roomMinZ: Float,
    roomMaxZ: Float,
    roomMinY: Float,
    roomMaxY: Float,
    private val moveGain: Float = 1.0f
) {

    companion object {
        /** 方向键移动速度（米/秒） */
        const val MOVE_SPEED_MPS = 1.2f

        /** 升降键速度（米/秒）：比水平慢一点，避免上下猛冲 */
        const val VERTICAL_SPEED_MPS = 0.85f

        /** 起停平滑系数（1/s），约 0.15 s 达到目标速度 */
        const val SPEED_SMOOTH = 10f

        /** 视角滑动灵敏度（度/像素） */
        const val LOOK_DEG_PER_PX = 0.15f

        /** 俯仰上下限（度） */
        const val PITCH_LIMIT_DEG = 70f

        /** 边界内缩（米） */
        const val BOUNDARY_INSET_M = 0.3f

        /** 升降下界：离地面至少 0.4 m（蹲下看低处） */
        const val MIN_EYE_ABOVE_FLOOR_M = 0.4f

        /** 升降上界：离天花板至少 0.25 m（抬头不穿顶） */
        const val CEILING_CLEARANCE_M = 0.25f

        /**
         * 静止 → 走动 的速度阈值（m/s）。
         * 正常步速 0.6~1.5 m/s，VIO 静止漂移通常 < 0.05 m/s，取中间偏保守的值。
         */
        const val AR_WALK_ENTER_SPEED_MPS = 0.15f

        /** 走动 → 静止 的速度阈值（m/s）。比进入阈值低，形成滞回，避免临界速度反复切换 */
        const val AR_WALK_EXIT_SPEED_MPS = 0.07f

        /**
         * AR 速度矢量的低通系数（1/s）。
         * 必须对**速度矢量**平滑后再取模：若先取速率再平滑，帧间抖动会被整流成一个
         * 恒为正的假速度，导致静止时永远判定为「在走」。
         */
        const val AR_SPEED_SMOOTH = 10f

        /** 低于退出阈值持续多久才确认静止（s）；覆盖走路中各步之间的瞬时最低速 */
        const val AR_STILL_HOLD_S = 0.3f

        /**
         * 单帧位移对应的速度上限（m/s）。
         * 室内正常移动远低于此值；超过说明 AR 发生了重定位跳变，整帧位移丢弃，
         * 否则虚拟相机会跟着瞬移（房间边界夹取只会把它拍到墙上）。
         */
        const val AR_MAX_STEP_SPEED_MPS = 3f

        /** 单帧偏航角速度上限，过滤重定位造成的朝向跳变 */
        const val AR_MAX_YAW_SPEED_DPS = 240f

        /** 位姿间隔异常时重建参考，不把卡顿期间的累计位移一次性应用给相机 */
        const val MAX_AR_POSE_INTERVAL_S = 0.2f

        /** AR 位姿在独立 IMU 确认对应运动后参与相机合成 */
        const val AR_POSE_DRIVES_CAMERA = true

        private const val DEG_TO_RAD = (Math.PI / 180.0).toFloat()
        private const val RAD_TO_DEG = (180.0 / Math.PI).toFloat()
    }

    // ---------------- 虚拟状态 ----------------

    private var basePosition: Float3 = startPosition
    private var baseYawDegrees: Float = startYawDegrees
    private var moveOffset: Float3 = Float3(0f, 0f, 0f)
    private var lookYawDegrees: Float = 0f
    private var lookPitchDegrees: Float = 0f

    /** 升降键累计高度（米，相对起点）；最终 Y 由房间上下界夹取 */
    private var heightOffset: Float = 0f

    /** 最近一次 [computePosition] 的结果；热路径用字段传递，避免每帧构造 Float3 */
    private var positionX: Float = 0f
    private var positionY: Float = 0f
    private var positionZ: Float = 0f

    /** 复用的水平旋转结果 [x, z]，避免 [computePosition] 每帧分配 Float3 */
    private val horizontalScratch = FloatArray(2)

    /** 平滑后的移动速度标量（m/s） */
    private var smoothedSpeed: Float = 0f

    /** 平滑后的升降速度（m/s，正为上升） */
    private var smoothedVerticalSpeed: Float = 0f

    /** 无输入减速期间沿用最后一次方向，避免松手瞬间方向乱跳 */
    private var lastMoveDirection: Float3 = Float3(0f, 0f, -1f)
    private var lastVerticalDirection: Float = 1f

    // ---------------- AR 参考 ----------------

    /** AR 位姿相对参考位姿的位移，已换到参考相机坐标系（只保留 x、z） */
    private var arTranslation: Float3 = Float3(0f, 0f, 0f)

    /** 原始 AR 偏航仅用于观测；实际合成使用经陀螺仪确认后逐帧累积的偏航 */
    private var arYawDeltaDegrees: Float = 0f
    private var appliedArYawDeltaDegrees: Float = 0f

    /** 上一帧 AR 原始位置（AR 世界系），用于求帧间位移 */
    private var lastArPosition: Float3 = Float3(0f, 0f, 0f)
    private var lastArPoseTimestampNs: Long = 0L

    /** 平滑后的 AR 位移速度（AR 世界系，m/s），用于区分真实走动与静止漂移 */
    private var arVelocitySmoothedX: Float = 0f
    private var arVelocitySmoothedZ: Float = 0f

    /** 速度低于退出阈值已持续的时间（s） */
    private var arStillSeconds: Float = 0f

    /**
     * true = 按真实走动跟随；false = 正在吸收静止时的 VIO 漂移。
     * 建立/重建参考后先按静止处理：真走起来 1~2 帧内就会超过进入阈值，
     * 但每次跟踪恢复都不会再白漏一段漂移。
     */
    private var arFollowingWalk: Boolean = false

    /** 参考位姿的原始偏航（用于位移方向映射，sin/cos 周期性，无需解卷绕） */
    private var arReferenceRawYawDegrees: Float = 0f

    /** 参考位姿的连续偏航（用于 ψ_ar 解卷绕） */
    private var arReferenceContinuousYawDegrees: Float = 0f

    /** 连续偏航：对帧间差值做 ±180° 解卷绕，跨 ±180° 不跳变 */
    private var continuousYawDegrees: Float = 0f
    private var lastRawYawDegrees: Float? = null

    // ---------------- 调试观测（只读，仅供真机日志） ----------------

    /** 已实际参与积分判定的 AR 位姿帧数 */
    var arPoseUpdateCount: Long = 0L
        private set

    /** 最近一帧 AR 原始位置（AR 世界系，米），用于观察 VIO 本身的漂移量 */
    var debugRawArX: Float = 0f
        private set
    var debugRawArZ: Float = 0f
        private set

    /** 最近一帧通过跳变检查的 AR 水平位移（米）与对应 AR 帧时间（秒） */
    private var lastStepX: Float = 0f
    private var lastStepZ: Float = 0f
    private var lastStepDt: Float = 0f

    /** AR 位移累计（参考相机坐标系，米） */
    val debugArTranslation: Float3 get() = arTranslation
    /** 方向键累计位移（房间坐标系，米） */
    val debugMoveOffset: Float3 get() = moveOffset
    /** 基准位姿（房间坐标系，米） */
    val debugBasePosition: Float3 get() = basePosition
    /** AR 报告的原始偏航与实际应用的偏航（度） */
    val debugArYawDeltaDegrees: Float get() = arYawDeltaDegrees
    val debugAppliedArYawDegrees: Float get() = appliedArYawDeltaDegrees
    /** 滑动累计偏航（度） */
    val debugLookYawDegrees: Float get() = lookYawDegrees
    /** 低速已持续时间（秒） */
    val debugArStillSeconds: Float get() = arStillSeconds
    /** 最近一帧通过跳变检查的 AR 位移 x/z（米） */
    val debugLastStepX: Float get() = lastStepX
    val debugLastStepZ: Float get() = lastStepZ
    /** 最近一帧的 AR 帧时间（秒） */
    val debugLastDt: Float get() = lastStepDt

    var hasArReference: Boolean = false
        private set

    /** 平滑后的 AR 位移速率（m/s），仅供真机日志排查 */
    val arWalkSpeedMps: Float
        get() = sqrt(
            arVelocitySmoothedX * arVelocitySmoothedX +
                arVelocitySmoothedZ * arVelocitySmoothedZ
        )

    /** true = 正在 1:1 跟随真实走动；false = 正在吸收静止时的漂移 */
    val isFollowingArWalk: Boolean
        get() = arFollowingWalk

    // ---------------- 房间边界 ----------------

    private val insetMinX = roomMinX + BOUNDARY_INSET_M
    private val insetMaxX = roomMaxX - BOUNDARY_INSET_M
    private val insetMinZ = roomMinZ + BOUNDARY_INSET_M
    private val insetMaxZ = roomMaxZ - BOUNDARY_INSET_M

    /** 升降范围：模型过矮或包围盒异常时退化为起点上下 0.5 m */
    private val insetMinY: Float
    private val insetMaxY: Float

    init {
        val floor = roomMinY + MIN_EYE_ABOVE_FLOOR_M
        val ceiling = roomMaxY - CEILING_CLEARANCE_M
        if (ceiling > floor) {
            insetMinY = floor
            insetMaxY = ceiling
        } else {
            insetMinY = startPosition.y - 0.5f
            insetMaxY = startPosition.y + 0.5f
        }
    }

    // ---------------- 对外状态 ----------------

    /** 菜单里的速度倍率：0.5× / 1× / 2× */
    var speedScale: Float = 1f

    /** 当前虚拟朝向（度），= B_yaw + 经 IMU 确认的 ψ_ar + φ */
    val headingDegrees: Float
        get() = baseYawDegrees + appliedArYawDegrees + lookYawDegrees

    /** AR 位姿通道是否启用；每帧是否采纳仍由对应 IMU 通道决定 */
    val isArPoseApplied: Boolean
        get() = AR_POSE_DRIVES_CAMERA

    /** 当前虚拟位置（已做边界夹取） */
    fun currentPosition(): Float3 {
        computePosition()
        return Float3(positionX, positionY, positionZ)
    }

    // ---------------- AR 位姿 ----------------

    /**
     * 每个新的 AR 位姿调用一次。时间戳同时用于去重和计算真实帧间隔，避免渲染帧率
     * 与 AR 帧率不同时把同一个位姿反复消费、或把位移速度放大。
     *
     * AR 速度只作为二级闸门；是否真有平移/旋转必须由独立 IMU 分别确认。
     * 未确认的增量直接丢弃，且不会在恢复运动后补算，因此静止漂移不会积累或突然回放。
     */
    fun updateArPose(pose: Mat4, timestampNs: Long, motion: DeviceMotionState) {
        if (timestampNs <= 0L || (hasArReference && timestampNs <= lastArPoseTimestampNs)) return

        val dt = if (hasArReference && lastArPoseTimestampNs > 0L) {
            (timestampNs - lastArPoseTimestampNs) / 1_000_000_000f
        } else {
            0f
        }
        if (hasArReference && (dt <= 0f || dt > MAX_AR_POSE_INTERVAL_S)) {
            reanchorKeepingView(pose, timestampNs)
            return
        }

        val previousContinuousYaw = continuousYawDegrees
        val rawYaw = extractYawDegrees(pose)
        accumulateYaw(rawYaw)
        val yawStep = continuousYawDegrees - previousContinuousYaw
        val position = pose.translation
        debugRawArX = position.x
        debugRawArZ = position.z
        lastStepDt = dt

        if (!hasArReference) {
            rebuildArReference(position, rawYaw, timestampNs)
            lastStepX = 0f
            lastStepZ = 0f
            return
        }
        arPoseUpdateCount++

        val rawStepX = position.x - lastArPosition.x
        val rawStepZ = position.z - lastArPosition.z
        lastArPosition = position
        lastArPoseTimestampNs = timestampNs

        // 重定位跳变保护：单帧位移超过物理上限时整帧丢弃（也不喂给速度估计）。
        val maxStep = AR_MAX_STEP_SPEED_MPS * dt
        val plausible = rawStepX * rawStepX + rawStepZ * rawStepZ <= maxStep * maxStep
        val stepX = if (plausible) rawStepX else 0f
        val stepZ = if (plausible) rawStepZ else 0f
        lastStepX = stepX
        lastStepZ = stepZ

        updateWalkState(stepX, stepZ, dt, motion.translationActive)

        if (AR_POSE_DRIVES_CAMERA && motion.translationActive && arFollowingWalk) {
            // 真实位移先在参考相机坐标系中表达（只取水平分量），
            // 合成相机时再用 R_y(B_yaw) 映射进房间坐标系。
            val inReferenceFrame = rotateY(Float3(stepX, 0f, stepZ), -arReferenceRawYawDegrees)
            arTranslation = Float3(
                arTranslation.x + inReferenceFrame.x * moveGain,
                0f,
                arTranslation.z + inReferenceFrame.z * moveGain
            )
        }

        arYawDeltaDegrees = continuousYawDegrees - arReferenceContinuousYawDegrees
        val yawPlausible = abs(yawStep) <= AR_MAX_YAW_SPEED_DPS * dt
        if (AR_POSE_DRIVES_CAMERA && motion.rotationActive && yawPlausible) {
            appliedArYawDeltaDegrees += yawStep
        }
    }

    /** 实际参与合成的 AR 偏航；未启用 AR 时为 0 */
    private val appliedArYawDegrees: Float
        get() = if (AR_POSE_DRIVES_CAMERA) appliedArYawDeltaDegrees else 0f

    /** IMU 确认平移后，再用 AR 速度矢量低通 + 滞回阈值过滤步行中的停顿 */
    private fun updateWalkState(dx: Float, dz: Float, dt: Float, translationActive: Boolean) {
        if (!translationActive) {
            arVelocitySmoothedX = 0f
            arVelocitySmoothedZ = 0f
            arStillSeconds = 0f
            arFollowingWalk = false
            return
        }
        if (dt <= 1e-4f) return

        val alpha = 1f - exp(-AR_SPEED_SMOOTH * dt)
        arVelocitySmoothedX += (dx / dt - arVelocitySmoothedX) * alpha
        arVelocitySmoothedZ += (dz / dt - arVelocitySmoothedZ) * alpha
        val speed = sqrt(
            arVelocitySmoothedX * arVelocitySmoothedX +
                arVelocitySmoothedZ * arVelocitySmoothedZ
        )

        if (arFollowingWalk) {
            if (speed < AR_WALK_EXIT_SPEED_MPS) {
                arStillSeconds += dt
                if (arStillSeconds >= AR_STILL_HOLD_S) arFollowingWalk = false
            } else {
                arStillSeconds = 0f
            }
        } else if (speed > AR_WALK_ENTER_SPEED_MPS) {
            arFollowingWalk = true
            arStillSeconds = 0f
        }
    }

    /** 进入漫游时建立参考位姿（不改变虚拟位姿） */
    fun attachArReference(pose: Mat4, timestampNs: Long = 0L) {
        val rawYaw = extractYawDegrees(pose)
        accumulateYaw(rawYaw)
        rebuildArReference(pose.translation, rawYaw, timestampNs)
    }

    /**
     * 关闭真实走动：把当前 AR 贡献折算进基准位姿，画面完全不跳变。
     */
    fun detachAr() {
        foldCurrentIntoBase(keepPitch = true)
        clearArReference()
    }

    /** 重新居中：保持当前画面不跳变，清零俯仰与累计位移 */
    fun recenter(arPose: Mat4?, timestampNs: Long = 0L) {
        foldCurrentIntoBase(keepPitch = false)
        if (arPose != null) {
            attachArReference(arPose, timestampNs)
        } else {
            clearArReference()
        }
    }

    /** 回到房间起点 */
    fun resetToStart(arPose: Mat4?, timestampNs: Long = 0L) {
        basePosition = startPosition
        baseYawDegrees = startYawDegrees
        moveOffset = Float3(0f, 0f, 0f)
        heightOffset = 0f
        lookYawDegrees = 0f
        lookPitchDegrees = 0f
        smoothedSpeed = 0f
        smoothedVerticalSpeed = 0f
        lastMoveDirection = Float3(0f, 0f, -1f)
        lastVerticalDirection = 1f

        if (arPose != null) {
            attachArReference(arPose, timestampNs)
        } else {
            clearArReference()
        }
    }

    /**
     * 跟踪丢失后恢复 / 屏幕方向变化：AR 可能重定位到新原点。
     * 保持当前虚拟视角，只把参考位姿换成新位姿。
     */
    fun reanchorKeepingView(arPose: Mat4, timestampNs: Long = 0L) {
        foldCurrentIntoBase(keepPitch = true)
        attachArReference(arPose, timestampNs)
    }

    // ---------------- 输入 ----------------

    /**
     * 方向键输入。
     *
     * @param forwardAxis +1 前进，-1 后退
     * @param strafeAxis  +1 右移，-1 左移
     * @param verticalAxis +1 上升，-1 下降，0 保持当前高度
     * @param dt 帧时间（秒，已夹取上限）
     */
    fun applyMoveInput(
        forwardAxis: Float,
        strafeAxis: Float,
        verticalAxis: Float,
        dt: Float
    ) {
        if (dt <= 0f) return
        val forward = forwardAxis.coerceIn(-1f, 1f)
        val strafe = strafeAxis.coerceIn(-1f, 1f)
        val vertical = verticalAxis.coerceIn(-1f, 1f)
        val hasHorizontal = forward != 0f || strafe != 0f
        val hasVertical = vertical != 0f

        if (hasHorizontal) {
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
        if (hasVertical) {
            lastVerticalDirection = if (vertical > 0f) 1f else -1f
        }

        val alpha = 1f - exp(-SPEED_SMOOTH * dt)
        val scale = speedScale.coerceIn(0.1f, 4f)
        val targetSpeed = if (hasHorizontal) MOVE_SPEED_MPS * scale else 0f
        smoothedSpeed += (targetSpeed - smoothedSpeed) * alpha
        val targetVertical = if (hasVertical) VERTICAL_SPEED_MPS * scale else 0f
        smoothedVerticalSpeed += (targetVertical - smoothedVerticalSpeed) * alpha

        if (!hasHorizontal && smoothedSpeed < 0.005f) smoothedSpeed = 0f
        if (!hasVertical && abs(smoothedVerticalSpeed) < 0.005f) smoothedVerticalSpeed = 0f
        if (smoothedSpeed == 0f && smoothedVerticalSpeed == 0f) return

        moveOffset = Float3(
            moveOffset.x + lastMoveDirection.x * smoothedSpeed * dt,
            0f,
            moveOffset.z + lastMoveDirection.z * smoothedSpeed * dt
        )
        heightOffset += lastVerticalDirection * smoothedVerticalSpeed * dt
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
        computePosition()
        return translation(Float3(positionX, positionY, positionZ)) *
            rotation(Float3(0f, 1f, 0f), headingDegrees) *
            rotation(Float3(1f, 0f, 0f), lookPitchDegrees)
    }

    /**
     * 每帧相机位姿写入 [out]（列主序 4x4，Filament/TransformManager 约定）。
     *
     * 等价于 `cameraPose()` 的 `T(pos) · Ry(heading) · Rx(pitch)`，但完全不分配
     * 临时 Mat4/Float3/Float4：热路径每帧都要调用，不能在这里制造 GC 压力。
     */
    fun cameraPoseInto(out: FloatArray) {
        require(out.size >= 16) { "相机位姿缓冲至少需要 16 个 float" }
        computePosition()

        val headingRad = headingDegrees * DEG_TO_RAD
        val pitchRad = lookPitchDegrees * DEG_TO_RAD
        val cosH = cos(headingRad)
        val sinH = sin(headingRad)
        val cosP = cos(pitchRad)
        val sinP = sin(pitchRad)

        // Ry(heading) · Rx(pitch)，按列主序展开
        out[0] = cosH
        out[1] = 0f
        out[2] = -sinH
        out[3] = 0f
        out[4] = sinH * sinP
        out[5] = cosP
        out[6] = cosH * sinP
        out[7] = 0f
        out[8] = sinH * cosP
        out[9] = -sinP
        out[10] = cosH * cosP
        out[11] = 0f
        out[12] = positionX
        out[13] = positionY
        out[14] = positionZ
        out[15] = 1f
    }

    fun initialCameraPose(): Mat4 =
        translation(startPosition) * rotation(Float3(0f, 1f, 0f), startYawDegrees)

    /** 结果写入 [positionX]/[positionY]/[positionZ]；热路径不返回 Float3。 */
    private fun computePosition() {
        if (AR_POSE_DRIVES_CAMERA && hasArReference) {
            rotateYInto(
                arTranslation.x,
                arTranslation.z,
                baseYawDegrees,
                horizontalScratch
            )
        } else {
            horizontalScratch[0] = 0f
            horizontalScratch[1] = 0f
        }
        val arOffsetX = horizontalScratch[0]
        val arOffsetZ = horizontalScratch[1]

        // AR 贡献先单独夹取：真实走动越界时只让 AR 这一侧饱和。
        // 不能把 AR 的越界量折进 moveOffset，否则人走回屋里时虚拟位置会反向漂移
        // （越界 1 m，走回来后反而比起点多退 1 m）。
        val arX = clampToRange(basePosition.x + arOffsetX, insetMinX, insetMaxX)
        val arZ = clampToRange(basePosition.z + arOffsetZ, insetMinZ, insetMaxZ)

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

        // 升降同理：越界量折回 heightOffset，避免持续按键累积“隐形高度”，
        // 松手后再按反方向要先把这段抵消掉才能动。
        val rawY = basePosition.y + heightOffset
        val clampedY = clampToRange(rawY, insetMinY, insetMaxY)
        if (clampedY != rawY) heightOffset += clampedY - rawY

        positionX = clampedX
        positionY = clampedY
        positionZ = clampedZ
    }

    /** 把当前画面位置/朝向写进基准，随后清零按键与滑动偏移 */
    private fun foldCurrentIntoBase(keepPitch: Boolean) {
        computePosition()
        basePosition = Float3(positionX, positionY, positionZ)
        baseYawDegrees = headingDegrees
        moveOffset = Float3(0f, 0f, 0f)
        heightOffset = 0f
        lookYawDegrees = 0f
        if (!keepPitch) lookPitchDegrees = 0f
        smoothedSpeed = 0f
        smoothedVerticalSpeed = 0f
    }

    private fun rebuildArReference(position: Float3, rawYawDegrees: Float, timestampNs: Long) {
        lastArPosition = position
        lastArPoseTimestampNs = timestampNs
        arReferenceRawYawDegrees = rawYawDegrees
        arReferenceContinuousYawDegrees = continuousYawDegrees
        arTranslation = Float3(0f, 0f, 0f)
        arYawDeltaDegrees = 0f
        appliedArYawDeltaDegrees = 0f
        arVelocitySmoothedX = 0f
        arVelocitySmoothedZ = 0f
        arStillSeconds = 0f
        arFollowingWalk = false
        hasArReference = true
    }

    private fun clearArReference() {
        hasArReference = false
        lastArPoseTimestampNs = 0L
        arTranslation = Float3(0f, 0f, 0f)
        arYawDeltaDegrees = 0f
        appliedArYawDeltaDegrees = 0f
        arVelocitySmoothedX = 0f
        arVelocitySmoothedZ = 0f
        arStillSeconds = 0f
        arFollowingWalk = false
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

    /** [rotateY] 的免分配版本：只算水平分量，结果写入 [out]（至少 2 个元素）。 */
    private fun rotateYInto(x: Float, z: Float, degrees: Float, out: FloatArray) {
        val rad = degrees * DEG_TO_RAD
        val cosA = cos(rad)
        val sinA = sin(rad)
        out[0] = x * cosA + z * sinA
        out[1] = -x * sinA + z * cosA
    }

    private fun clampToRange(value: Float, min: Float, max: Float): Float =
        if (max < min) (min + max) * 0.5f else value.coerceIn(min, max)
}
