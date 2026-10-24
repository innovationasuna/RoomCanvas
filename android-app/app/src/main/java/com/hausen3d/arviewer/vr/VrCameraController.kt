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
 * AR 位姿默认**不参与**相机合成（见 [AR_POSE_DRIVES_CAMERA]）：P40 Pro 实测 VIO 会
 * 在静止时平滑发散到几十米，任何速度判据都无法把它与真实走动区分开。`t_ar`/`ψ_ar`
 * 仍然逐帧计算，但只用于日志观测；相机的平移只来自方向键（`p`），偏航只来自滑屏（φ）。
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

        /**
         * AR 位姿是否参与相机合成（位移 + 偏航）。
         *
         * 2026-10-23 真机实测（P40 Pro，站立不动、全程未触屏）：AR Engine 的原始位置在 27 s 内
         * 从 0.2 m **平滑**漂到 70 m，偏航在 1.5 s 内转了 54°，期间跟踪反复丢失/恢复。
         * 这段假运动方向一致、速度 0.3~2 m/s，与真实走动的数学特征完全重合——
         * 速度闸门、窗口位移闸门都无法区分（上一版正是这样失效的）。
         *
         * 偏航同理：54°/s 是持续的慢转，不是可以靠角速度门限剔除的单帧尖峰。
         *
         * 因此默认关闭：漫游完全由方向键 + 右半屏滑屏驱动，AR 位姿只作为观测输入
         * 保留在日志里。只有在目标机型/环境下证明 VIO 质量可靠时才重新打开。
         */
        const val AR_POSE_DRIVES_CAMERA = false

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
    private var arYawDeltaDegrees: Float = 0f

    /** 上一帧 AR 原始位置（AR 世界系），用于求帧间位移 */
    private var lastArPosition: Float3 = Float3(0f, 0f, 0f)

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

    /** 最近一帧被采纳的 AR 水平位移（米）与对应帧时间（秒） */
    private var lastStepX: Float = 0f
    private var lastStepZ: Float = 0f
    private var lastStepDt: Float = 0f

    /** AR 位移累计（参考相机坐标系，米） */
    val debugArTranslation: Float3 get() = arTranslation
    /** 方向键累计位移（房间坐标系，米） */
    val debugMoveOffset: Float3 get() = moveOffset
    /** 基准位姿（房间坐标系，米） */
    val debugBasePosition: Float3 get() = basePosition
    /** AR 贡献的偏航（度） */
    val debugArYawDeltaDegrees: Float get() = arYawDeltaDegrees
    /** 滑动累计偏航（度） */
    val debugLookYawDegrees: Float get() = lookYawDegrees
    /** 低速已持续时间（秒） */
    val debugArStillSeconds: Float get() = arStillSeconds
    /** 最近一帧采纳的 AR 位移 x（米） */
    val debugLastStepX: Float get() = lastStepX
    /** 最近一帧采纳的 AR 位移 z（米） */
    val debugLastStepZ: Float get() = lastStepZ
    /** 最近一帧的帧时间（秒） */
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

    /** 当前虚拟朝向（度），= B_yaw + ψ_ar + φ；AR 关闭时 ψ_ar 不参与 */
    val headingDegrees: Float
        get() = baseYawDegrees + appliedArYawDegrees + lookYawDegrees

    /** AR 位姿是否真的在驱动相机（false = 只观测，画面完全由按键/滑屏决定） */
    val isArPoseApplied: Boolean
        get() = AR_POSE_DRIVES_CAMERA

    /** 当前虚拟位置（已做边界夹取） */
    fun currentPosition(): Float3 = computePosition()

    // ---------------- AR 位姿 ----------------

    /**
     * 每帧（仅跟踪有效时）调用：更新连续偏航、t_ar、ψ_ar。
     *
     * 帧间位移按速度判定是否跟随：判定为走动时累加进 `t_ar`；判定为静止时丢弃，
     * 从而吸收 VIO 在手机静止时的缓慢漂移（否则虚拟相机会自己蹭到墙边）。
     *
     * @param dt 帧时间（秒），用于区分「真实走动」和静止时的 VIO 漂移
     */
    fun updateArPose(pose: Mat4, dt: Float) {
        val rawYaw = extractYawDegrees(pose)
        accumulateYaw(rawYaw)
        val position = pose.translation
        debugRawArX = position.x
        debugRawArZ = position.z
        lastStepDt = dt

        if (!hasArReference) {
            rebuildArReference(position, rawYaw)
            lastStepX = 0f
            lastStepZ = 0f
            return
        }
        arPoseUpdateCount++

        val rawStepX = position.x - lastArPosition.x
        val rawStepZ = position.z - lastArPosition.z
        lastArPosition = position

        // 重定位跳变保护：单帧位移超过物理上限时整帧丢弃（也不喂给速度估计），
        // 否则虚拟相机会跟着瞬移。dt 为 0 时按 120 Hz 保守估算上限。
        val maxStep = AR_MAX_STEP_SPEED_MPS * dt.coerceAtLeast(1f / 120f)
        val plausible = rawStepX * rawStepX + rawStepZ * rawStepZ <= maxStep * maxStep
        val stepX = if (plausible) rawStepX else 0f
        val stepZ = if (plausible) rawStepZ else 0f
        lastStepX = stepX
        lastStepZ = stepZ

        updateWalkState(stepX, stepZ, dt)

        if (AR_POSE_DRIVES_CAMERA && arFollowingWalk) {
            // 真实位移先在参考相机坐标系中表达（只取水平分量），
            // 合成相机时再用 R_y(B_yaw) 映射进房间坐标系。
            val inReferenceFrame = rotateY(Float3(stepX, 0f, stepZ), -arReferenceRawYawDegrees)
            arTranslation = Float3(
                arTranslation.x + inReferenceFrame.x * moveGain,
                0f,
                arTranslation.z + inReferenceFrame.z * moveGain
            )
        }
        // 静止时的位移视为 VIO 漂移，直接丢弃：t_ar 保持不变。
        // AR_POSE_DRIVES_CAMERA = false 时整段位移都不采纳（见常量注释）。

        arYawDeltaDegrees = continuousYawDegrees - arReferenceContinuousYawDegrees
    }

    /** 实际参与合成的 AR 偏航：AR 未启用为 0（ψ_ar 仍保留给日志） */
    private val appliedArYawDegrees: Float
        get() = if (AR_POSE_DRIVES_CAMERA) arYawDeltaDegrees else 0f

    /** 用速度矢量低通 + 滞回阈值判断当前是否在真实走动 */
    private fun updateWalkState(dx: Float, dz: Float, dt: Float) {
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
        heightOffset = 0f
        lookYawDegrees = 0f
        lookPitchDegrees = 0f
        smoothedSpeed = 0f
        smoothedVerticalSpeed = 0f
        lastMoveDirection = Float3(0f, 0f, -1f)
        lastVerticalDirection = 1f

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
        val position = computePosition()
        return translation(position) *
            rotation(Float3(0f, 1f, 0f), headingDegrees) *
            rotation(Float3(1f, 0f, 0f), lookPitchDegrees)
    }

    fun initialCameraPose(): Mat4 =
        translation(startPosition) * rotation(Float3(0f, 1f, 0f), startYawDegrees)

    private fun computePosition(): Float3 {
        val arOffset = if (AR_POSE_DRIVES_CAMERA && hasArReference) {
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

        // 升降同理：越界量折回 heightOffset，避免持续按键累积“隐形高度”，
        // 松手后再按反方向要先把这段抵消掉才能动。
        val rawY = basePosition.y + heightOffset
        val clampedY = clampToRange(rawY, insetMinY, insetMaxY)
        if (clampedY != rawY) heightOffset += clampedY - rawY

        return Float3(clampedX, clampedY, clampedZ)
    }

    /** 把当前画面位置/朝向写进基准，随后清零按键与滑动偏移 */
    private fun foldCurrentIntoBase(keepPitch: Boolean) {
        val position = computePosition()
        basePosition = position
        baseYawDegrees = headingDegrees
        moveOffset = Float3(0f, 0f, 0f)
        heightOffset = 0f
        lookYawDegrees = 0f
        if (!keepPitch) lookPitchDegrees = 0f
        smoothedSpeed = 0f
        smoothedVerticalSpeed = 0f
    }

    private fun rebuildArReference(position: Float3, rawYawDegrees: Float) {
        lastArPosition = position
        arReferenceRawYawDegrees = rawYawDegrees
        arReferenceContinuousYawDegrees = continuousYawDegrees
        arTranslation = Float3(0f, 0f, 0f)
        arYawDeltaDegrees = 0f
        arVelocitySmoothedX = 0f
        arVelocitySmoothedZ = 0f
        arStillSeconds = 0f
        arFollowingWalk = false
        hasArReference = true
    }

    private fun clearArReference() {
        hasArReference = false
        arTranslation = Float3(0f, 0f, 0f)
        arYawDeltaDegrees = 0f
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

    private fun clampToRange(value: Float, min: Float, max: Float): Float =
        if (max < min) (min + max) * 0.5f else value.coerceIn(min, max)
}
