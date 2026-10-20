package com.hausen3d.arviewer.ar

import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.huawei.hiar.ARAnchor
import com.huawei.hiar.ARFrame
import com.huawei.hiar.ARPlane
import com.huawei.hiar.ARPoint
import com.huawei.hiar.ARSession
import com.huawei.hiar.ARTrackable
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/** 相机位姿/投影快照：GL 线程发布，主线程（SceneView.onFrame）消费 */
class CameraSnapshot(
    /** 相机在世界坐标系中的位姿矩阵（列主序 4x4，OpenGL 约定） */
    val viewToWorld: FloatArray,
    /** 投影矩阵（列主序 4x4，已含显示旋转适配） */
    val projection: FloatArray,
    val isTracking: Boolean
)

/** Anchor 位姿快照 */
class AnchorSnapshot(
    val poseMatrix: FloatArray,
    val isTracking: Boolean
)

/**
 * AR 相机背景渲染器（GLSurfaceView.Renderer）。
 *
 * 设计约束：**所有 hiar（AR Engine）调用只发生在 GL 线程**，主线程通过队列/原子变量与之通信：
 * - 创建 OES 外部纹理喂给 [ARSession.setCameraTextureName]，用着色器把相机画面画到全屏；
 * - 每帧 [ARSession.update]，发布相机位姿、投影矩阵、平面数量快照；
 * - 处理主线程排队的点击放置请求（命中测试 + 创建 Anchor），并逐帧发布 Anchor 位姿。
 *
 * 着色器与背景画法移植自华为官方示例（BackgroundTextureService / MatrixUtil / Constants）。
 */
