package com.hausen3d.arviewer.rendering

import android.content.Context
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.google.android.filament.View
import com.hausen3d.arviewer.ar.ArPoseRenderer
import java.util.Locale

class RenderPerfMonitor(
    context: Context,
    private val filamentView: View,
    private val qualitySummary: () -> String,
    private val poseRenderer: () -> ArPoseRenderer
) {
    private enum class RunState { IDLE, WARMUP, SAMPLING }

    private class CpuTotals {
        var callbackNanos = 0L
        var inputNanos = 0L
        var arControllerNanos = 0L
        var animationNanos = 0L
        var cameraNanos = 0L
        var frames = 0L

        fun add(callback: Long, input: Long, ar: Long, animation: Long, camera: Long) {
            callbackNanos += callback
            inputNanos += input
            arControllerNanos += ar
            animationNanos += animation
            cameraNanos += camera
            frames++
        }

        fun clear() {
            callbackNanos = 0L
            inputNanos = 0L
            arControllerNanos = 0L
            animationNanos = 0L
            cameraNanos = 0L
            frames = 0L
        }
    }

    private val appContext = context.applicationContext
    private val powerManager = appContext.getSystemService(PowerManager::class.java)
    private val memoryInfo = Debug.MemoryInfo()
    private val dynamicResolutionScale = FloatArray(2)
    private val windowFrames = FrameTimeRingBuffer(512)
    private val sampleFrames = FrameTimeRingBuffer(16_384)
    private val windowCpu = CpuTotals()
    private val sampleCpu = CpuTotals()

    private var lastFrameTimeNanos = 0L
    private var lastWindowLogMs = 0L
    private var experiment = "A0"
    private var runState = RunState.IDLE
    private var warmupStartedAtNanos = 0L
    private var sampleStartedAtNanos = 0L
    private var sampleDurationSeconds = 60
    private var warmupDurationSeconds = 20
    private var sampleFrameCount = 0L
    private var sampleStartPoseCount = 0
    private var sampleStartArFrameCount = 0
    private var sampleStartArUpdateCount = 0
    private var sampleStartArUpdateNanos = 0L
    private var latestPssKb = 0
    private var latestGcCount = "unknown"
    private var latestGcTimeMs = "unknown"

    val isRunActive: Boolean get() = runState != RunState.IDLE

    fun setExperiment(label: String) {
        experiment = label
    }

    fun resetFrameClock() {
        lastFrameTimeNanos = 0L
        windowFrames.clear()
    }

    fun startRun(label: String, warmupSeconds: Int = 20, sampleSeconds: Int = 60) {
        if (runState != RunState.IDLE) {
            Log.i(TAG, "RUN_CANCEL experiment=$experiment reason=restart")
        }
        experiment = label
        warmupDurationSeconds = warmupSeconds
        sampleDurationSeconds = sampleSeconds
        warmupStartedAtNanos = 0L
        sampleStartedAtNanos = 0L
        runState = RunState.WARMUP
        Log.i(
            TAG,
            "RUN_BEGIN experiment=$experiment warmupSeconds=$warmupSeconds " +
                "sampleSeconds=$sampleSeconds ${qualitySummary()}"
        )
    }

    fun cancelRun() {
        if (runState != RunState.IDLE) Log.i(TAG, "RUN_CANCEL experiment=$experiment")
        runState = RunState.IDLE
        warmupStartedAtNanos = 0L
        sampleStartedAtNanos = 0L
    }

    fun recordFrame(
        frameTimeNanos: Long,
        callbackCpuNanos: Long,
        inputCpuNanos: Long,
        arControllerCpuNanos: Long,
        animationCpuNanos: Long,
        cameraCpuNanos: Long
    ) {
        if (runState == RunState.WARMUP) {
            if (warmupStartedAtNanos == 0L) warmupStartedAtNanos = frameTimeNanos
            if (frameTimeNanos - warmupStartedAtNanos >= warmupDurationSeconds * 1_000_000_000L) {
                beginSample(frameTimeNanos)
            }
        }

        if (lastFrameTimeNanos > 0L && frameTimeNanos > lastFrameTimeNanos) {
            val interval = frameTimeNanos - lastFrameTimeNanos
            windowFrames.add(interval)
            if (runState == RunState.SAMPLING) sampleFrames.add(interval)
        }
        lastFrameTimeNanos = frameTimeNanos
        windowCpu.add(
            callbackCpuNanos,
            inputCpuNanos,
            arControllerCpuNanos,
            animationCpuNanos,
            cameraCpuNanos
        )
        if (runState == RunState.SAMPLING) {
            sampleCpu.add(
                callbackCpuNanos,
                inputCpuNanos,
                arControllerCpuNanos,
                animationCpuNanos,
                cameraCpuNanos
            )
            sampleFrameCount++
        }

        logWindowIfNeeded()
        if (runState == RunState.SAMPLING &&
            frameTimeNanos - sampleStartedAtNanos >= sampleDurationSeconds * 1_000_000_000L
        ) {
            finishSample(frameTimeNanos)
        }
    }

    private fun beginSample(frameTimeNanos: Long) {
        sampleStartedAtNanos = frameTimeNanos
        sampleFrames.clear()
        sampleCpu.clear()
        sampleFrameCount = 0L
        val renderer = poseRenderer()
        sampleStartPoseCount = renderer.poseCounter.get()
        sampleStartArFrameCount = renderer.frameCounter.get()
        sampleStartArUpdateCount = renderer.sessionUpdateCount.get()
        sampleStartArUpdateNanos = renderer.sessionUpdateNanos.get()
        runState = RunState.SAMPLING
        Log.i(TAG, "SAMPLE_BEGIN experiment=$experiment")
    }

    private fun finishSample(frameTimeNanos: Long) {
        val stats = sampleFrames.statistics()
        val durationSeconds = (frameTimeNanos - sampleStartedAtNanos) / 1_000_000_000.0
        val averageFps = if (durationSeconds > 0.0) sampleFrameCount / durationSeconds else 0.0
        val medianFps = if (stats.p50Ms > 0.0) 1000.0 / stats.p50Ms else 0.0
        val renderer = poseRenderer()
        val poseFrames = renderer.poseCounter.get() - sampleStartPoseCount
        val arFrames = renderer.frameCounter.get() - sampleStartArFrameCount
        val arUpdates = renderer.sessionUpdateCount.get() - sampleStartArUpdateCount
        val arUpdateNanos = renderer.sessionUpdateNanos.get() - sampleStartArUpdateNanos
        val arUpdateAverageMs = if (arUpdates > 0) {
            arUpdateNanos / arUpdates.toDouble() / 1_000_000.0
        } else {
            0.0
        }
        filamentView.getLastDynamicResolutionScale(dynamicResolutionScale)
        Log.i(
            TAG,
            "SUMMARY experiment=$experiment frames=$sampleFrameCount " +
                "averageFps=${averageFps.number()} medianFps=${medianFps.number()} " +
                "p50Ms=${stats.p50Ms.number()} p95Ms=${stats.p95Ms.number()} " +
                "p99Ms=${stats.p99Ms.number()} over50Percent=${stats.over50Percent.number()} " +
                "over100Percent=${stats.over100Percent.number()} " +
                cpuSummary(sampleCpu) +
                " arPoseFrames=$poseFrames arGlFrames=$arFrames arUpdates=$arUpdates " +
                "arUpdateAverageMs=${arUpdateAverageMs.number()} " +
                "dynamicScale=${dynamicResolutionScale[0].number()},${dynamicResolutionScale[1].number()} " +
                "pssKb=$latestPssKb thermal=${thermalStatus()} " +
                "gcCount=$latestGcCount gcTimeMs=$latestGcTimeMs ${qualitySummary()}"
        )
        runState = RunState.IDLE
    }

    private fun logWindowIfNeeded() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastWindowLogMs < 1_000L) return
        lastWindowLogMs = now

        Debug.getMemoryInfo(memoryInfo)
        latestPssKb = memoryInfo.totalPss
        val runtimeStats = Debug.getRuntimeStats()
        latestGcCount = runtimeStats["art.gc.gc-count"] ?: "unknown"
        latestGcTimeMs = runtimeStats["art.gc.gc-time"] ?: "unknown"
        filamentView.getLastDynamicResolutionScale(dynamicResolutionScale)
        val stats = windowFrames.statistics()
        val renderer = poseRenderer()
        Log.i(
            TAG,
            "TICK experiment=$experiment phase=$runState p50Ms=${stats.p50Ms.number()} " +
                "p95Ms=${stats.p95Ms.number()} p99Ms=${stats.p99Ms.number()} " +
                "over50=${stats.over50Count} over100=${stats.over100Count} " +
                cpuSummary(windowCpu) +
                " arPoseFrames=${renderer.poseCounter.get()} arGlFrames=${renderer.frameCounter.get()} " +
                "dynamicScale=${dynamicResolutionScale[0].number()},${dynamicResolutionScale[1].number()} " +
                "pssKb=$latestPssKb thermal=${thermalStatus()} " +
                "gcCount=$latestGcCount gcTimeMs=$latestGcTimeMs ${qualitySummary()}"
        )
        windowFrames.clear()
        windowCpu.clear()
    }

    private fun cpuSummary(cpu: CpuTotals): String {
        val frames = cpu.frames.coerceAtLeast(1L).toDouble()
        return "cpuCallbackMs=${(cpu.callbackNanos / frames / 1_000_000.0).number()} " +
            "cpuInputMs=${(cpu.inputNanos / frames / 1_000_000.0).number()} " +
            "cpuArMs=${(cpu.arControllerNanos / frames / 1_000_000.0).number()} " +
            "cpuAnimationMs=${(cpu.animationNanos / frames / 1_000_000.0).number()} " +
            "cpuCameraMs=${(cpu.cameraNanos / frames / 1_000_000.0).number()} "
    }

    private fun thermalStatus(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) powerManager.currentThermalStatus else -1

    private fun Double.number(): String = String.format(Locale.US, "%.3f", this)
    private fun Float.number(): String = String.format(Locale.US, "%.3f", this)

    companion object {
        private const val TAG = "RenderPerf"
    }
}
