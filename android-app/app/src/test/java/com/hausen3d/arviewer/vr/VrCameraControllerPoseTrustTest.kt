package com.hausen3d.arviewer.vr

import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import dev.romainguy.kotlin.math.rotation
import dev.romainguy.kotlin.math.translation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VrCameraControllerPoseTrustTest {

    private companion object {
        const val START_NS = 1_000_000_000L
        const val FRAME_NS = 16_666_667L
        const val FRAME_DT = 1f / 60f
        const val WALK_MPS = 0.9f
        const val TOLERANCE_M = 0.03f
    }

    private fun controller() = VrCameraController(
        startPosition = Float3(0f, 1.6f, 0f),
        startYawDegrees = 0f,
        roomMinX = -3f,
        roomMaxX = 3f,
        roomMinZ = -3f,
        roomMaxZ = 3f,
        roomMinY = 0f,
        roomMaxY = 2.7f
    )

    private fun poseAt(x: Float, z: Float): Mat4 = translation(Float3(x, 0f, z))

    private fun poseAt(x: Float, z: Float, yawDegrees: Float): Mat4 =
        translation(Float3(x, 0f, z)) * rotation(Float3(0f, 1f, 0f), yawDegrees)

    private fun motion(translation: Boolean = false, rotation: Boolean = false) =
        DeviceMotionState(translationActive = translation, rotationActive = rotation)

    private fun VrCameraController.update(
        pose: Mat4,
        frame: Int,
        translationActive: Boolean = false,
        rotationActive: Boolean = false
    ) {
        updateArPose(
            pose,
            START_NS + frame * FRAME_NS,
            motion(translationActive, rotationActive)
        )
    }

    private fun VrCameraController.walkForwardOneMeter(startFrame: Int = 0): Float {
        val frames = (1f / (WALK_MPS * FRAME_DT)).toInt()
        repeat(frames) { i ->
            update(
                poseAt(0f, -WALK_MPS * FRAME_DT * (i + 1)),
                startFrame + i + 1,
                translationActive = true
            )
        }
        return -WALK_MPS * FRAME_DT * frames
    }

    @Test
    fun `AR pose driving is enabled`() {
        assertTrue(VrCameraController.AR_POSE_DRIVES_CAMERA)
        assertTrue(controller().isArPoseApplied)
    }

    @Test
    fun `diverging AR pose cannot move or rotate a stationary device`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f), START_NS)

        repeat(35 * 60) { i ->
            val t = (i + 1) * FRAME_DT
            c.update(
                poseAt(2f * t, 30f / 35f * t, (t * 36f) % 360f),
                i + 1
            )
        }

        assertEquals(0f, c.currentPosition().x, 1e-4f)
        assertEquals(0f, c.currentPosition().z, 1e-4f)
        assertEquals(0f, c.headingDegrees, 1e-3f)
        assertTrue("原始 AR 位姿仍应被记录", c.debugRawArX > 60f)
        assertFalse(c.isFollowingArWalk)
    }

    @Test
    fun `real walking is followed one to one when IMU confirms translation`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f), START_NS)

        val walked = c.walkForwardOneMeter()

        assertEquals(walked, c.currentPosition().z, TOLERANCE_M)
        assertEquals(0f, c.currentPosition().x, 1e-4f)
    }

    @Test
    fun `real turning is followed when IMU confirms rotation`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f, 0f), START_NS)

        repeat(60) { i ->
            c.update(
                poseAt(0f, 0f, (i + 1).toFloat()),
                i + 1,
                rotationActive = true
            )
        }

        assertEquals(60f, c.headingDegrees, 1e-3f)
    }

    @Test
    fun `walking alone does not admit AR yaw drift`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f, 0f), START_NS)

        repeat(90) { i ->
            c.update(
                poseAt(0f, -WALK_MPS * FRAME_DT * (i + 1), (i + 1) * 0.6f),
                i + 1,
                translationActive = true,
                rotationActive = false
            )
        }

        assertEquals(0f, c.headingDegrees, 1e-3f)
        assertTrue(c.currentPosition().z < -1f)
    }

    @Test
    fun `rejected drift is not replayed when motion resumes`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f, 0f), START_NS)

        repeat(180) { i ->
            c.update(poseAt(20f, 0f, 30f), i + 1)
        }
        val walkFrames = (1f / (WALK_MPS * FRAME_DT)).toInt()
        val walked = -WALK_MPS * FRAME_DT * walkFrames
        repeat(walkFrames) { i ->
            c.update(
                poseAt(20f, -WALK_MPS * FRAME_DT * (i + 1), 30f),
                181 + i,
                translationActive = true
            )
        }
        repeat(60) { i ->
            c.update(
                poseAt(20f, walked, 30f + (i + 1) * 0.5f),
                247 + i,
                rotationActive = true
            )
        }

        assertEquals(0f, c.currentPosition().x, 1e-4f)
        assertEquals(walked, c.currentPosition().z, TOLERANCE_M)
        assertEquals(30f, c.headingDegrees, 1e-3f)
    }

    @Test
    fun `drift after walking keeps the walked distance`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f), START_NS)
        val walked = c.walkForwardOneMeter()

        repeat(300) { i ->
            c.update(poseAt((i + 1) * 0.01f, walked), 67 + i)
        }

        assertEquals(0f, c.currentPosition().x, 1e-4f)
        assertEquals(walked, c.currentPosition().z, TOLERANCE_M)
    }

    @Test
    fun `relocalization jump is not applied`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f), START_NS)
        val walked = c.walkForwardOneMeter()

        c.update(poseAt(0.8f, walked), 67, translationActive = true)

        assertEquals(0f, c.currentPosition().x, 1e-4f)
        assertEquals(walked, c.currentPosition().z, TOLERANCE_M)
    }

    @Test
    fun `duplicate AR timestamp is consumed at most once`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f), START_NS)
        c.update(poseAt(0f, -0.015f), 1, translationActive = true)
        val count = c.arPoseUpdateCount
        val position = c.currentPosition()

        c.updateArPose(
            poseAt(2f, -1f, 40f),
            START_NS + FRAME_NS,
            motion(translation = true, rotation = true)
        )

        assertEquals(count, c.arPoseUpdateCount)
        assertEquals(position.x, c.currentPosition().x, 1e-4f)
        assertEquals(position.z, c.currentPosition().z, 1e-4f)
        assertEquals(0f, c.debugRawArX, 1e-4f)
        assertEquals(0f, c.headingDegrees, 1e-3f)
    }

    @Test
    fun `long AR gap reanchors without moving the current view`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f), START_NS)
        val walked = c.walkForwardOneMeter()
        val before = c.currentPosition()

        c.updateArPose(poseAt(8f, 9f), START_NS + 2_000_000_000L, motion(true, true))

        assertEquals(before.x, c.currentPosition().x, 1e-4f)
        assertEquals(before.z, c.currentPosition().z, 1e-4f)
        assertEquals(walked, c.currentPosition().z, TOLERANCE_M)
    }

    @Test
    fun `arrow keys and swipe remain independent from AR`() {
        val c = controller()
        repeat(60) { c.applyMoveInput(1f, 0f, 0f, FRAME_DT) }
        c.applyLookDelta(100f, 0f)

        assertTrue(c.currentPosition().z < -0.9f)
        assertEquals(-100f * VrCameraController.LOOK_DEG_PER_PX, c.headingDegrees, 1e-3f)
    }
}
