package com.hausen3d.arviewer.vr

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.util.Log

class DeviceMotionMonitor(context: Context) : SensorEventListener {

    companion object {
        private const val TAG = "DeviceMotionMonitor"
    }

    private val sensorManager = context.getSystemService(SensorManager::class.java)
    private val accelerationSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION)
    private val gyroSensor = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    private val detector = DeviceMotionDetector()
    private var started = false

    val hasRequiredSensors: Boolean
        get() = accelerationSensor != null && gyroSensor != null

    fun start() {
        if (started) return
        detector.reset()
        started = true
        if (accelerationSensor == null || gyroSensor == null) {
            Log.w(TAG, "缺少运动传感器：linearAcceleration=${accelerationSensor != null}, gyro=${gyroSensor != null}")
        }
        accelerationSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
        gyroSensor?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    fun stop() {
        if (!started) return
        sensorManager.unregisterListener(this)
        detector.reset()
        started = false
    }

    fun snapshot(): DeviceMotionState = detector.snapshot(SystemClock.elapsedRealtimeNanos())

    override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
            Sensor.TYPE_LINEAR_ACCELERATION -> detector.updateLinearAcceleration(
                event.values[0],
                event.values[1],
                event.values[2],
                event.timestamp
            )

            Sensor.TYPE_GYROSCOPE -> detector.updateGyroscope(
                event.values[0],
                event.values[1],
                event.values[2],
                event.timestamp
            )
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
