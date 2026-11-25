package com.hausen3d.arviewer.rendering

import kotlin.math.ceil

class FrameTimeRingBuffer(private val capacity: Int) {
    data class Statistics(
        val count: Int,
        val p50Ms: Double,
        val p95Ms: Double,
        val p99Ms: Double,
        val over50Count: Int,
        val over100Count: Int
    ) {
        val over50Percent: Double = if (count == 0) 0.0 else over50Count * 100.0 / count
        val over100Percent: Double = if (count == 0) 0.0 else over100Count * 100.0 / count
    }

    private val values = LongArray(capacity)
    private val scratch = LongArray(capacity)
    private var writeIndex = 0
    private var size = 0

    val count: Int get() = size

    fun add(frameIntervalNanos: Long) {
        if (frameIntervalNanos <= 0L) return
        values[writeIndex] = frameIntervalNanos
        writeIndex = (writeIndex + 1) % capacity
        if (size < capacity) size++
    }

    fun clear() {
        writeIndex = 0
        size = 0
    }

    fun statistics(): Statistics {
        if (size == 0) return Statistics(0, 0.0, 0.0, 0.0, 0, 0)
        System.arraycopy(values, 0, scratch, 0, size)
        scratch.sort(0, size)
        var over50 = 0
        var over100 = 0
        for (index in 0 until size) {
            if (scratch[index] > 50_000_000L) over50++
            if (scratch[index] > 100_000_000L) over100++
        }
        return Statistics(
            count = size,
            p50Ms = percentile(0.50) / 1_000_000.0,
            p95Ms = percentile(0.95) / 1_000_000.0,
            p99Ms = percentile(0.99) / 1_000_000.0,
            over50Count = over50,
            over100Count = over100
        )
    }

    private fun percentile(fraction: Double): Long {
        val rank = ceil(fraction * size).toInt().coerceIn(1, size)
        return scratch[rank - 1]
    }
}
