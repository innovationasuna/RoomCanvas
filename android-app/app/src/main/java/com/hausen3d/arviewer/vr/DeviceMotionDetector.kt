package com.hausen3d.arviewer.vr

import kotlin.math.exp
import kotlin.math.sqrt

data class DeviceMotionState(
    val translationActive: Boolean = false,
    val rotationActive: Boolean = false,
    val linearAccelerationMps2: Float = 0f,
    val angularVelocityRadS: Float = 0f
)

/**
 * 用独立于 AR Engine 的 IMU 判断设备是否真的在移动。
 *
 * 短暂持续的运动才打开对应通道，运动后保留一小段时间，避免步行周期让通道频繁断开。
 */
class DeviceMotionDetector {

    companion object {
        const val LINEAR_ACCELERATION_THRESHOLD_MPS2 = 0.30f
        const val ANGULAR_VELOCITY_THRESHOLD_RAD_S = 0.04f

        private const val SIGNAL_SMOOTH_PER_S = 12f
        private const val MS_TO_NS = 1_000_000L
        private const val TRANSLATION_ENTER_NS = 60L * MS_TO_NS
        private const val TRANSLATION_EXIT_NS = 450L * MS_TO_NS
        private const val ROTATION_ENTER_NS = 40L * MS_TO_NS
        private const val ROTATION_EXIT_NS = 150L * MS_TO_NS
    }

    private class EvidenceChannel {
        private var aboveSinceNs: Long? = null
        private var activeUntilNs = 0L

        fun update(aboveThreshold: Boolean, timestampNs: Long, enterNs: Long, exitNs: Long) {
            if (!aboveThreshold) {
                aboveSinceNs = null
                return
            }

            if (isActive(timestampNs)) {
                activeUntilNs = timestampNs + exitNs
                aboveSinceNs = null
                return
            }

            val since = aboveSinceNs
            if (since == null) {
                aboveSinceNs = timestampNs
            } else if (timestampNs - since >= enterNs) {
                activeUntilNs = timestampNs + exitNs
                aboveSinceNs = null
            }
        }

        fun isActive(timestampNs: Long): Boolean = timestampNs <= activeUntilNs

        fun reset() {
            aboveSinceNs = null
            activeUntilNs = 0L
        }
    }

    private val translation = EvidenceChannel()
    private val rotation = EvidenceChannel()

    private var lastAccelerationTimestampNs = 0L
    private var lastGyroTimestampNs = 0L
    private var smoothedAcceleration = 0f
    private var smoothedAngularVelocity = 0f

    fun updateLinearAcceleration(x: Float, y: Float, z: Float, timestampNs: Long) {
        if (timestampNs <= lastAccelerationTimestampNs) return
        val magnitude = sqrt(x * x + y * y + z * z)
        smoothedAcceleration = smooth(
            smoothedAcceleration,
            magnitude,
            lastAccelerationTimestampNs,
            timestampNs
        )
        lastAccelerationTimestampNs = timestampNs
        translation.update(
            magnitude >= LINEAR_ACCELERATION_THRESHOLD_MPS2 &&
                smoothedAcceleration >= LINEAR_ACCELERATION_THRESHOLD_MPS2,
            timestampNs,
            TRANSLATION_ENTER_NS,
            TRANSLATION_EXIT_NS
        )
    }

    fun updateGyroscope(x: Float, y: Float, z: Float, timestampNs: Long) {
        if (timestampNs <= lastGyroTimestampNs) return
        val magnitude = sqrt(x * x + y * y + z * z)
        smoothedAngularVelocity = smooth(
            smoothedAngularVelocity,
            magnitude,
            lastGyroTimestampNs,
            timestampNs
        )
        lastGyroTimestampNs = timestampNs
        rotation.update(
            magnitude >= ANGULAR_VELOCITY_THRESHOLD_RAD_S &&
                smoothedAngularVelocity >= ANGULAR_VELOCITY_THRESHOLD_RAD_S,
            timestampNs,
            ROTATION_ENTER_NS,
            ROTATION_EXIT_NS
        )
    }

    fun snapshot(timestampNs: Long): DeviceMotionState = DeviceMotionState(
        translationActive = translation.isActive(timestampNs),
        rotationActive = rotation.isActive(timestampNs),
        linearAccelerationMps2 = smoothedAcceleration,
        angularVelocityRadS = smoothedAngularVelocity
    )

    fun reset() {
        translation.reset()
        rotation.reset()
        lastAccelerationTimestampNs = 0L
        lastGyroTimestampNs = 0L
        smoothedAcceleration = 0f
        smoothedAngularVelocity = 0f
    }

    private fun smooth(previous: Float, value: Float, previousTimestampNs: Long, timestampNs: Long): Float {
        if (previousTimestampNs == 0L) return value
        val dt = ((timestampNs - previousTimestampNs) / 1_000_000_000f).coerceIn(0f, 0.1f)
        val alpha = 1f - exp(-SIGNAL_SMOOTH_PER_S * dt)
        return previous + (value - previous) * alpha
    }
}
