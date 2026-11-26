package com.hausen3d.arviewer.vr

import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import dev.romainguy.kotlin.math.rotation
import dev.romainguy.kotlin.math.translation
import org.junit.Assert.assertArrayEquals
import org.junit.Test

/**
 * `cameraPoseInto()` 是 `cameraPose()` 的免分配版本：两者必须逐元素一致。
 * 用旧实现（kotlin-math 组合）作为参考，覆盖初始、滑屏、按键、AR 跟随四类状态。
 */
class VrCameraPoseIntoTest {

    private fun controller() = VrCameraController(
        startPosition = Float3(0.4f, 1.6f, -0.8f),
        startYawDegrees = 35f,
        roomMinX = -3f,
        roomMaxX = 3f,
        roomMinZ = -3f,
        roomMaxZ = 3f,
        roomMinY = 0f,
        roomMaxY = 2.7f
    )

    private fun Mat4.toColumnMajor(): FloatArray = floatArrayOf(
        x.x, x.y, x.z, x.w,
        y.x, y.y, y.z, y.w,
        z.x, z.y, z.z, z.w,
        w.x, w.y, w.z, w.w
    )

    private fun assertMatches(controller: VrCameraController) {
        val expected = controller.cameraPose().toColumnMajor()
        val actual = FloatArray(16)
        controller.cameraPoseInto(actual)
        assertArrayEquals(
            "cameraPoseInto 必须与 Mat4 组合结果一致",
            expected,
            actual,
            1e-4f
        )
    }

    @Test
    fun initialPoseMatches() {
        assertMatches(controller())
    }

    @Test
    fun lookDeltasMatch() {
        val controller = controller()
        controller.applyLookDelta(-1200f, 300f)
        assertMatches(controller)

        // 俯仰夹到上限后仍必须一致
        controller.applyLookDelta(0f, 10_000f)
        assertMatches(controller)
    }

    @Test
    fun moveAndLookMatch() {
        val controller = controller()
        repeat(120) {
            controller.applyMoveInput(1f, 0.35f, 1f, 1f / 60f)
            controller.applyLookDelta(-6f, 2f)
        }
        assertMatches(controller)
    }

    @Test
    fun arFollowMatches() {
        val controller = controller()
        controller.attachArReference(translation(Float3(0f, 0f, 0f)))
        repeat(60) { i ->
            val pose = translation(Float3(0.02f * (i + 1), 0f, -0.01f * (i + 1))) *
                rotation(Float3(0f, 1f, 0f), 2f * (i + 1))
            controller.updateArPose(
                pose,
                1_000_000_000L + (i + 1) * 33_333_333L,
                DeviceMotionState(translationActive = true, rotationActive = true)
            )
        }
        assertMatches(controller)
    }
}
