package com.hausen3d.arviewer.vr

import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import dev.romainguy.kotlin.math.rotation
import dev.romainguy.kotlin.math.translation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AR 位姿的可信度契约：**默认不参与相机合成**。
 *
 * 2026-10-23 P40 Pro 实测：手机静止、未触屏时，AR Engine 的原始位置在 27 s 内从 0.2 m
 * 平滑漂到 70 m，偏航 1.5 s 内转了 54°，且跟踪反复丢失/恢复。假运动方向一致、
 * 速度 0.3~2 m/s，与真实走动的数学特征完全重合，任何速度/位移判据都无法区分。
 *
 * 因此本文件锁定的行为是：
 * - AR 位姿再怎么发散（漂移或真实走动）都不改变虚拟相机；
 * - AR 偏航再怎么跳变都不改变朝向；
 * - 方向键与滑屏仍然正常工作（漫游不依赖 AR）。
 *
 * 若将来在目标机型上证明 VIO 可靠、把 `AR_POSE_DRIVES_CAMERA` 打开，
 * 这些用例需要同步改回「1:1 跟随」的契约（旧版本见 git 历史）。
 */
class VrCameraControllerPoseTrustTest {

    private companion object {
        const val FRAME_DT = 1f / 60f
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

    /** 带水平偏航的位姿（rotation 为角度制，绕 +Y） */
    private fun poseAt(x: Float, z: Float, yawDegrees: Float): Mat4 =
        rotation(Float3(0f, 1f, 0f), yawDegrees) * translation(Float3(x, 0f, z))

    @Test
    fun `AR pose is not applied to the camera`() {
        assertFalse(VrCameraController.AR_POSE_DRIVES_CAMERA)
        assertFalse(controller().isArPoseApplied)
    }

    @Test
    fun `diverging AR position never moves the camera`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f))

        // 复现真机：35 s 内 raw 位置平滑涨到 (70, 30)，速度 2 m/s
        var frames = 0
        while (frames < 35 * 60) {
            frames++
            val t = frames * FRAME_DT
            c.updateArPose(poseAt(2f * t, 30f / 35f * t), FRAME_DT)
        }

        assertEquals(0f, c.currentPosition().x, 1e-4f)
        assertEquals(0f, c.currentPosition().z, 1e-4f)
        // 原始位姿仍在被观测（日志用），只是不参与合成
        assertTrue("AR 原始位置应继续被记录，实际 x=${c.debugRawArX}", c.debugRawArX > 60f)
    }

    @Test
    fun `real walking does not move the camera either`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f))

        // 0.9 m/s 向前走 1 m：AR 关闭时同样不采纳
        repeat((1f / (0.9f * FRAME_DT)).toInt()) { i ->
            c.updateArPose(poseAt(0f, -0.9f * FRAME_DT * (i + 1)), FRAME_DT)
        }

        assertEquals(0f, c.currentPosition().z, 1e-4f)
    }

    @Test
    fun `AR yaw jumps do not rotate the view`() {
        val c = controller()
        c.attachArReference(poseAt(0f, 0f, 0f))

        // 复现真机：每 0.5 s 转 27°，持续 1.5 s
        listOf(27f, 56f, 39f).forEach { yaw ->
            repeat(30) { c.updateArPose(poseAt(0f, 0f, yaw), FRAME_DT) }
        }

        assertEquals(0f, c.headingDegrees, 1e-3f)
    }

    @Test
    fun `arrow keys still move the camera`() {
        val c = controller()

        // 按住前进 1 s（朝向 0 → 沿 -Z）
        repeat(60) { c.applyMoveInput(1f, 0f, 0f, FRAME_DT) }

        val z = c.currentPosition().z
        assertTrue("前进后应出现在 -Z 方向，实际 z=$z", z < -0.9f)
        assertTrue("1 s 不应走超过 1.2 m（速度上限），实际 z=$z", z > -1.2f)
    }

    @Test
    fun `swipe still turns the view`() {
        val c = controller()

        c.applyLookDelta(100f, 0f)

        assertEquals(-100f * VrCameraController.LOOK_DEG_PER_PX, c.headingDegrees, 1e-3f)
    }
}
