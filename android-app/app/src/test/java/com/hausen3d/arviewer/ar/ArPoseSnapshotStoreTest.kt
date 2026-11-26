package com.hausen3d.arviewer.ar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ArPoseSnapshotStoreTest {

    @Test
    fun `updates reuse one snapshot and one matrix`() {
        val store = ArPoseSnapshotStore()
        val identity = store.read { it to it.viewToWorld }

        store.update {
            it.viewToWorld[12] = 3f
            it.isTracking = true
            it.timestampNs = 20L
        }

        store.read {
            assertSame(identity.first, it)
            assertSame(identity.second, it.viewToWorld)
            assertEquals(3f, it.viewToWorld[12], 0f)
            assertTrue(it.isTracking)
            assertEquals(20L, it.timestampNs)
        }
    }

    @Test
    fun `locked readers never observe a partially written matrix`() {
        val store = ArPoseSnapshotStore()
        val writer = Thread {
            repeat(2_000) { index ->
                val value = (index + 1).toFloat()
                store.update {
                    it.viewToWorld.fill(value)
                    it.timestampNs = value.toLong()
                    it.isTracking = true
                }
            }
        }
        writer.start()
        while (writer.isAlive) {
            store.read {
                if (it.timestampNs > 0L) {
                    val expected = it.timestampNs.toFloat()
                    assertTrue(it.viewToWorld.all { value -> value == expected })
                }
            }
        }
        writer.join()
    }
}
