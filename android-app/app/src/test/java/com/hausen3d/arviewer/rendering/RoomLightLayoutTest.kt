package com.hausen3d.arviewer.rendering

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class RoomLightLayoutTest {
    private val room = bounds(-4f, -1.5f, -2f, 4f, 1.2f, 2f)

    @Test
    fun `ceiling lamp matches watt temperature and five centimetre drop`() {
        val ceiling = NamedRoomBounds(
            "Ceiling0",
            bounds(-4f, 1.1f, -2f, 4f, 1.2f, 2f)
        )

        val lights = RoomLightLayout.plan(room, listOf(ceiling))

        assertEquals(1, lights.size)
        val lamp = lights.single()
        assertEquals(RoomLightKind.CEILING, lamp.kind)
        assertVecEquals(Vec3(0f, 1.05f, 0f), lamp.position)
        assertEquals(60f, lamp.watts, 0f)
        assertEquals(4700f, lamp.temperatureKelvin, 0f)
        assertEquals(0.05f, lamp.bulbRadius, 0f)
        assertNull(lamp.direction)
    }

    @Test
    fun `window frames become one inward daylight light`() {
        val frames = listOf(
            NamedRoomBounds("Window0_Frame_left", bounds(-4f, -0.5f, -1f, -3.9f, 1f, -0.8f)),
            NamedRoomBounds("Window0_Frame_right", bounds(-4f, -0.5f, 0.8f, -3.9f, 1f, 1f)),
            NamedRoomBounds("Window0_Frame_top", bounds(-4f, 0.9f, -1f, -3.9f, 1f, 1f))
        )

        val lights = RoomLightLayout.plan(room, frames)

        assertEquals(1, lights.size)
        val window = lights.single()
        assertEquals(RoomLightKind.WINDOW, window.kind)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), window.position)
        assertEquals(20f, window.watts, 0f)
        assertEquals(6500f, window.temperatureKelvin, 0f)
        val direction = requireNotNull(window.direction)
        assertTrue(direction.x > 0.9f)
        assertTrue(direction.y < 0f)
        assertEquals(0f, direction.z, 1e-5f)
        assertEquals(1f, direction.length(), 1e-5f)
    }

    @Test
    fun `curtains and sheers do not become extra window lights`() {
        val parts = listOf(
            NamedRoomBounds("Window_Frame_Sill_Pelmet", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f)),
            NamedRoomBounds("WindowDrapePiano_pleated_cloth", bounds(-3.8f, -0.5f, -1f, -3.7f, 1f, 1f)),
            NamedRoomBounds("WindowSheer_pleated_cloth", bounds(-3.7f, -0.5f, -1f, -3.6f, 1f, 1f))
        )

        val lights = RoomLightLayout.plan(room, parts)

        assertEquals(1, lights.size)
        assertEquals(RoomLightKind.WINDOW, lights.single().kind)
    }

    @Test
    fun `shell bounds exclude daylight helpers outside the room`() {
        val shell = listOf(
            NamedRoomBounds("Wall0", bounds(-2f, -1.5f, -2f, -1.9f, 1.2f, 2f)),
            NamedRoomBounds("Floor0", bounds(-2f, -1.5f, -2f, 2f, -1.4f, 2f)),
            NamedRoomBounds("daylight_card", bounds(-20f, 0f, -20f, 20f, 10f, 20f))
        )

        val result = RoomLightLayout.shellBounds(shell, room)

        assertEquals(Vec3(-2f, -1.5f, -2f), result.min)
        assertEquals(Vec3(2f, 1.2f, 2f), result.max)
    }

    @Test
    fun `local light budget is respected and sun points downward`() {
        val parts = (0 until 6).map {
            NamedRoomBounds("Ceiling$it", bounds(it.toFloat(), 1.1f, 0f, it + 1f, 1.2f, 1f))
        }

        assertEquals(3, RoomLightLayout.plan(room, parts, maxLocalLights = 3).size)
        assertTrue(RoomLightLayout.plan(room, parts, maxLocalLights = 0).isEmpty())
        val sun = RoomLightLayout.sunDirection()
        assertTrue(sun.y < 0f)
        assertEquals(1f, sun.length(), 1e-5f)
        assertEquals(-sqrt(1f - cos40() * cos40()), sun.y, 1e-5f)
    }

    private fun cos40() = kotlin.math.cos(Math.toRadians(40.0)).toFloat()

    private fun assertVecEquals(expected: Vec3, actual: Vec3) {
        assertEquals(expected.x, actual.x, 1e-5f)
        assertEquals(expected.y, actual.y, 1e-5f)
        assertEquals(expected.z, actual.z, 1e-5f)
    }

    private fun Vec3.length() = sqrt(x * x + y * y + z * z)

    private fun bounds(minX: Float, minY: Float, minZ: Float, maxX: Float, maxY: Float, maxZ: Float) =
        RoomBounds(Vec3(minX, minY, minZ), Vec3(maxX, maxY, maxZ))
}
