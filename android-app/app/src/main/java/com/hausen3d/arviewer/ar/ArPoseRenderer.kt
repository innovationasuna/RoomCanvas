package com.hausen3d.arviewer.ar

import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.util.Log
import com.huawei.hiar.ARFrame
import com.huawei.hiar.ARSession
import com.huawei.hiar.ARTrackable
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
            publishPose(frame.camera)
        } catch (t: Throwable) {
            Log.e(TAG, "AR 位姿帧处理异常", t)
        }
        clearSurface()
    }

    private fun publishPose(camera: com.huawei.hiar.ARCamera) {
        if (camera.trackingState == ARTrackable.TrackingState.TRACKING) {
            val matrix = FloatArray(16)
            // 必须用 display-oriented pose：raw pose 在 sensor 坐标系中，
            // 横屏时与屏幕坐标系相差 0° 或 180°，会把转头/平移方向弄反。
            camera.displayOrientedPose.toMatrix(matrix, 0)
            System.arraycopy(matrix, 0, lastTrackingPose, 0, 16)
            poseSnapshot.set(ArPoseSnapshot(matrix, true))
        } else {
            poseSnapshot.set(ArPoseSnapshot(lastTrackingPose.copyOf(), false))
        }
    }

    private fun clearSurface() {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    }

    /** 主线程在 GLSurfaceView 暂停后调用，清除残留位姿 */
    fun reset() {
        poseSnapshot.set(NOT_TRACKING)
        lastTrackingPose.fill(0f)
    }
}
