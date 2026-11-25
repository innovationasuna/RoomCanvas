package com.hausen3d.arviewer.rendering

import com.hausen3d.arviewer.vr.VrCameraController

class DebugCameraTrack {
    var forwardAxis = 0f
        private set
    var movementDeltaSeconds = 0f
        private set
    var lookDeltaXPixels = 0f
        private set
    var resetRequested = false
        private set
    var toggleAnimationIndex = -1
        private set

    private var startedAtNanos = 0L
    private var lastAdvanceNanos = 0L
    private var currentLoop = -1
    private var appliedLookDegrees = 0f
    private var firedEvents = 0

    fun start(frameTimeNanos: Long) {
        startedAtNanos = frameTimeNanos
        lastAdvanceNanos = frameTimeNanos
        currentLoop = -1
        appliedLookDegrees = 0f
        firedEvents = 0
        movementDeltaSeconds = 0f
        resetRequested = true
        toggleAnimationIndex = -1
    }

    fun advance(frameTimeNanos: Long) {
        resetRequested = false
        toggleAnimationIndex = -1
        if (startedAtNanos == 0L) start(frameTimeNanos)
        movementDeltaSeconds = ((frameTimeNanos - lastAdvanceNanos).coerceAtLeast(0L)) / 1e9f
        lastAdvanceNanos = frameTimeNanos

        val elapsedSeconds = (frameTimeNanos - startedAtNanos).coerceAtLeast(0L) / 1e9
        val loop = (elapsedSeconds / LOOP_SECONDS).toInt()
        if (loop != currentLoop) {
            currentLoop = loop
            appliedLookDegrees = 0f
            firedEvents = 0
            resetRequested = true
        }
        val t = elapsedSeconds % LOOP_SECONDS
        forwardAxis = if (t < FORWARD_SECONDS) 1f else 0f

        val targetLookDegrees = when {
            t < 10.0 -> 0f
            t < 15.0 -> lerp(0f, 180f, (t - 10.0) / 5.0)
            t < 25.0 -> lerp(180f, -180f, (t - 15.0) / 10.0)
            t < 30.0 -> lerp(-180f, 0f, (t - 25.0) / 5.0)
            else -> 0f
        }
        lookDeltaXPixels = -(targetLookDegrees - appliedLookDegrees) /
            VrCameraController.LOOK_DEG_PER_PX
        appliedLookDegrees = targetLookDegrees

        for (eventPosition in TOGGLE_EVENTS.indices) {
            val event = TOGGLE_EVENTS[eventPosition]
            val bit = 1 shl eventPosition
            if (t >= event.timeSeconds && firedEvents and bit == 0) {
                firedEvents = firedEvents or bit
                toggleAnimationIndex = event.index
                break
            }
        }
    }

    private fun lerp(start: Float, end: Float, progress: Double): Float =
        start + ((end - start) * progress).toFloat()

    private data class ToggleEvent(val timeSeconds: Double, val index: Int)

    companion object {
        const val LOOP_SECONDS = 40.0
        const val FORWARD_SECONDS = 10.0

        private val TOGGLE_EVENTS = arrayOf(
            ToggleEvent(30.0, 0),
            ToggleEvent(32.0, 1),
            ToggleEvent(34.0, 0),
            ToggleEvent(36.0, 1)
        )
    }
}
