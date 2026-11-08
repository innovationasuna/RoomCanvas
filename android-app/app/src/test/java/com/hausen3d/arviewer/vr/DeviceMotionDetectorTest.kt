package com.hausen3d.arviewer.vr

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sin

class DeviceMotionDetectorTest {

    private companion object {
        const val START_NS = 1_000_000_000L
        const val FRAME_NS = 20_000_000L
    }

    private fun DeviceMotionDetector.acceleration(x: Float, frame: Int) {
        updateLinearAcceleration(x, 0f, 0f, START_NS + frame * FRAME_NS)
    }

    private fun DeviceMotionDetector.gyro(y: Float, frame: Int) {
        updateGyroscope(0f, y, 0f, START_NS + frame * FRAME_NS)
    }

    private fun DeviceMotionDetector.state(frame: Int) = snapshot(START_NS + frame * FRAME_NS)

    @Test
    fun `stationary sensor noise never opens AR channels`() {
        val detector = DeviceMotionDetector()

        repeat(500) { i ->
            val phase = i * 0.1f
            detector.acceleration(0.03f * sin(phase), i)
            detector.gyro(0.005f * sin(phase), i)
            val state = detector.state(i)
            assertFalse(state.translationActive)
            assertFalse(state.rotationActive)
        }
    }

    @Test
    fun `single acceleration spike does not confirm walking`() {
        val detector = DeviceMotionDetector()
        detector.acceleration(2f, 0)

        repeat(10) { i ->
            detector.acceleration(0f, i + 1)
            assertFalse(detector.state(i + 1).translationActive)
        }
    }

    @Test
    fun `walking acceleration opens translation and holds across gait`() {
        val detector = DeviceMotionDetector()

        repeat(100) { i ->
            detector.acceleration(0.9f * sin(i * 2f * Math.PI.toFloat() / 25f), i)
            if (i >= 30) assertTrue("frame=$i", detector.state(i).translationActive)
        }
        assertTrue(detector.state(110).translationActive)
        assertFalse(detector.state(130).translationActive)
    }

    @Test
    fun `rotation channel is independent and expires after stopping`() {
        val detector = DeviceMotionDetector()

        repeat(10) { i ->
            detector.acceleration(0f, i)
            detector.gyro(0.2f, i)
        }
        val moving = detector.state(9)
        assertFalse(moving.translationActive)
        assertTrue(moving.rotationActive)

        repeat(5) { i ->
            detector.gyro(0f, 10 + i)
            assertTrue(detector.state(10 + i).rotationActive)
        }
        assertFalse(detector.state(26).rotationActive)
    }

    @Test
    fun `reset immediately withdraws motion confirmation`() {
        val detector = DeviceMotionDetector()
        repeat(10) { i ->
            detector.acceleration(1f, i)
            detector.gyro(0.2f, i)
        }
        assertTrue(detector.state(10).translationActive)
        assertTrue(detector.state(10).rotationActive)

        detector.reset()

        val state = detector.state(10)
        assertFalse(state.translationActive)
        assertFalse(state.rotationActive)
    }
}
