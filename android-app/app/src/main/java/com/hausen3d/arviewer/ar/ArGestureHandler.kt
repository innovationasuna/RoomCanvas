package com.hausen3d.arviewer.ar

import android.content.Context
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import kotlin.math.max
import kotlin.math.min

/**
 * AR 模式手势：
 * - 单指点击 → 命中测试放置/移动模型（[onTap]）
 * - 单指水平拖动 → 绕世界 Y 轴旋转模型（[onRotate]，单位：度）
 * - 双指捏合 → 等比缩放模型（[onScale]，倍率增量）
 *
 * 与查看器模式（SceneView 轨道相机）互斥：进入 AR 模式后由 Activity 把触摸
 * 全部转发给本类，SceneView 自身的相机手势同时被禁用。
 */
class ArGestureHandler(
    context: Context,
    private val onTap: (x: Float, y: Float) -> Unit,
    private val onRotate: (deltaYawDeg: Float) -> Unit,
    private val onScale: (factor: Float) -> Unit
) {

    companion object {
        /** 每像素拖动对应的旋转角度；真机调手感时可改 */
        private const val DEGREES_PER_PX = 0.25f
        const val MIN_SCALE = 0.1f
        const val MAX_SCALE = 10.0f
    }

    /** 累计手势缩放倍率（相对放置时的基准尺寸） */
    var accumulatedScale = 1.0f
        private set

    fun reset() {
        accumulatedScale = 1.0f
    }

    private val gestureDetector = GestureDetector(context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean = true

            override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
                onTap(e.x, e.y)
                return true
            }

            override fun onScroll(
                e1: MotionEvent?,
                e2: MotionEvent,
                distanceX: Float,
                distanceY: Float
            ): Boolean {
                // 双指捏合进行中时不响应旋转，避免两种手势打架
                if (e2.pointerCount == 1 && !scaleDetector.isInProgress) {
                    // 手指向右拖（distanceX 为负）→ 模型向右转
                    onRotate(-distanceX * DEGREES_PER_PX)
                }
                return true
            }
        })

    private val scaleDetector = ScaleGestureDetector(context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val newScale = min(MAX_SCALE, max(MIN_SCALE, accumulatedScale * detector.scaleFactor))
                if (newScale != accumulatedScale) {
                    val factor = newScale / accumulatedScale
                    accumulatedScale = newScale
                    onScale(factor)
                }
                return true
            }
        })

    fun onTouchEvent(event: MotionEvent) {
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
    }
}
