package com.hausen3d.arviewer.vr

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.os.SystemClock
import android.util.AttributeSet
import android.util.SparseIntArray
import android.view.MotionEvent
import android.view.View

/**
 * 手持漫游的统一触摸层：单个 View 按 pointer 分配角色，多指互不干扰。
 *
 * - 左下方向键：水平移动；每个手指固定一个方向，多指取并集（前 + 左 = 斜向）。
 * - 方向键正上方的「升 / 降」：垂直移动。放在左手集群里，右半屏保持纯转向。
 * - 右半屏其余区域：视角滑动，`Δx → 偏航`、`Δy → 俯仰`。
 * - 右半屏轻点（≤ 6dp、≤ 500ms）：开关柜门/窗扇，见 [onTap]。
 *
 * 之所以不用“四个按钮各自 setOnTouchListener + 全屏手势检测”，是因为
 * Android 在第二个手指按下时会把事件派发给 DOWN 时的同一个 View，
 * 各按钮的监听器拿不到彼此的状态，无法保证“按住前进的同时另一根手指转向”。
 */
class VrTouchControlsView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    fun interface Listener {
        /** 右半屏滑动增量（像素，屏幕坐标） */
        fun onLookDelta(dx: Float, dy: Float)
    }

    companion object {
        private const val DIR_FORWARD = 1
        private const val DIR_BACK = 2
        private const val DIR_LEFT = 4
        private const val DIR_RIGHT = 8
        private const val DIR_ASCEND = 16
        private const val DIR_DESCEND = 32

        private const val DPAD_SIZE_DP = 156f
        private const val DPAD_MARGIN_DP = 22f

        /** 升降键：竖排两枚，位于方向键正上方 */
        private const val ROCKER_WIDTH_DP = 76f
        private const val ROCKER_HEIGHT_DP = 104f
        private const val ROCKER_GAP_DP = 10f
        private const val ROCKER_INNER_DP = 4f

        /** 轻点判定：位移与时长上限，和网页 walk/app.js 一致 */
        private const val TAP_SLOP_DP = 6f
        private const val TAP_TIMEOUT_MS = 500L
    }

    var listener: Listener? = null

    /**
     * 右半屏“轻点”回调（屏幕坐标）。
     *
     * 与 [listener] 的滑动互不排斥：同一根手指按下到抬起位移 ≤ 6dp、
     * 时长 ≤ 500ms 才触发；转向区出现第二根手指则取消。左手按方向键时，
     * 右手仍可轻点开关柜门/窗扇。
     */
    var onTap: ((x: Float, y: Float) -> Unit)? = null

    /** 菜单展开等场景下屏蔽输入；置 false 时清空所有按压状态 */
    var inputEnabled: Boolean = true
        set(value) {
            if (field == value) return
            field = value
            if (!value) clearTouches()
        }

    /** pointerId → 方向位掩码（按下时确定，滑出按钮也保持不变） */
    private val movePointers = SparseIntArray()

    /** pointerId → 上一次位置；只保存右半屏的转向手指 */
    private val lookPointers = HashMap<Int, PointF>()

    // ---------------- 轻点状态 ----------------

    private val tapSlopPx get() = TAP_SLOP_DP * density
    private var tapTracking = false
    private var tapCancelled = false
    private var tapPointerId = -1
    private var tapDownX = 0f
    private var tapDownY = 0f
    private var tapDownAtMs = 0L

    // ---------------- 绘制与命中区域 ----------------

    private val density = resources.displayMetrics.density
    private val dpadSizePx = DPAD_SIZE_DP * density
    private val dpadMarginPx = DPAD_MARGIN_DP * density
    private val rockerWidthPx = ROCKER_WIDTH_DP * density
    private val rockerHeightPx = ROCKER_HEIGHT_DP * density
    private val rockerGapPx = ROCKER_GAP_DP * density
    private val rockerInnerPx = ROCKER_INNER_DP * density

    private val dpadRect = RectF()
    private val upRect = RectF()
    private val downRect = RectF()
    private val leftRect = RectF()
    private val rightRect = RectF()

    private val rockerBounds = RectF()
    private val ascendRect = RectF()
    private val descendRect = RectF()

    // 房间模型常是大面积白墙/白天花板，纯白半透明控件会直接“消失”。
    // 统一改成深色玻璃底 + 白色描边，深色/浅色场景下都能看清。
    private val platePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(72, 6, 14, 20)
        style = Paint.Style.FILL
    }
    private val plateStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(64, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val buttonPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(104, 10, 22, 30)
        style = Paint.Style.FILL
    }
    private val buttonStrokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(110, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 1f * density
    }
    private val buttonPressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(235, 53, 200, 220)
        style = Paint.Style.FILL
    }
    private val arrowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(235, 255, 255, 255)
        style = Paint.Style.STROKE
        strokeWidth = 2.6f * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val arrowPressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(4, 20, 26)
        style = Paint.Style.STROKE
        strokeWidth = 2.6f * density
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val rockerLabelPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(235, 255, 255, 255)
        textSize = 11f * density
        textAlign = Paint.Align.CENTER
    }
    private val rockerLabelPressedPaint = Paint(rockerLabelPaint).apply {
        color = Color.rgb(4, 20, 26)
    }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 255, 255, 255)
        textSize = 11f * density
    }
    private val chevronPath = Path()

    // ---------------- 状态读取 ----------------

    val moveForward: Float
        get() {
            val dirs = activeDirections()
            val forward = dirs and DIR_FORWARD != 0
            val back = dirs and DIR_BACK != 0
            return when {
                forward && back -> 0f
                forward -> 1f
                back -> -1f
                else -> 0f
            }
        }

    val moveStrafe: Float
        get() {
            val dirs = activeDirections()
            val left = dirs and DIR_LEFT != 0
            val right = dirs and DIR_RIGHT != 0
            return when {
                left && right -> 0f
                right -> 1f
                left -> -1f
                else -> 0f
            }
        }

    /** +1 上升，-1 下降，0 保持高度 */
    val moveVertical: Float
        get() {
            val dirs = activeDirections()
            val ascend = dirs and DIR_ASCEND != 0
            val descend = dirs and DIR_DESCEND != 0
            return when {
                ascend && descend -> 0f
                ascend -> 1f
                descend -> -1f
                else -> 0f
            }
        }

    private fun activeDirections(): Int {
        var mask = 0
        for (i in 0 until movePointers.size()) {
            mask = mask or movePointers.valueAt(i)
        }
        return mask
    }

    // ---------------- 触摸 ----------------

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!inputEnabled) return false

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val index = event.actionIndex
                val id = event.getPointerId(index)
                val x = event.getX(index)
                val y = event.getY(index)
                assignRole(id, x, y)
                beginTapTracking(id, x, y)
                return true
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val index = event.actionIndex
                val id = event.getPointerId(index)
                val x = event.getX(index)
                val y = event.getY(index)
                if (tapTracking) {
                    // 转向区再落一根手指是双指手势，不算轻点
                    tapCancelled = true
                } else {
                    // 左手按方向键时，右手仍可轻点开关柜门
                    beginTapTracking(id, x, y)
                }
                assignRole(id, x, y)
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    val id = event.getPointerId(i)
                    val last = lookPointers[id] ?: continue
                    val x = event.getX(i)
                    val y = event.getY(i)
                    val dx = x - last.x
                    val dy = y - last.y
                    if (dx != 0f || dy != 0f) {
                        last.set(x, y)
                        listener?.onLookDelta(dx, dy)
                    }
                }
                if (tapTracking && !tapCancelled) {
                    val index = event.findPointerIndex(tapPointerId)
                    if (index >= 0) {
                        val dx = event.getX(index) - tapDownX
                        val dy = event.getY(index) - tapDownY
                        if (dx * dx + dy * dy > tapSlopPx * tapSlopPx) tapCancelled = true
                    }
                }
                return true
            }

            MotionEvent.ACTION_POINTER_UP -> {
                val id = event.getPointerId(event.actionIndex)
                if (id == tapPointerId) {
                    // 另一只手还按着方向键时，抬手走的是 POINTER_UP 而不是 UP，
                    // 必须在这里完成轻点，否则“边走边点”永远不触发。
                    completeTapIfValid(event)
                    resetTap()
                }
                removePointer(id)
                return true
            }

            MotionEvent.ACTION_UP -> {
                completeTapIfValid(event)
                clearTouches()
                return true
            }

            MotionEvent.ACTION_CANCEL -> {
                clearTouches()
                return true
            }
        }
        return true
    }

    /** 只把右半屏（转向区）的按下作为轻点候选；左半屏是方向键。 */
    private fun beginTapTracking(pointerId: Int, x: Float, y: Float) {
        if (x < width / 2f) {
            resetTap()
            return
        }
        tapTracking = true
        tapCancelled = false
        tapPointerId = pointerId
        tapDownX = x
        tapDownY = y
        tapDownAtMs = SystemClock.elapsedRealtime()
    }

    /** 抬手点符合“位移 ≤ 6dp、时长 ≤ 500ms”才回调；POINTER_UP 与 UP 共用。 */
    private fun completeTapIfValid(event: MotionEvent) {
        if (!tapTracking || tapCancelled) return
        val index = event.findPointerIndex(tapPointerId)
        if (index < 0) return
        val x = event.getX(index)
        val y = event.getY(index)
        val dx = x - tapDownX
        val dy = y - tapDownY
        val inTime = SystemClock.elapsedRealtime() - tapDownAtMs <= TAP_TIMEOUT_MS
        if (inTime && dx * dx + dy * dy <= tapSlopPx * tapSlopPx) {
            onTap?.invoke(x, y)
        }
    }

    private fun resetTap() {
        tapTracking = false
        tapCancelled = false
        tapPointerId = -1
    }

    private fun assignRole(pointerId: Int, x: Float, y: Float) {
        if (x >= width / 2f) {
            lookPointers[pointerId] = PointF(x, y)
            return
        }
        val direction = directionAt(x, y)
        if (direction != 0) {
            movePointers.put(pointerId, direction)
            invalidate()
        }
        // 左半屏但没落在按键上：吞掉事件，避免误触底层场景
    }

    private fun removePointer(pointerId: Int) {
        if (movePointers.indexOfKey(pointerId) >= 0) {
            movePointers.delete(pointerId)
            invalidate()
        }
        lookPointers.remove(pointerId)
    }

    fun clearTouches() {
        if (movePointers.size() > 0 || lookPointers.isNotEmpty()) {
            movePointers.clear()
            lookPointers.clear()
            invalidate()
        }
        resetTap()
    }

    /** 升降键优先于方向键：两者在竖直方向上有 10dp 间隔，不会重叠。 */
    private fun directionAt(x: Float, y: Float): Int = when {
        ascendRect.contains(x, y) -> DIR_ASCEND
        descendRect.contains(x, y) -> DIR_DESCEND
        upRect.contains(x, y) -> DIR_FORWARD
        downRect.contains(x, y) -> DIR_BACK
        leftRect.contains(x, y) -> DIR_LEFT
        rightRect.contains(x, y) -> DIR_RIGHT
        else -> 0
    }

    // ---------------- 布局与绘制 ----------------

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val left = dpadMarginPx
        val bottom = h - dpadMarginPx
        val top = bottom - dpadSizePx
        dpadRect.set(left, top, left + dpadSizePx, bottom)

        val cell = dpadSizePx / 3f
        upRect.set(left + cell, top, left + 2f * cell, top + cell)
        leftRect.set(left, top + cell, left + cell, top + 2f * cell)
        rightRect.set(left + 2f * cell, top + cell, left + 3f * cell, top + 2f * cell)
        downRect.set(left + cell, top + 2f * cell, left + 2f * cell, top + 3f * cell)

        // 升降键：与方向键同一条左侧基准线，位于其正上方
        val rockerBottom = top - rockerGapPx
        val rockerTop = rockerBottom - rockerHeightPx
        rockerBounds.set(left, rockerTop, left + rockerWidthPx, rockerBottom)

        val mid = rockerTop + rockerHeightPx / 2f
        ascendRect.set(
            left + rockerInnerPx,
            rockerTop + rockerInnerPx,
            left + rockerWidthPx - rockerInnerPx,
            mid - rockerInnerPx / 2f
        )
        descendRect.set(
            left + rockerInnerPx,
            mid + rockerInnerPx / 2f,
            left + rockerWidthPx - rockerInnerPx,
            rockerBottom - rockerInnerPx
        )
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (dpadRect.isEmpty) return

        // 方向键底板 + 四枚圆形按键
        val plateRadius = 26f * density
        canvas.drawRoundRect(dpadRect, plateRadius, plateRadius, platePaint)
        canvas.drawRoundRect(dpadRect, plateRadius, plateRadius, plateStrokePaint)

        val cell = dpadSizePx / 3f
        val radius = cell * 0.44f
        drawDirectionButton(canvas, upRect, DIR_FORWARD, 0f, radius)
        drawDirectionButton(canvas, leftRect, DIR_LEFT, -90f, radius)
        drawDirectionButton(canvas, downRect, DIR_BACK, 180f, radius)
        drawDirectionButton(canvas, rightRect, DIR_RIGHT, 90f, radius)

        // 中心点：让十字看起来是一个整体
        canvas.drawCircle(
            dpadRect.centerX(),
            dpadRect.centerY(),
            2.5f * density,
            hintPaint
        )

        drawRocker(canvas)

        val hint = "拖动右侧转向"
        canvas.drawText(
            hint,
            width - 22f * density - hintPaint.measureText(hint),
            height - 16f * density,
            hintPaint
        )
    }

    /** 以圆形按键中心为原点旋转，同一段折线即可表示四个方向。 */
    private fun drawDirectionButton(
        canvas: Canvas,
        rect: RectF,
        direction: Int,
        angleDegrees: Float,
        radius: Float
    ) {
        val pressed = activeDirections() and direction != 0
        val cx = rect.centerX()
        val cy = rect.centerY()

        canvas.drawCircle(cx, cy, radius, if (pressed) buttonPressedPaint else buttonPaint)
        canvas.drawCircle(cx, cy, radius, buttonStrokePaint)

        chevronPath.reset()
        val s = radius * 0.42f
        chevronPath.moveTo(cx - s, cy + s * 0.55f)
        chevronPath.lineTo(cx, cy - s * 0.62f)
        chevronPath.lineTo(cx + s, cy + s * 0.55f)

        canvas.save()
        canvas.rotate(angleDegrees, cx, cy)
        canvas.drawPath(chevronPath, if (pressed) arrowPressedPaint else arrowPaint)
        canvas.restore()
    }

    private fun drawRocker(canvas: Canvas) {
        val radius = 22f * density
        canvas.drawRoundRect(rockerBounds, radius, radius, platePaint)
        canvas.drawRoundRect(rockerBounds, radius, radius, plateStrokePaint)

        drawRockerHalf(canvas, ascendRect, DIR_ASCEND, "升", up = true)
        drawRockerHalf(canvas, descendRect, DIR_DESCEND, "降", up = false)
    }

    private fun drawRockerHalf(
        canvas: Canvas,
        rect: RectF,
        direction: Int,
        label: String,
        up: Boolean
    ) {
        val pressed = activeDirections() and direction != 0
        val halfRadius = 17f * density
        canvas.drawRoundRect(
            rect,
            halfRadius,
            halfRadius,
            if (pressed) buttonPressedPaint else buttonPaint
        )
        canvas.drawRoundRect(rect, halfRadius, halfRadius, buttonStrokePaint)

        val cx = rect.centerX()
        val cy = rect.centerY()
        val s = 4.5f * density

        chevronPath.reset()
        if (up) {
            chevronPath.moveTo(cx - s, cy - 5f * density + s * 0.55f)
            chevronPath.lineTo(cx, cy - 5f * density - s * 0.62f)
            chevronPath.lineTo(cx + s, cy - 5f * density + s * 0.55f)
        } else {
            chevronPath.moveTo(cx - s, cy - 5f * density - s * 0.55f)
            chevronPath.lineTo(cx, cy - 5f * density + s * 0.62f)
            chevronPath.lineTo(cx + s, cy - 5f * density - s * 0.55f)
        }
        canvas.drawPath(chevronPath, if (pressed) arrowPressedPaint else arrowPaint)

        canvas.drawText(
            label,
            cx,
            cy + 13f * density,
            if (pressed) rockerLabelPressedPaint else rockerLabelPaint
        )
    }
}
