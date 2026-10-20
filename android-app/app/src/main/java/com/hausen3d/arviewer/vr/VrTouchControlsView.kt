package com.hausen3d.arviewer.vr

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PointF
import android.graphics.RectF
import android.util.AttributeSet
import android.util.SparseIntArray
import android.view.MotionEvent
import android.view.View

/**
 * 手持漫游的统一触摸层：单个 View 按 pointer 分配角色，多指互不干扰。
 *
 * - 左下十字键区域：移动；每个手指固定一个方向，多指取并集（前 + 左 = 斜向）。
 * - 右半屏其余区域：视角滑动，`Δx → 偏航`、`Δy → 俯仰`。
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
        private const val DIR_UP = 1
        private const val DIR_DOWN = 2
        private const val DIR_LEFT = 4
        private const val DIR_RIGHT = 8

        private const val DPAD_SIZE_DP = 168f
        private const val DPAD_MARGIN_DP = 20f
    }

    var listener: Listener? = null

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

    // ---------------- 绘制 ----------------

    private val density = resources.displayMetrics.density
    private val dpadSizePx = DPAD_SIZE_DP * density
    private val dpadMarginPx = DPAD_MARGIN_DP * density

    private val dpadRect = RectF()
    private val upRect = RectF()
    private val downRect = RectF()
    private val leftRect = RectF()
    private val rightRect = RectF()

    private val buttonPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(70, 255, 255, 255)
    }
    private val buttonPressedPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(150, 255, 255, 255)
    }
    private val arrowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(230, 255, 255, 255)
        style = Paint.Style.FILL
    }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(110, 255, 255, 255)
        textSize = 12f * density
    }
    private val arrowPath = Path()

    // ---------------- 状态读取 ----------------

    val moveForward: Float
        get() {
            val dirs = activeDirections()
            val up = dirs and DIR_UP != 0
            val down = dirs and DIR_DOWN != 0
            return when {
                up && down -> 0f
                up -> 1f
                down -> -1f
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
            MotionEvent.ACTION_DOWN,
            MotionEvent.ACTION_POINTER_DOWN -> {
                parent?.requestDisallowInterceptTouchEvent(true)
                val index = event.actionIndex
                assignRole(
                    event.getPointerId(index),
                    event.getX(index),
                    event.getY(index)
                )
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
                return true
            }

            MotionEvent.ACTION_POINTER_UP -> {
                removePointer(event.getPointerId(event.actionIndex))
                return true
            }

            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> {
                clearTouches()
                return true
            }
        }
        return true
    }

    private fun assignRole(pointerId: Int, x: Float, y: Float) {
        if (x >= width / 2f) {
            lookPointers[pointerId] = PointF(x, y)
            return
        }
        val direction = dpadDirectionAt(x, y)
        if (direction != 0) {
            movePointers.put(pointerId, direction)
            invalidate()
        }
        // 左半屏但没落在十字键上：吞掉事件，避免误触底层场景
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
    }

    private fun dpadDirectionAt(x: Float, y: Float): Int = when {
        upRect.contains(x, y) -> DIR_UP
        downRect.contains(x, y) -> DIR_DOWN
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
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (dpadRect.isEmpty) return

        drawButton(canvas, upRect, DIR_UP, up = true)
        drawButton(canvas, downRect, DIR_DOWN, up = false)
        drawButton(canvas, leftRect, DIR_LEFT, left = true)
        drawButton(canvas, rightRect, DIR_RIGHT, left = false)

        canvas.drawText(
            "右半屏滑动转向",
            width - 16f * density - hintPaint.measureText("右半屏滑动转向"),
            height - 16f * density,
            hintPaint
        )
    }

    private fun drawButton(
        canvas: Canvas,
        rect: RectF,
        direction: Int,
        up: Boolean? = null,
        left: Boolean? = null
    ) {
        val pressed = activeDirections() and direction != 0
        val radius = 12f * density
        canvas.drawRoundRect(
            rect,
            radius,
            radius,
            if (pressed) buttonPressedPaint else buttonPaint
        )

        // 箭头：用三角表示方向
        val cx = rect.centerX()
        val cy = rect.centerY()
        val s = rect.width() * 0.22f
        arrowPath.reset()
        when {
            up == true -> {
                arrowPath.moveTo(cx, cy - s)
                arrowPath.lineTo(cx - s, cy + s * 0.7f)
                arrowPath.lineTo(cx + s, cy + s * 0.7f)
            }

            up == false -> {
                arrowPath.moveTo(cx, cy + s)
                arrowPath.lineTo(cx - s, cy - s * 0.7f)
                arrowPath.lineTo(cx + s, cy - s * 0.7f)
            }

            left == true -> {
                arrowPath.moveTo(cx - s, cy)
                arrowPath.lineTo(cx + s * 0.7f, cy - s)
                arrowPath.lineTo(cx + s * 0.7f, cy + s)
            }

            else -> {
                arrowPath.moveTo(cx + s, cy)
                arrowPath.lineTo(cx - s * 0.7f, cy - s)
                arrowPath.lineTo(cx - s * 0.7f, cy + s)
            }
        }
        arrowPath.close()
        canvas.drawPath(arrowPath, arrowPaint)
    }
}
