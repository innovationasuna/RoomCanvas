package com.hausen3d.arviewer.rendering

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

class RoomLightLayoutTest {
    private val room = bounds(-4f, -1.5f, -2f, 4f, 1.2f, 2f)

    @Test
    fun `ceiling lamp matches watt temperature and drop`() {
        val ceiling = NamedRoomBounds(
            "Ceiling0",
            bounds(-4f, 1.1f, -2f, 4f, 1.2f, 2f)
        )

        val lights = RoomLightLayout.plan(room, listOf(ceiling))

        assertEquals(1, lights.size)
        val lamp = lights.single()
        assertEquals(RoomLightKind.CEILING, lamp.kind)
        assertVecEquals(Vec3(0f, 1.1f - RoomLightLayout.CEILING_DROP_M, 0f), lamp.position)
        assertEquals(RoomLightLayout.CEILING_WATTS, lamp.watts, 0f)
        assertEquals(4700f, lamp.temperatureKelvin, 0f)
        assertVecEquals(Vec3(0f, -1f, 0f), requireNotNull(lamp.direction))
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
        assertEquals(RoomLightLayout.WINDOW_WATTS, window.watts, 0f)
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
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), lights.single().position)
    }

    @Test
    fun `office composite frame keeps its light despite the blind suffix`() {
        val frame = NamedRoomBounds(
            "Window_Frame_Fixed_Lights_Sill_Blind",
            bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f)
        )

        for (part in listOf(frame, frame.copy(ancestors = path("Window0")))) {
            val light = RoomLightLayout.plan(room, listOf(part)).single()
            assertEquals(RoomLightKind.WINDOW, light.kind)
            assertVecEquals(Vec3(-3.87f, 0.25f, 0f), light.position)
            assertEquals(220f, light.watts, 0f)
            assertEquals(6500f, light.temperatureKelvin, 0f)
        }
    }

    @Test
    fun `composite frame root groups anonymous and named mesh descendants`() {
        val root = "Window_Frame_Fixed_Lights_Sill_Blind"
        val parts = listOf(
            NamedRoomBounds("", bounds(-4f, -0.5f, -1f, -3.9f, 0f, 0f), path(root)),
            NamedRoomBounds("Glass", bounds(-4f, 0f, 0f, -3.9f, 1f, 1f), path(root)),
            NamedRoomBounds("", bounds(-10f, -5f, -10f, -5f, 5f, 10f), path(root, "Blind"))
        )

        val light = RoomLightLayout.plan(room, parts).single()

        assertEquals(RoomLightKind.WINDOW, light.kind)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), light.position)
        val frame = NamedRoomBounds(root, bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f), entityId = root.hashCode())
        assertEquals(light, RoomLightLayout.plan(room, parts + frame).single())
    }

    @Test
    fun `composite frame ancestor groups its numbered window leaves`() {
        val root = "Window_Frame_Sill_Pelmet"
        val parts = listOf(
            NamedRoomBounds("Glass", bounds(-4f, -0.5f, -1f, -3.9f, 0f, 0f), path(root, "Window1")),
            NamedRoomBounds("Glass", bounds(-4f, 0f, 0f, -3.9f, 1f, 1f), path(root, "Window2"))
        )

        val light = RoomLightLayout.plan(room, parts).single()

        assertEquals(RoomLightKind.WINDOW, light.kind)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), light.position)
    }

    @Test
    fun `window ancestor names require a word boundary`() {
        val plainMesh = NamedRoomBounds(
            "Glass", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f), path("Windowless_Room")
        )

        assertTrue(RoomLightLayout.plan(room, listOf(plainMesh)).isEmpty())
        for (root in listOf("Window", "Window0", "Window_0", "Window-0", "Window_Frame")) {
            val part = plainMesh.copy(ancestors = path("Windowless_Room", root))
            assertVecEquals(Vec3(-3.87f, 0.25f, 0f), RoomLightLayout.plan(room, listOf(part)).single().position)
        }
    }

    @Test
    fun `classroom window leaves aggregate under the outer semantic window`() {
        val frame = NamedRoomBounds(
            "Window_Frame_Sill_Pelmet",
            bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f),
            ancestors = path("Wall2", "Window0")
        )
        val leaves = (1..8).map { index ->
            NamedRoomBounds(
                "Casement_${(index + 1) / 2}_${if (index % 2 == 1) "L" else "R"}",
                bounds(-4f, -0.4f, -0.9f, -3.9f, 0.9f, 0.9f),
                ancestors = path("Wall2", "Window0", "Window_Frame_Sill_Pelmet", "Window$index")
            )
        }
        val curtain = NamedRoomBounds(
            "Curtain_Center_FixedFrame", bounds(-5f, -1f, -3f, -3f, 2f, 3f),
            ancestors = path("Wall2", "Window0", "Window_Frame_Sill_Pelmet")
        )

        val light = RoomLightLayout.plan(room, leaves + curtain + frame).single()

        assertEquals(RoomLightKind.WINDOW, light.kind)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), light.position)
    }

    @Test
    fun `unnamed descendants contribute bounds to their window root`() {
        val parts = listOf(
            NamedRoomBounds("", bounds(-4f, -0.5f, -1f, -3.9f, 0f, 0f), path("Window0", "Glass")),
            NamedRoomBounds("", bounds(-4f, 0f, 0f, -3.9f, 1f, 1f), path("Window0", "Window1"))
        )

        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), RoomLightLayout.plan(room, parts).single().position)
    }

    @Test
    fun `separate coverings and helper subtrees cannot enlarge the window`() {
        val frame = NamedRoomBounds(
            "Window_Frame_Sill_Pelmet", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f),
            path("Window0")
        )
        val farAway = bounds(-20f, -5f, -10f, -10f, 5f, 10f)
        val excluded = listOf(
            "WindowDrapePiano", "WindowSheer", "Window_Curtain_Frame", "Window_Blind_Frame",
            "WindowBench0", "WindowDaylightBackdrop0", "WindowExteriorBackdrop", "DaylightBackdrop"
        )
        val parts = excluded.flatMap { name ->
            listOf(
                NamedRoomBounds(name, farAway, path("Window0")),
                NamedRoomBounds("", farAway, path("Window0", name)),
                NamedRoomBounds("Window_Frame", farAway, path("Window0", name))
            )
        }

        val light = RoomLightLayout.plan(room, parts + frame).single()

        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), light.position)
        assertTrue(RoomLightLayout.plan(room, parts).isEmpty())
    }

    @Test
    fun `room3 separate curtain remains excluded even when its name starts with frame`() {
        val ancestors = path("Window0", "Window_Frame_Sill_Pelmet")
        val frame = NamedRoomBounds(
            "Window_Frame_Sill_Pelmet", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f),
            path("Window0")
        )
        val curtain = NamedRoomBounds(
            "FrameFixed_Static_Left_Pleated_Curtain", bounds(-6f, -1f, -2f, -3f, 2f, 2f), ancestors
        )

        val light = RoomLightLayout.plan(room, listOf(frame, curtain)).single()

        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), light.position)
    }

    @Test
    fun `separate window roots keep separate lights and stable ordering`() {
        val left = NamedRoomBounds("Glass", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f), path("Window0"))
        val right = NamedRoomBounds("Glass", bounds(3.9f, -0.5f, -1f, 4f, 1f, 1f), path("Window1"))

        val lights = RoomLightLayout.plan(room, listOf(right, left))

        assertEquals(2, lights.size)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), lights[0].position)
        assertVecEquals(Vec3(3.87f, 0.25f, 0f), lights[1].position)
        assertTrue(requireNotNull(lights[0].direction).x > 0f)
        assertTrue(requireNotNull(lights[1].direction).x < 0f)
    }

    @Test
    fun `independent windows and a multi-leaf window retain their identities`() {
        for (names in listOf(listOf("Window_Left", "Window_Right", "Window_Pair"),
            listOf("Window", "Window", "Window"))) {
            val facade = RoomLightAncestor(1, "Facade")
            val roots = names.mapIndexed { index, name -> RoomLightAncestor(10 + index, name) }
            val parts = listOf(
                NamedRoomBounds("Window0_Frame", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f),
                    listOf(facade, roots[0])),
                NamedRoomBounds("Window1_Frame", bounds(3.9f, -0.5f, -1f, 4f, 1f, 1f),
                    listOf(facade, roots[1])),
                NamedRoomBounds("Glass", bounds(-0.6f, -0.5f, 1.9f, 0f, 1f, 2f),
                    listOf(facade, roots[2], RoomLightAncestor(20, "Window1"))),
                NamedRoomBounds("Glass", bounds(0f, -0.5f, 1.9f, 0.6f, 1f, 2f),
                    listOf(facade, roots[2], RoomLightAncestor(21, "Window2")))
            )
            val lights = RoomLightLayout.plan(room, parts)
            assertEquals(3, lights.size)
            assertTrue(lights.all { it.kind == RoomLightKind.WINDOW })
            val positions = lights.sortedBy { it.position.x }.map { it.position }
            assertVecEquals(Vec3(-3.87f, 0.25f, 0f), positions[0])
            assertVecEquals(Vec3(0f, 0.25f, 1.87f), positions[1])
            assertVecEquals(Vec3(3.87f, 0.25f, 0f), positions[2])
            val reloaded = parts.reversed().map { part ->
                part.copy(ancestors = part.ancestors.map { it.copy(entityId = 100 - it.entityId) })
            }
            assertEquals(lights, RoomLightLayout.plan(room, reloaded))
            assertEquals(RoomLightLayout.plan(room, parts, maxLocalLights = 2),
                RoomLightLayout.plan(room, reloaded, maxLocalLights = 2))
        }
    }

    @Test
    fun `renderable root joins its descendants while flat frame pieces stay name grouped`() {
        val root = RoomLightAncestor(10, "Window_Left")
        val parts = listOf(
            NamedRoomBounds(root.name, bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f), entityId = root.entityId),
            NamedRoomBounds("Glass", bounds(-4f, -0.4f, -0.8f, -3.9f, 0.9f, 0.8f), listOf(root), 11),
            NamedRoomBounds("Window1_Frame_left", bounds(3.9f, -0.5f, -1f, 4f, 1f, 0f), entityId = 20),
            NamedRoomBounds("Window1_Frame_right", bounds(3.9f, -0.5f, 0f, 4f, 1f, 1f), entityId = 21)
        )
        val lights = RoomLightLayout.plan(room, parts).sortedBy { it.position.x }
        assertEquals(2, lights.size)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), lights[0].position)
        assertVecEquals(Vec3(3.87f, 0.25f, 0f), lights[1].position)
    }

    @Test
    fun `outer curtain wall does not suppress a real window`() {
        val frame = NamedRoomBounds("Window0_Frame", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f),
            path("CurtainWall", "Window0"))
        val lights = RoomLightLayout.plan(room, listOf(frame))
        assertEquals(1, lights.size)
        assertVecEquals(Vec3(-3.87f, 0.25f, 0f), lights.single().position)
    }

    @Test
    fun `standalone blinds with frame prefixes never enlarge a window`() {
        val frame = NamedRoomBounds("Window0_Frame", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f))
        val farAway = bounds(-20f, -5f, -10f, -10f, 5f, 10f)
        for (name in listOf("Window0_Frame_Standalone_Blind", "Window0_Frame_Curtain",
            "Window_Frame_Fixed_Lights_Sill_Blind_Standalone")) {
            val blind = NamedRoomBounds(name, farAway)
            val flatLights = RoomLightLayout.plan(room, listOf(frame, blind))
            assertEquals(1, flatLights.size)
            assertVecEquals(Vec3(-3.87f, 0.25f, 0f), flatLights.single().position)
            val nested = listOf(frame.copy(ancestors = path("Window0")),
                blind.copy(ancestors = path("Window0")),
                NamedRoomBounds("Glass", farAway, path("Window0", name)))
            val nestedLights = RoomLightLayout.plan(room, nested)
            assertEquals(1, nestedLights.size)
            assertVecEquals(Vec3(-3.87f, 0.25f, 0f), nestedLights.single().position)
        }
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
    fun `local light budget is respected`() {
        val parts = (0 until 6).map {
            NamedRoomBounds("Ceiling$it", bounds(it.toFloat(), 1.1f, 0f, it + 1f, 1.2f, 1f))
        }

        assertEquals(3, RoomLightLayout.plan(room, parts, maxLocalLights = 3).size)
        assertTrue(RoomLightLayout.plan(room, parts, maxLocalLights = 0).isEmpty())
        assertTrue(RoomLightLayout.plan(room, parts, maxLocalLights = -1).isEmpty())
    }

    @Test
    fun `window keeps one budget slot even when ceiling lights fill the budget`() {
        val ceilings = (0 until 6).map {
            NamedRoomBounds("Ceiling$it", bounds(it.toFloat(), 1.1f, 0f, it + 1f, 1.2f, 1f))
        }
        val window = NamedRoomBounds("Window0", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f))

        val lights = RoomLightLayout.plan(room, ceilings + window)

        assertEquals(
            listOf(RoomLightKind.CEILING, RoomLightKind.CEILING, RoomLightKind.CEILING, RoomLightKind.WINDOW),
            lights.map { it.kind }
        )
        assertVecEquals(Vec3(0.5f, 0.8f, 0.5f), lights[0].position)
        assertVecEquals(Vec3(1.5f, 0.8f, 0.5f), lights[1].position)
        assertVecEquals(Vec3(2.5f, 0.8f, 0.5f), lights[2].position)
        val onlyLight = RoomLightLayout.plan(room, ceilings + window, maxLocalLights = 1).single()
        assertEquals(RoomLightKind.WINDOW, onlyLight.kind)
        assertTrue(RoomLightLayout.plan(room, ceilings + window, maxLocalLights = 0).isEmpty())
        assertTrue(RoomLightLayout.plan(room, ceilings + window, maxLocalLights = -1).isEmpty())
    }

    @Test
    fun `three linear fixtures and window replace ceiling equipment`() {
        val parts = listOf(
            NamedRoomBounds("Ceiling0", bounds(-4f, 1.1f, -2f, 4f, 1.2f, 2f)),
            NamedRoomBounds("Ceiling detector housing", bounds(-1f, 1f, -1f, 0f, 1.1f, 0f)),
            NamedRoomBounds("Linear light housing.002", bounds(-1f, 1f, 2f, 1f, 1.1f, 3f)),
            NamedRoomBounds("Linear light housing", bounds(-1f, 1f, -2f, 1f, 1.1f, -1f)),
            NamedRoomBounds("Linear light housing.001", bounds(-1f, 1f, 0f, 1f, 1.1f, 1f)),
            NamedRoomBounds("WindowBench0", bounds(-4f, -1f, -1f, -3f, 0f, 1f)),
            NamedRoomBounds("Window_Frame_Sill_Pelmet", bounds(-4f, -0.5f, -1f, -3.9f, 1f, 1f))
        )

        val lights = RoomLightLayout.plan(room, parts)

        assertEquals(4, lights.size)
        assertEquals(3, lights.count { it.kind == RoomLightKind.CEILING })
        assertEquals(1, lights.count { it.kind == RoomLightKind.WINDOW })
        val lightY = 1f - RoomLightLayout.CEILING_DROP_M
        assertVecEquals(Vec3(0f, lightY, -1.5f), lights[0].position)
        assertVecEquals(Vec3(0f, lightY, 0.5f), lights[1].position)
        assertVecEquals(Vec3(0f, lightY, 2.5f), lights[2].position)
    }

    private fun path(vararg names: String) = names.map { RoomLightAncestor(it.hashCode(), it) }

    private fun assertVecEquals(expected: Vec3, actual: Vec3) {
        assertEquals(expected.x, actual.x, 1e-5f)
        assertEquals(expected.y, actual.y, 1e-5f)
        assertEquals(expected.z, actual.z, 1e-5f)
    }

    private fun Vec3.length() = sqrt(x * x + y * y + z * z)

    private fun bounds(minX: Float, minY: Float, minZ: Float, maxX: Float, maxY: Float, maxZ: Float) =
        RoomBounds(Vec3(minX, minY, minZ), Vec3(maxX, maxY, maxZ))
}