class CameraBackgroundRenderer(
    /** 由 Activity 提供当前显示旋转（Surface.ROTATION_*），GL 线程读取 */
    private val displayRotationProvider: () -> Int
) : GLSurfaceView.Renderer {

    companion object {
        private const val TAG = "ArCameraRenderer"

        const val PROJ_NEAR = 0.1f
        const val PROJ_FAR = 100.0f

        private const val VERTEX_SHADER =
            "attribute vec4 vPosition;" +
                "attribute vec2 vCoord;" +
                "uniform mat4 vMatrix;" +
                "uniform mat4 vCoordMatrix;" +
                "varying vec2 textureCoordinate;" +
                "void main(){" +
                "    gl_Position = vMatrix*vPosition;" +
                "    textureCoordinate = (vCoordMatrix*vec4(vCoord,0,1)).xy;" +
                "}"

        private const val FRAGMENT_SHADER =
            "#extension GL_OES_EGL_image_external : require\n" +
                "precision mediump float;" +
                "varying vec2 textureCoordinate;" +
                "uniform samplerExternalOES vTexture;" +
                "void main() {" +
                "    gl_FragColor = texture2D(vTexture, textureCoordinate);" +
                "}"

        private val QUAD_VERTICES = floatArrayOf(-1f, 1f, -1f, -1f, 1f, 1f, 1f, -1f)
        private val QUAD_UVS = floatArrayOf(0f, 0f, 0f, 1f, 1f, 0f, 1f, 1f)

        /**
         * 官方示例 MatrixUtil.getProjectionMatrix 的等价常量：
         * ortho(-1,1,-1,1,1,3) * lookAt((0,0,1)->原点) 的乘积（列主序）。
         * 全屏四边形顶点 z=0 经此矩阵落到 NDC z=-1（近平面），不会被裁剪。
         */
        private val BACKGROUND_MATRIX = floatArrayOf(
            1f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f,
            0f, 0f, -1f, 0f,
            0f, 0f, -1f, 1f
        )

        private val NOT_TRACKING = CameraSnapshot(FloatArray(16), FloatArray(16), false)

        private fun directFloatBuffer(values: FloatArray? = null, capacity: Int = 8): FloatBuffer {
            val buffer = ByteBuffer.allocateDirect(capacity * 4)
                .order(ByteOrder.nativeOrder())
                .asFloatBuffer()
            if (values != null) {
                buffer.put(values)
                buffer.position(0)
            }
            return buffer
        }

        private fun compileShader(type: Int, source: String): Int {
            val shader = GLES20.glCreateShader(type)
            GLES20.glShaderSource(shader, source)
            GLES20.glCompileShader(shader)
            val status = IntArray(1)
            GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
            if (status[0] == 0) {
                val info = GLES20.glGetShaderInfoLog(shader)
                GLES20.glDeleteShader(shader)
                throw RuntimeException("着色器编译失败: $info")
            }
            return shader
        }
    }

    /** AR 会话，主线程在进入/退出 AR 模式时设置（先于 GLSurfaceView.onResume/onPause） */
    @Volatile
    var session: ARSession? = null

    /** 显示旋转或尺寸变化后置位，GL 线程下一帧重新 setDisplayGeometry */
    @Volatile
    var displayGeometryDirty: Boolean = true

    /** 相机位姿/投影快照（每帧更新，仅在 TRACKING 时含有效矩阵） */
    val cameraSnapshot = AtomicReference(NOT_TRACKING)

    /** Anchor 位姿快照；null 表示当前无 Anchor */
    val anchorSnapshot = AtomicReference<AnchorSnapshot?>(null)

    /** 当前跟踪中的平面数量（用于提示文案） */
    val planeCount = AtomicInteger(0)

    /** 是否存在有效 Anchor（STOPPED 会被自动清除） */
    val anchorActive = AtomicBoolean(false)

    /** 放置结果回调，在主线程触发：true=已命中并创建 Anchor */
    var onPlacementResult: ((Boolean) -> Unit)? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    /** 主线程排队的放置请求（屏幕像素坐标 x,y） */
    private val placementQueue = ArrayBlockingQueue<FloatArray>(4)

    private val clearAnchorRequested = AtomicBoolean(false)

    /** 当前 Anchor，仅 GL 线程访问 */
    private var anchor: ARAnchor? = null

    // ---- GL 资源（仅 GL 线程） ----
    private var oesTextureId = 0
    private var program = 0
    private var surfaceWidth = 0
    private var surfaceHeight = 0
    private val vertexBuffer = directFloatBuffer(QUAD_VERTICES)
    private val uvBuffer = directFloatBuffer(QUAD_UVS)
    // 预填默认 UV，即使首帧 hasDisplayGeometryChanged 未置位也有可用坐标
    private val uvTransformedBuffer = directFloatBuffer(QUAD_UVS)

    /** 主线程调用：请求在屏幕坐标 (x, y) 处做命中测试并放置 Anchor */
    fun requestPlacement(x: Float, y: Float) {
        placementQueue.offer(floatArrayOf(x, y))
    }

    /** 主线程调用：清除当前 Anchor（在 GL 线程下一帧执行，避免跨线程触碰 hiar 对象） */
    fun requestClearAnchor() {
        clearAnchorRequested.set(true)
    }

    /**
     * 主线程调用（须在 GLSurfaceView 已暂停、GL 线程空闲后）：清空全部 AR 状态。
     * 用于退出 AR 模式，防止残留的点击队列/旧 Anchor 影响下一次会话。
     * 注意：不在此 detach Anchor——调用方随后会 stop() 会话，Anchor 随会话释放。
     */
    fun reset() {
        placementQueue.clear()
        clearAnchorRequested.set(false)
        anchor = null
        cameraSnapshot.set(NOT_TRACKING)
        anchorSnapshot.set(null)
        planeCount.set(0)
        anchorActive.set(false)
    }

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        initGl()
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        surfaceWidth = width
        surfaceHeight = height
        GLES20.glViewport(0, 0, width, height)
        displayGeometryDirty = true
    }

    override fun onDrawFrame(gl: GL10?) {
        val session = session
        if (session == null) {
            GLES20.glClearColor(0.1f, 0.1f, 0.1f, 1.0f)
            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
            return
        }
        try {
            if (displayGeometryDirty) {
                session.setDisplayGeometry(displayRotationProvider(), surfaceWidth, surfaceHeight)
                displayGeometryDirty = false
            }
            session.setCameraTextureName(oesTextureId)
            val frame = session.update()
            renderBackground(frame)
            publishCameraState(session, frame)
            processClearAnchor()
            processPlacementQueue(frame)
            publishAnchorState()
        } catch (t: Throwable) {
            Log.e(TAG, "GL 帧处理异常", t)
        }
    }

    // ---------------- 内部实现（GL 线程） ----------------

    private fun initGl() {
        val textures = IntArray(1)
        GLES20.glGenTextures(1, textures, 0)
        oesTextureId = textures[0]
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTextureId)
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE
        )
        GLES20.glTexParameteri(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE
        )
        GLES20.glTexParameterf(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_NEAREST.toFloat()
        )
        GLES20.glTexParameterf(
            GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_NEAREST.toFloat()
        )

        val vertexShader = compileShader(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER)
        val fragmentShader = compileShader(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
        program = GLES20.glCreateProgram()
        GLES20.glAttachShader(program, vertexShader)
        GLES20.glAttachShader(program, fragmentShader)
        GLES20.glLinkProgram(program)
        val status = IntArray(1)
        GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
        if (status[0] == 0) {
            throw RuntimeException("着色器链接失败: " + GLES20.glGetProgramInfoLog(program))
        }
        GLES20.glDeleteShader(vertexShader)
        GLES20.glDeleteShader(fragmentShader)
        GLES20.glClearColor(0.1f, 0.1f, 0.1f, 1.0f)
    }

    /** 把相机画面绘制为全屏背景（官方示例 BackgroundTextureService 的精简移植） */
    private fun renderBackground(frame: ARFrame) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        // 显示几何变化时（含首帧）重算 UV 映射，保证画面方向正确、比例裁切正确
        if (frame.hasDisplayGeometryChanged()) {
            uvBuffer.position(0)
            frame.transformDisplayUvCoords(uvBuffer, uvTransformedBuffer)
            uvTransformedBuffer.position(0)
        }
        GLES20.glDisable(GLES20.GL_DEPTH_TEST)
        GLES20.glDepthMask(false)

        GLES20.glUseProgram(program)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTextureId)

        val matrixHandle = GLES20.glGetUniformLocation(program, "vMatrix")
        val coordMatrixHandle = GLES20.glGetUniformLocation(program, "vCoordMatrix")
        val textureHandle = GLES20.glGetUniformLocation(program, "vTexture")
        val positionHandle = GLES20.glGetAttribLocation(program, "vPosition")
        val coordHandle = GLES20.glGetAttribLocation(program, "vCoord")

        val identity = floatArrayOf(
            1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f
        )
        GLES20.glUniformMatrix4fv(matrixHandle, 1, false, BACKGROUND_MATRIX, 0)
        GLES20.glUniformMatrix4fv(coordMatrixHandle, 1, false, identity, 0)
        GLES20.glUniform1i(textureHandle, 0)

        vertexBuffer.position(0)
        GLES20.glEnableVertexAttribArray(positionHandle)
        GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, vertexBuffer)
        uvTransformedBuffer.position(0)
        GLES20.glEnableVertexAttribArray(coordHandle)
        GLES20.glVertexAttribPointer(coordHandle, 2, GLES20.GL_FLOAT, false, 0, uvTransformedBuffer)

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(positionHandle)
        GLES20.glDisableVertexAttribArray(coordHandle)
        GLES20.glDepthMask(true)
        GLES20.glEnable(GLES20.GL_DEPTH_TEST)
    }

    private fun publishCameraState(session: ARSession, frame: ARFrame) {
        val camera = frame.camera
        val tracking = camera.trackingState == ARTrackable.TrackingState.TRACKING
        if (tracking) {
            val viewToWorld = FloatArray(16)
            camera.pose.toMatrix(viewToWorld, 0)
            val projection = FloatArray(16)
            camera.getProjectionMatrix(projection, 0, PROJ_NEAR, PROJ_FAR)
            cameraSnapshot.set(CameraSnapshot(viewToWorld, projection, true))
        } else {
            cameraSnapshot.set(NOT_TRACKING)
        }
        var count = 0
        for (plane in session.getAllTrackables(ARPlane::class.java)) {
            if (plane.trackingState == ARTrackable.TrackingState.TRACKING) count++
        }
        planeCount.set(count)
    }

    private fun processClearAnchor() {
        if (clearAnchorRequested.compareAndSet(true, false)) {
            anchor?.detach()
            anchor = null
            anchorActive.set(false)
            anchorSnapshot.set(null)
        }
    }

    private fun processPlacementQueue(frame: ARFrame) {
        val request = placementQueue.poll() ?: return
        var placed = false
        for (hit in frame.hitTest(request[0], request[1])) {
            val trackable = hit.trackable ?: continue
            // 优先命中平面多边形内部；其次接受带表面法向的特征点（官方示例同款策略）
            val isPlaneHit = trackable is ARPlane && trackable.isPoseInPolygon(hit.hitPose)
            val isPointHit = trackable is ARPoint &&
                trackable.orientationMode == ARPoint.OrientationMode.ESTIMATED_SURFACE_NORMAL
            if (isPlaneHit || isPointHit) {
                anchor?.detach()
                anchor = hit.createAnchor()
                anchorActive.set(true)
                placed = true
                if (trackable is ARPlane) break
            }
        }
        mainHandler.post { onPlacementResult?.invoke(placed) }
    }

    private fun publishAnchorState() {
        val current = anchor ?: return
        when (current.trackingState) {
            ARTrackable.TrackingState.TRACKING -> {
                val matrix = FloatArray(16)
                current.pose.toMatrix(matrix, 0)
                anchorSnapshot.set(AnchorSnapshot(matrix, true))
            }
            ARTrackable.TrackingState.STOPPED -> {
                current.detach()
                anchor = null
                anchorActive.set(false)
                anchorSnapshot.set(null)
            }
            else -> {
                // PAUSED：保留上一帧快照，主线程按 isTracking 状态提示
                anchorSnapshot.get()?.let { anchorSnapshot.set(AnchorSnapshot(it.poseMatrix, false)) }
            }
        }
    }
}
