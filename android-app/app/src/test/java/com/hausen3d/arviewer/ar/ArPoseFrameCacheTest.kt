package com.hausen3d.arviewer.ar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ArPoseFrameCacheTest {

    private fun snapshot(timestampNs: Long, x: Float) = ArPoseSnapshot(
        FloatArray(16).apply { this[12] = x },
        true,
        timestampNs
    )

    @Test
    fun `same AR timestamp reuses the converted matrix`() {
        val cache = ArPoseFrameCache()
        val first = cache.get(snapshot(10L, 1f))

        assertFalse(cache.isNew(snapshot(10L, 99f)))
        assertSame(first, cache.get(snapshot(10L, 99f)))
        assertEquals(1f, first.w.x, 0f)
    }

    @Test
    fun `new AR timestamp converts exactly one new matrix`() {
        val cache = ArPoseFrameCache()
        val first = cache.get(snapshot(10L, 1f))
        val secondSnapshot = snapshot(20L, 2f)

        assertTrue(cache.isNew(secondSnapshot))
        val second = cache.get(secondSnapshot)
        assertNotSame(first, second)
        assertSame(second, cache.get(secondSnapshot))
        assertEquals(2f, second.w.x, 0f)
    }

    @Test
    fun `reset forces conversion after an AR session restart`() {
        val cache = ArPoseFrameCache()
        val first = cache.get(snapshot(10L, 1f))
        cache.reset()

        assertTrue(cache.isNew(snapshot(10L, 1f)))
        assertNotSame(first, cache.get(snapshot(10L, 1f)))
    }
}
