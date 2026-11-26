package com.hausen3d.arviewer.rendering

import org.junit.Assert.assertEquals
import org.junit.Test

class FrameTimeRingBufferTest {
    @Test
    fun statisticsUseNearestRankAndStrictSlowFrameThresholds() {
        val buffer = FrameTimeRingBuffer(128)
        for (milliseconds in 1..100) buffer.add(milliseconds * 1_000_000L)

        val stats = buffer.statistics()

        assertEquals(100, stats.count)
        assertEquals(50.0, stats.p50Ms, 0.0001)
        assertEquals(95.0, stats.p95Ms, 0.0001)
        assertEquals(99.0, stats.p99Ms, 0.0001)
        assertEquals(50, stats.over50Count)
        assertEquals(0, stats.over100Count)
        assertEquals(50.0, stats.over50Percent, 0.0001)
    }

    @Test
    fun ringRetainsOnlyNewestValues() {
        val buffer = FrameTimeRingBuffer(10)
        for (milliseconds in 1..20) buffer.add(milliseconds * 1_000_000L)

        val stats = buffer.statistics()

        assertEquals(10, stats.count)
        assertEquals(15.0, stats.p50Ms, 0.0001)
        assertEquals(20.0, stats.p95Ms, 0.0001)
        assertEquals(20.0, stats.p99Ms, 0.0001)
    }

    @Test
    fun clearReusesBufferWithoutStaleSamples() {
        val buffer = FrameTimeRingBuffer(8)
        buffer.add(100_000_000L)
        buffer.clear()
        buffer.add(16_000_000L)

        val stats = buffer.statistics()

        assertEquals(1, stats.count)
        assertEquals(16.0, stats.p95Ms, 0.0001)
        assertEquals(0, stats.over100Count)
    }
}
