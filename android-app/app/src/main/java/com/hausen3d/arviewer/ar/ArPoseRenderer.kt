package com.hausen3d.arviewer.ar

import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.SystemClock
import android.util.Log
import com.huawei.hiar.ARFrame
import com.huawei.hiar.ARSession
import com.huawei.hiar.ARTrackable
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/** AR 相机位姿快照：GL 线程发布，主线程消费 */
class ArPoseSnapshot(
    /** 相机在世界坐标系中的位姿矩阵（列主序 4x4，OpenGL 约定） */
    val viewToWorld: FloatArray,
    val isTracking: Boolean
)

/**
 * 只取 AR Engine 位姿、不显示相机画面的 GL 渲染器。
 *
 * 与 [CameraBackgroundRenderer] 的区别：
 * - 不绘制 OES 相机纹理（VR 模式下屏幕显示的是虚拟房间，不是现实画面）；
 * - 不做平面检测、命中测试、Anchor；
 * - 只负责 `session.update()` 并把相机位姿发布给主线程。
 *
 * 仍保留一个 GLSurfaceView，是因为 AR Engine 的 update() 必须在有 EGL 上下文的线程调用。
 */
class ArPoseRenderer(
    private val displayRotationProvider: () -> Int
) : GLSurfaceView.Renderer {

    companion object {
        private const val TAG = "ArPoseRenderer"
        private val NOT_TRACKING = ArPoseSnapshot(FloatArray(16), false)
    }

    /** 主线程设置；必须先于 GLSurfaceView.onResume() */
    @Volatile
    var session: ARSession? = null

    /** 显示旋转或尺寸变化后置位，GL 线程下一帧重新 setDisplayGeometry */
    @Volatile
    var displayGeometryDirty: Boolean = true

    /** 最新位姿；跟踪丢失时保留最后一帧有效位姿并把 isTracking 置 false */
    val poseSnapshot = AtomicReference(NOT_TRACKING)

    /** AR 实际发布有效位姿的次数（GL 线程递增），用于真机确认位姿回调频率 */
    val poseCounter = AtomicInteger(0)

    /** onDrawFrame 调用次数（GL 线程递增），与 poseCounter 对比可看出 update() 是否卡住 */
    val frameCounter = AtomicInteger(0)

    /** 上一次发布的跟踪状态，仅 GL 线程访问，用于只在状态变化时打日志 */
    private var lastTrackingState = true

    /** 位姿对照日志的上次输出时间（GL 线程），1 Hz 限流 */
    private var lastPoseCmpLogAt = 0L
    private val rawPoseMatrix = FloatArray(16)
    private val orientedPoseMatrix = FloatArray(16)

    private var oesTextureId = 0
    private var surfaceWidth = 0
    private var surfaceHeight = 0

    /** 最后一次 TRACKING 的相机位姿，仅 GL 线程访问 */
    private val lastTrackingPose = FloatArray(16)

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        // 即使不绘制相机画面，也创建一个 OES 纹理交给 AR Engine 绑定，保证会话正常出帧
        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        oesTextureId = textures[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTextureId)
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_WRAP_S,
            GLES20.GL_CLAMP_TO_EDGE
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_WRAP_T,
            GLES20.GL_CLAMP_TO_EDGE
        )
        GLES20.glTexParameterf(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_MIN_FILTER,
            GLES20.GL_NEAREST.toFloat()
        )
        GLES20.glTexParameterf(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
            GLES20.GL_TEXTURE_MAG_FILTER,
            GLES20.GL_NEAREST.toFloat()
        )
        GLES20.glClearColor(0f, 0f, 0f, 1f)
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        GLES20.glViewport(0, 0, width, height)
        displayGeometryDirty = true
    }

    override fun onDrawFrame(gl: GL10?) {
        frameCounter.incrementAndGet()
        val currentSession = session
        if (currentSession == null) {
            clearSurface()
            return
        }
        try {
            if (displayGeometryDirty && surfaceWidth > 0 && surfaceHeight > 0) {
                currentSession.setDisplayGeometry(
                    displayRotationProvider(),
                    surfaceWidth,
                    surfaceHeight
                )
                displayGeometryDirty = false
            }
            currentSession.setCameraTextureName(oesTextureId)
            val frame: ARFrame = currentSession.update() ?: return
            publishPose(frame.camera, frame.timestampNs)
        } catch (t: Throwable) {
            Log.e(TAG, "AR 位姿帧处理异常", t)
        }
        clearSurface()
    }

    private fun publishPose(camera: com.huawei.hiar.ARCamera, frameTimestampNs: Long) {
        if (camera.trackingState == ARTrackable.TrackingState.TRACKING) {
            logPoseComparison(camera, frameTimestampNs)
            val matrix = FloatArray(16)
            // 必须用 display-oriented pose：raw pose 在 sensor 坐标系中，
            // 横屏时与屏幕坐标系相差 0° 或 180°，会把转头/平移方向弄反。
            camera.displayOrientedPose.toMatrix(matrix, 0)
            System.arraycopy(matrix, 0, lastTrackingPose, 0, 16)
            poseSnapshot.set(ArPoseSnapshot(matrix, true))
            val count = poseCounter.incrementAndGet()
            // 只在状态变化时打日志：EMUI 会去重相同内容，状态切换本身是关键证据
            if (!lastTrackingState) {
                lastTrackingState = true
                Log.i(TAG, "tracking=true (resume) poseFrames=$count")
            }
        } else {
            poseSnapshot.set(ArPoseSnapshot(lastTrackingPose.copyOf(), false))
            if (lastTrackingState) {
                lastTrackingState = false
                Log.i(TAG, "tracking=false (lost) poseFrames=${poseCounter.get()}")
            }
        }
    }

    /**
     * 每秒一条：同时输出 sensor 系原始位姿与 display-oriented 位姿的平移。
     *
     * 用途（2026-10-23 漂移排查）：手机静止时若两者一起发散，问题在 AR Engine / VIO 本身；
     * 只有 display-oriented 发散，则是我们的坐标换算或显示几何有问题。
     * frameAgeMs 用来确认消费的不是过期帧（正常应接近 0~50 ms）。
     */
    private fun logPoseComparison(camera: com.huawei.hiar.ARCamera, frameTimestampNs: Long) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPoseCmpLogAt < 1000L) return
        lastPoseCmpLogAt = now

        camera.pose.toMatrix(rawPoseMatrix, 0)
        camera.displayOrientedPose.toMatrix(orientedPoseMatrix, 0)
        val frameAgeMs = (System.nanoTime() - frameTimestampNs) / 1_000_000
        Log.i(
            TAG,
            "poseCmp raw=(${"%.3f".format(rawPoseMatrix[12])}, ${"%.3f".format(rawPoseMatrix[14])}) " +
                "oriented=(${"%.3f".format(orientedPoseMatrix[12])}, ${"%.3f".format(orientedPoseMatrix[14])}) " +
                "y=(${"%.3f".format(rawPoseMatrix[13])}, ${"%.3f".format(orientedPoseMatrix[13])}) " +
                "frameAgeMs=$frameAgeMs poseFrames=${poseCounter.get()}"
        )
    }

    private fun clearSurface() {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    }

    /** 主线程在 GLSurfaceView 暂停后调用，清除残留位姿 */
    fun reset() {
        poseSnapshot.set(NOT_TRACKING)
        lastTrackingPose.fill(0f)
        // 下次恢复时再打一条 "tracking=true (resume)"
        lastTrackingState = false
    }
}
