package com.hausen3d.arviewer.rendering

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugCameraTrackTest {
    private val startNs = 1_000_000_000L

    @Test
    fun trackMovesForwardForTenSecondsAndScansBothDirections() {
        val track = DebugCameraTrack()
        track.start(startNs)

        track.advance(startNs)
        assertTrue(track.resetRequested)
        assertEquals(1f, track.forwardAxis)

        track.advance(startNs + 10_000_000_000L)
        assertEquals(0f, track.forwardAxis)

        track.advance(startNs + 15_000_000_000L)
        assertEquals(-1200f, track.lookDeltaXPixels, 0.001f)

        track.advance(startNs + 25_000_000_000L)
        assertEquals(2400f, track.lookDeltaXPixels, 0.001f)

        track.advance(startNs + 30_000_000_000L)
        assertEquals(-1200f, track.lookDeltaXPixels, 0.001f)
    }

    @Test
    fun trackTogglesTwoAnimationsAndReturnsThemToInitialState() {
        val track = DebugCameraTrack()
        track.start(startNs)
        track.advance(startNs)

        track.advance(startNs + 30_000_000_000L)
        assertEquals(0, track.toggleAnimationIndex)
        track.advance(startNs + 31_000_000_000L)
        assertEquals(-1, track.toggleAnimationIndex)
        track.advance(startNs + 32_000_000_000L)
        assertEquals(1, track.toggleAnimationIndex)
        track.advance(startNs + 34_000_000_000L)
        assertEquals(0, track.toggleAnimationIndex)
        track.advance(startNs + 36_000_000_000L)
        assertEquals(1, track.toggleAnimationIndex)
    }

    @Test
    fun eachLoopRequestsFreshStartPose() {
        val track = DebugCameraTrack()
        track.start(startNs)
        track.advance(startNs)
        track.advance(startNs + 20_000_000_000L)
        assertFalse(track.resetRequested)

        track.advance(startNs + 40_000_000_000L)

        assertTrue(track.resetRequested)
        assertEquals(1f, track.forwardAxis)
        assertEquals(-1, track.toggleAnimationIndex)
    }

    @Test
    fun movementDeltaUsesWallClockWithoutFrameClamp() {
        val track = DebugCameraTrack()
        track.start(startNs)
        track.advance(startNs)
        assertEquals(0f, track.movementDeltaSeconds)

        track.advance(startNs + 1_500_000_000L)
        assertEquals(1.5f, track.movementDeltaSeconds, 0.0001f)

        track.advance(startNs + 2_000_000_000L)
        assertEquals(0.5f, track.movementDeltaSeconds, 0.0001f)
    }
}
