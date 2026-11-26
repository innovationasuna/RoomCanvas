package com.hausen3d.arviewer.vr

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.google.android.filament.View
import io.github.sceneview.SceneView
import io.github.sceneview.node.ModelNode
import kotlin.math.max
import kotlin.math.min

/**
 * 柜门 / 窗扇 / 推拉门等可活动部件的开关控制。
 *
 * 对应网页 `room_ops/walk/app.js` 里的 ARTIC：
 * - 每条 glTF 动画只驱动一个节点，加载时全部采样到 t=0（关闭状态），不自动播放、不循环；
 * - 点击时用 Filament `View.pick` 做精确拾取，沿变换父链找到被驱动的节点，翻转它的开/关；
 * - 每帧按 smoothstep 把 phase 从 0 推到 1（或反向），再写入 `Animator.applyAnimation`。
 *
 * 房间重建导出的 clip 多是**往返片段**（首帧=末帧=关、中点=开到底），
 * 整段扫完会“开了又关回去”。[openTimes] 给出每条 clip 的中点时间，
 * 这里只扫 0 → 中点，于是「点一下开着、再点一下才关」。
 *
 * 所有方法都必须在主线程调用：点击来自 View，帧驱动来自 [SceneView.onFrame]，
 * 拾取回调通过主线程 Handler 投递。
 */
