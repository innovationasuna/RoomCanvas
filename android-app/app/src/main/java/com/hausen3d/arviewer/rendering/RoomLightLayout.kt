package com.hausen3d.arviewer.rendering

import kotlin.math.sqrt

data class Vec3(val x: Float, val y: Float, val z: Float)

data class RoomBounds(val min: Vec3, val max: Vec3) {
    val center: Vec3
        get() = Vec3(
            (min.x + max.x) * 0.5f,
            (min.y + max.y) * 0.5f,
            (min.z + max.z) * 0.5f
        )

    fun union(other: RoomBounds) = RoomBounds(
        min = Vec3(
            minOf(min.x, other.min.x),
            minOf(min.y, other.min.y),
            minOf(min.z, other.min.z)
        ),
        max = Vec3(
            maxOf(max.x, other.max.x),
            maxOf(max.y, other.max.y),
            maxOf(max.z, other.max.z)
        )
    )

    val diagonal: Float
        get() {
            val x = max.x - min.x
            val y = max.y - min.y
            val z = max.z - min.z
            return sqrt(x * x + y * y + z * z)
        }
}

data class NamedRoomBounds(
    val name: String,
    val bounds: RoomBounds,
    /** Outer-to-inner transform ancestors, excluding this renderable's own name. */
    val ancestors: List<String> = emptyList()
)

enum class RoomLightKind { CEILING, WINDOW }

data class RoomLightSpec(
    val kind: RoomLightKind,
    val position: Vec3,
    val direction: Vec3?,
    val watts: Float,
    val temperatureKelvin: Float,
    val falloff: Float
)

/** 局部灯使用 glTF 的 Y-up 坐标，优先从实际灯具与窗框布光。 */
object RoomLightLayout {
    const val CEILING_WATTS = 65f
    const val CEILING_TEMPERATURE_K = 4700f
    const val CEILING_DROP_M = 0.30f
    const val WINDOW_WATTS = 220f
    const val WINDOW_TEMPERATURE_K = 6500f
    const val WINDOW_INSET_M = 0.08f
    const val WINDOW_DOWN_TILT = 0.10f
    const val LIGHT_FALLOFF_MULTIPLIER = 2.0f

    private val windowGroup = Regex("^window(?:[_-]?\\d+)?", RegexOption.IGNORE_CASE)
    private val windowAncestor = Regex("^window(?:[_-]?\\d+)?(?:$|[_ .-])", RegexOption.IGNORE_CASE)
    private val windowCovering = Regex("drape|sheer|curtain|blind", RegexOption.IGNORE_CASE)
    private val windowHelper = Regex("bench|daylight|backdrop", RegexOption.IGNORE_CASE)
    private val ceilingPanel = Regex("^ceiling\\d+$", RegexOption.IGNORE_CASE)
    private val linearFixture = Regex("^linear light housing(?:\\.\\d+)?$", RegexOption.IGNORE_CASE)

    private fun excludedWindowPart(name: String): Boolean {
        if (windowHelper.containsMatchIn(name)) return true
        val covering = windowCovering.find(name) ?: return false
        // A complete window can include its blind in the same mesh. A separate
        // curtain/blind (including its own frame) must not enlarge the aperture.
        val frame = name.indexOf("frame", ignoreCase = true)
        return !(name.startsWith("window", ignoreCase = true) &&
            frame >= 0 && frame < covering.range.first)
    }

    private fun windowKey(part: NamedRoomBounds): String? {
        val path = part.ancestors + part.name
        if (path.any(::excludedWindowPart)) return null
        // Window1..8 can be leaves of Window0, rather than eight separate windows.
        // The outermost semantic root also includes unnamed renderable children.
        val root = part.ancestors.indexOfFirst { windowAncestor.containsMatchIn(it) }
            .takeIf { it >= 0 } ?: part.ancestors.size
        // A complete frame may itself be the named parent of anonymous meshes.
        // Normalize its suffix just as the original flat-name grouping did.
        val group = windowGroup.find(path[root])?.value ?: return null
        val groupPath = path.take(root) + group
        return groupPath.joinToString("\u0000") { it.lowercase() }
    }

    fun shellBounds(parts: List<NamedRoomBounds>, fallback: RoomBounds): RoomBounds {
        return parts.filter {
            it.name.startsWith("wall", ignoreCase = true) ||
                it.name.startsWith("floor", ignoreCase = true) ||
                ceilingPanel.matches(it.name)
        }.map { it.bounds }.reduceOrNull(RoomBounds::union) ?: fallback
    }

    fun plan(room: RoomBounds, parts: List<NamedRoomBounds>, maxLocalLights: Int = 4): List<RoomLightSpec> {
        if (maxLocalLights <= 0) return emptyList()
        val falloff = (room.diagonal * LIGHT_FALLOFF_MULTIPLIER).coerceAtLeast(1f)

        val ceilingParts = parts.filter { linearFixture.matches(it.name) }.ifEmpty {
            parts.filter { ceilingPanel.matches(it.name) }
        }
        val ceilingLights = ceilingParts.sortedBy { it.name }.map { part ->
            val center = part.bounds.center
            RoomLightSpec(
                kind = RoomLightKind.CEILING,
                position = Vec3(center.x, part.bounds.min.y - CEILING_DROP_M, center.z),
                direction = Vec3(0f, -1f, 0f),
                watts = CEILING_WATTS,
                temperatureKelvin = CEILING_TEMPERATURE_K,
                falloff = falloff
            )
        }

        val windowGroups = parts.mapNotNull { part -> windowKey(part)?.let { it to part } }
            .groupBy({ it.first }, { it.second }).toSortedMap()
        val windowLights = windowGroups.values.map { windowParts ->
            val bounds = windowParts.map { it.bounds }.reduce(RoomBounds::union)
            val center = bounds.center
            val roomCenter = room.center
            var inwardX = roomCenter.x - center.x
            var inwardZ = roomCenter.z - center.z
            val length = sqrt(inwardX * inwardX + inwardZ * inwardZ)
            if (length < 1e-6f) {
                inwardX = 0f
                inwardZ = 1f
            } else {
                inwardX /= length
                inwardZ /= length
            }
            val directionLength = sqrt(1f + WINDOW_DOWN_TILT * WINDOW_DOWN_TILT)
            RoomLightSpec(
                kind = RoomLightKind.WINDOW,
                position = Vec3(
                    center.x + inwardX * WINDOW_INSET_M,
                    center.y,
                    center.z + inwardZ * WINDOW_INSET_M
                ),
                direction = Vec3(
                    inwardX / directionLength,
                    -WINDOW_DOWN_TILT / directionLength,
                    inwardZ / directionLength
                ),
                watts = WINDOW_WATTS,
                temperatureKelvin = WINDOW_TEMPERATURE_K,
                falloff = falloff
            )
        }

        val ceilingBudget = if (windowLights.isEmpty()) maxLocalLights else maxLocalLights - 1
        return (ceilingLights.take(ceilingBudget) + windowLights).take(maxLocalLights)
    }
}
