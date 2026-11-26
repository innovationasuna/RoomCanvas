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

data class RoomLightAncestor(val entityId: Int, val name: String)

data class NamedRoomBounds(
    val name: String,
    val bounds: RoomBounds,
    /** Outer-to-inner transform ancestors, excluding this renderable's own name. */
    val ancestors: List<RoomLightAncestor> = emptyList(),
    val entityId: Int? = null
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

    // This is the composite mesh used by the office sample, not any frame
    // whose name happens to contain a covering word later in the string.
    private val compositeWindow = Regex(
        "^window(?:[_-]?\\d+)?_frame_fixed_lights_sill_blind(?:\\.\\d+)?$",
        RegexOption.IGNORE_CASE
    )

    private fun excludedWindowPart(name: String): Boolean =
        windowHelper.containsMatchIn(name) ||
            (windowCovering.containsMatchIn(name) && !compositeWindow.matches(name))

    private data class WindowKey(val entityId: Int?, val name: String)

    private fun windowKey(part: NamedRoomBounds, ancestorEntities: Set<Int>): WindowKey? {
        val path = part.ancestors.map { it.name } + part.name
        val root = part.ancestors.indexOfFirst { windowAncestor.containsMatchIn(it.name) }
            .takeIf { it >= 0 } ?: part.ancestors.size
        // Outer containers such as CurtainWall do not describe a window covering.
        if (path.drop(root).any(::excludedWindowPart)) return null
        val group = windowGroup.find(path[root])?.value ?: return null
        val rootEntity = part.ancestors.getOrNull(root)?.entityId
            // A renderable window root and its descendants must share one group.
            ?: part.entityId?.takeIf { it in ancestorEntities }
        val rootName = if (rootEntity != null) path[root] else group
        val name = (path.take(root) + rootName).joinToString("\u0000") { it.lowercase() }
        return WindowKey(rootEntity, name)
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

        val ancestorEntities = parts.flatMap { it.ancestors }.map { it.entityId }.toSet()
        val windowGroups = parts.mapNotNull { part -> windowKey(part, ancestorEntities)?.let { it to part } }
            .groupBy({ it.first }, { it.second })
            .map { (key, group) -> key to group.map { it.bounds }.reduce(RoomBounds::union) }
            // Entity IDs identify groups but must not decide which lights survive
            // the budget: IDs may change when the same model is loaded again.
            .sortedWith(compareBy({ it.first.name },
                { it.second.min.x }, { it.second.min.y }, { it.second.min.z },
                { it.second.max.x }, { it.second.max.y }, { it.second.max.z }))
        val windowLights = windowGroups.map { (_, bounds) ->
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