class ArticulationController(
    private val sceneView: SceneView,
    private val modelNode: ModelNode,
    animationTargets: Map<Int, List<String>> = emptyMap(),
    openTimes: Map<Int, Float> = emptyMap(),
    private val onToggled: ((label: String, open: Boolean) -> Unit)? = null
) {

    /** 一条 glTF 动画对应的开关状态。 */
    private class Entry(
        val animationIndex: Int,
        val duration: Float,
        /** 扫到“开到底”的 clip 时间：往返片段取中点，单向片段取整段时长 */
        val openTime: Float,
        val targetNames: Set<String>,
        val label: String
    ) {
        var phase = 0f
        var target = 0f
        var moving = false
        var open = false
    }

    companion object {
        private const val TAG = "Articulation"

        /** 父链回溯的保险上限 */
        private const val MAX_ANCESTOR_DEPTH = 64

        /** 连续点击去抖 */
        private const val TOGGLE_DEBOUNCE_MS = 250L

        /** 拾取回调迟迟不来时清掉 in-flight 状态 */
        private const val PICK_TIMEOUT_MS = 1_500L

        /** 动画名后缀：Door_Leaf_swing / Drawer_L_slide / Window_open … */
        private val ANIMATION_SUFFIX =
            Regex("_(swing|slide|open|move|lift|rotate)$", RegexOption.IGNORE_CASE)
    }

    private val animator = modelNode.animator
    private val asset = modelNode.modelInstance.asset
    private val transformManager = sceneView.engine.transformManager
    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * EntityInstance → Entity：TransformManager 没有 getEntity(instance)，只能反查。
     *
     * 只在点击拾取时用，且对每个 entity 都要一次 JNI；无动画模型（很常见）不应
     * 为了它扫描全模型。本类所有方法都在主线程调用，故用 NONE 模式免同步开销。
     */
    private val entityByTransformInstance: Map<Int, Int> by lazy(LazyThreadSafetyMode.NONE) {
        modelNode.modelInstance.entities.toList().mapNotNull { entity ->
            val instance = transformManager.getInstance(entity)
            if (instance == 0) null else instance to entity
        }.toMap()
    }

    /** 模型里真实存在的节点名，用来校验动画目标；只在真有动画时由 buildEntries 触发构建 */
    private val nodeNames: Set<String> by lazy(LazyThreadSafetyMode.NONE) {
        buildSet {
            modelNode.nodes.forEach { node -> node.name?.takeIf { it.isNotBlank() }?.let(::add) }
            modelNode.modelInstance.entities.forEach { entity ->
                asset.getName(entity)?.takeIf { it.isNotBlank() }?.let(::add)
            }
        }
    }

    private val entries: List<Entry> = buildEntries(animationTargets, openTimes)

    /** 模型是否包含任何动画；为 false 时 [toggleAt] 直接返回 false。 */
    val hasAnimations: Boolean get() = entries.isNotEmpty()

    private var released = false
    private var pickGeneration = 0
    private var pickInFlight = false
    private var lastToggleAt = 0L

    private fun buildEntries(
        targets: Map<Int, List<String>>,
        openTimes: Map<Int, Float>
    ): List<Entry> {
        val count = animator.animationCount
        if (count == 0) return emptyList()

        val list = (0 until count).map { index ->
            val parsed = targets[index].orEmpty().filter { it in nodeNames }.toSet()
            val resolved = parsed.ifEmpty { resolveFromAnimationName(index) }
            val duration = animator.getAnimationDuration(index).takeIf { it > 0f } ?: 1f
            Entry(
                animationIndex = index,
                duration = duration,
                // 越界的中点时间（脏数据）一律按整段处理，宁可多扫也不要停在半开
                openTime = openTimes[index]?.takeIf { it in 0.05f..duration } ?: duration,
                targetNames = resolved,
                label = labelFor(index, resolved)
            )
        }

        // 与网页 action.time = 0 等价：全部停在关闭帧
        for (index in 0 until count) animator.applyAnimation(index, 0f)
        animator.updateBoneMatrices()
        Log.i(
            TAG,
            "动画 ${list.size} 条，可点击 ${list.count { it.targetNames.isNotEmpty() }} 条，" +
                "往返片段 ${list.count { it.openTime < it.duration }} 条"
        )
        return list
    }

    /** 兜底：动画名去掉 swing/slide 等后缀，与真实节点名比对 */
    private fun resolveFromAnimationName(index: Int): Set<String> {
        val raw = animator.getAnimationName(index)?.takeIf { it.isNotBlank() } ?: return emptySet()
        val stripped = raw.replace(ANIMATION_SUFFIX, "")
        return when {
            stripped in nodeNames -> setOf(stripped)
            raw in nodeNames -> setOf(raw)
            else -> nodeNames.filter { it.equals(stripped, ignoreCase = true) }.toSet()
        }
    }

    private fun labelFor(index: Int, targets: Set<String>): String {
        val raw = animator.getAnimationName(index)?.takeIf { it.isNotBlank() }
            ?: targets.firstOrNull()
            ?: "动画 ${index + 1}"
        return raw.replace(ANIMATION_SUFFIX, "").replace('_', ' ')
    }

    /** 每帧推进所有正在移动的部件。 */
    fun step(dtSeconds: Float) {
        if (released || entries.isEmpty() || dtSeconds <= 0f) return

        var changed = false
        for (entry in entries) {
            if (!entry.moving) continue
            // 网页用 0.7–1.6 秒；手机端放宽到 0.7–2 秒，开合更从容（真机试调）。
            // 时长按 openTime 算：往返片段只走中点，开合各占 clip 的一半。
            val rate = 1f / entry.openTime.coerceIn(0.7f, 2f)
            entry.phase = if (entry.phase < entry.target) {
                min(entry.target, entry.phase + rate * dtSeconds)
            } else {
                max(entry.target, entry.phase - rate * dtSeconds)
            }
            val k = entry.phase * entry.phase * (3f - 2f * entry.phase)   // smoothstep
            animator.applyAnimation(entry.animationIndex, k * entry.openTime)
            if (entry.phase == entry.target) entry.moving = false
            changed = true
        }

        // SceneView 在本回调之前已刷新过骨骼矩阵，蒙皮模型需要补一次
        if (changed && modelNode.skinCount > 0) animator.updateBoneMatrices()
    }

    /**
     * 在屏幕坐标处拾取并切换命中的可活动部件。
     *
     * @return false = 控制器无法处理（已释放 / 模型没有动画），调用方可回退到原有行为；
     *         true  = 已发起拾取，或因拾取进行中/去抖而有意忽略本次点击。
     * @param onResult 主线程回调：拾取命中并切换为 true，未命中为 false。
     */
    fun toggleAt(
        screenX: Float,
        screenY: Float,
        onResult: ((Boolean) -> Unit)? = null
    ): Boolean {
        if (released || entries.isEmpty()) return false

        val now = SystemClock.elapsedRealtime()
        if (pickInFlight || now - lastToggleAt < TOGGLE_DEBOUNCE_MS) return true

        pickInFlight = true
        lastToggleAt = now
        val generation = ++pickGeneration
        mainHandler.postDelayed({
            if (generation == pickGeneration && pickInFlight) pickInFlight = false
        }, PICK_TIMEOUT_MS)

        sceneView.view.pick(
            screenX.toInt(),
            screenY.toInt(),
            mainHandler,
            View.OnPickCallback { result ->
                if (released || generation != pickGeneration) return@OnPickCallback
                pickInFlight = false
                val entity = result.renderable
                val toggled = entity != 0 && toggleFromPickedEntity(entity)
                onResult?.invoke(toggled)
            }
        )
        return true
    }

    /** 拾取到的可能是把手/玻璃等子节点，必须一路向上找到被动画驱动的那个节点。 */
    private fun toggleFromPickedEntity(startEntity: Int): Boolean {
        var entity = startEntity
        repeat(MAX_ANCESTOR_DEPTH) {
            val name = entityName(entity)
            if (name != null && toggleEntries(name)) return true

            val instance = transformManager.getInstance(entity)
            if (instance == 0) return false
            val parentInstance = transformManager.getParent(instance)
            if (parentInstance == 0) return false
            entity = entityByTransformInstance[parentInstance] ?: return false
        }
        return false
    }

    private fun entityName(entity: Int): String? =
        runCatching { asset.getName(entity) }.getOrNull()?.takeIf { it.isNotBlank() }

    private fun toggleEntries(name: String): Boolean {
        val matches = entries.filter { name in it.targetNames }
        if (matches.isEmpty()) return false

        val open = !matches.first().open
        matches.forEach { setOpen(it, open) }
        onToggled?.invoke(matches.first().label, open)
        return true
    }

    internal fun toggleAnimationForDebug(index: Int): Boolean {
        if (released) return false
        val entry = entries.getOrNull(index) ?: return false
        val open = !entry.open
        setOpen(entry, open)
        onToggled?.invoke(entry.label, open)
        return true
    }

    private fun setOpen(entry: Entry, open: Boolean) {
        entry.open = open
        entry.target = if (open) 1f else 0f
        entry.moving = true
    }

    /** 必须在销毁 FilamentAsset 之前调用；之后不再触碰任何 Filament 对象。 */
    fun release() {
        if (released) return
        released = true
        pickGeneration++
        pickInFlight = false
        mainHandler.removeCallbacksAndMessages(null)
    }
}
