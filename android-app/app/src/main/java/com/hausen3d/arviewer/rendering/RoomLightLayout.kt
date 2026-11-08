package com.hausen3d.arviewer.rendering

import kotlin.math.cos
import kotlin.math.sin
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

data class NamedRoomBounds(val name: String, val bounds: RoomBounds)

enum class RoomLightKind { CEILING, WINDOW }

data class RoomLightSpec(
    val kind: RoomLightKind,
    val position: Vec3,
    val direction: Vec3?,
    val watts: Float,
    val temperatureKelvin: Float,
    val falloff: Float,
    val bulbRadius: Float
)

/** 与 render_room_cameras.py 的 physical 灯光配方对应，坐标使用 glTF 的 Y-up。 */
object RoomLightLayout {
    const val CEILING_WATTS = 60f
    const val CEILING_TEMPERATURE_K = 4700f
    const val CEILING_DROP_M = 0.05f
    const val CEILING_BULB_RADIUS_M = 0.05f
    const val WINDOW_WATTS = 20f
    const val WINDOW_TEMPERATURE_K = 6500f
    const val WINDOW_INSET_M = 0.08f
    const val WINDOW_BULB_RADIUS_M = 0.20f
    const val SUN_ELEVATION_DEGREES = 40f
    const val SUN_ROTATION_DEGREES = 35f

    private val windowGroup = Regex("^window(?:[_-]?\\d+)?", RegexOption.IGNORE_CASE)

    fun sunDirection(): Vec3 {
        val elevation = Math.toRadians(SUN_ELEVATION_DEGREES.toDouble())
        val rotation = Math.toRadians(SUN_ROTATION_DEGREES.toDouble())
        return Vec3(
            (-cos(elevation) * sin(rotation)).toFloat(),
            (-sin(elevation)).toFloat(),
            (-cos(elevation) * cos(rotation)).toFloat()
        )
    }

    fun shellBounds(parts: List<NamedRoomBounds>, fallback: RoomBounds): RoomBounds {
        return parts.filter {
            it.name.startsWith("wall", ignoreCase = true) ||
                it.name.startsWith("floor", ignoreCase = true) ||
                it.name.startsWith("ceiling", ignoreCase = true)
        }.map { it.bounds }.reduceOrNull(RoomBounds::union) ?: fallback
    }

    fun plan(room: RoomBounds, parts: List<NamedRoomBounds>, maxLocalLights: Int = 4): List<RoomLightSpec> {
        if (maxLocalLights <= 0) return emptyList()
        val falloff = (room.diagonal * 1.5f).coerceAtLeast(1f)

        val ceilingLights = parts.filter {
            it.name.startsWith("ceiling", ignoreCase = true)
        }.map { part ->
            val center = part.bounds.center
            RoomLightSpec(
                kind = RoomLightKind.CEILING,
                position = Vec3(center.x, part.bounds.min.y - CEILING_DROP_M, center.z),
                direction = null,
                watts = CEILING_WATTS,
                temperatureKelvin = CEILING_TEMPERATURE_K,
                falloff = falloff,
                bulbRadius = CEILING_BULB_RADIUS_M
            )
        }

        val windowLights = parts.filter {
            it.name.startsWith("window", ignoreCase = true) &&
                !it.name.contains("drape|sheer|curtain|blind".toRegex(RegexOption.IGNORE_CASE))
        }.groupBy {
            windowGroup.find(it.name)?.value?.lowercase() ?: it.name.lowercase()
        }.values.map { windowParts ->
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
            val directionLength = sqrt(1f + 0.35f * 0.35f)
            RoomLightSpec(
                kind = RoomLightKind.WINDOW,
                position = Vec3(
                    center.x + inwardX * WINDOW_INSET_M,
                    center.y,
                    center.z + inwardZ * WINDOW_INSET_M
                ),
                direction = Vec3(inwardX / directionLength, -0.35f / directionLength, inwardZ / directionLength),
                watts = WINDOW_WATTS,
                temperatureKelvin = WINDOW_TEMPERATURE_K,
                falloff = falloff,
                bulbRadius = WINDOW_BULB_RADIUS_M
            )
        }

        return (ceilingLights + windowLights).take(maxLocalLights)
    }
}
