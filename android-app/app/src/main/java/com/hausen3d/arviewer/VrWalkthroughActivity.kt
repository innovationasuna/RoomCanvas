package com.hausen3d.arviewer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.hausen3d.arviewer.ar.ArPoseRenderer
import com.hausen3d.arviewer.ar.toMat4
import com.hausen3d.arviewer.databinding.ActivityVrWalkthroughBinding
import com.hausen3d.arviewer.vr.VrCameraController
import com.hausen3d.arviewer.vr.VrTouchControlsView
import com.google.android.filament.Camera
import com.huawei.hiar.ARConfigBase
import com.huawei.hiar.AREnginesApk
import com.huawei.hiar.ARSession
import com.huawei.hiar.ARWorldTrackingConfig
import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import io.github.sceneview.node.ModelNode
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.abs

/**
 * 房间漫游（手持版）：手机横屏当作游戏机，第一人称走在重建出来的房间模型内部。
 *
 * 与 2026-10-17 头显版的区别：
 * - 不再靠音频键/倒计时主控；屏幕左下方向键 + 右半屏滑动转向；
 * - AR Engine 仍是可选的“位姿传感器”：菜单可关闭，关闭后暂停会话、释放相机；
 * - 相机由 [VrCameraController] 的虚拟状态每帧合成，按键与真实走动叠加；
 * - 跟踪丢失时只冻结 AR 增量，按键与滑动继续响应。
 *
 * 音量键保留为调试快捷键：+ 重新居中、- 短按回起点、长按退出。
 */
class VrWalkthroughActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "VrWalkthrough"

        const val EXTRA_MODEL_PATH = "model_path"
        const val EXTRA_MODEL_ASSET = "model_asset"

        /** 人眼高度（米） */
        private const val EYE_HEIGHT_M = 1.6f

        /** 真实 1 米 = 虚拟 1 米 */
        private const val MOVE_GAIN = 1.0f

        private const val VERTICAL_FOV_DEG = 80.0
        private const val NEAR_PLANE = 0.05f
        private const val FAR_PLANE = 100f

        private const val LONG_PRESS_MS = 1_200L
        private const val MENU_AUTO_HIDE_MS = 4_000L

        /** 切后台 / GC 卡顿后的单帧时间上限，防止位移瞬移 */
        private const val MAX_FRAME_DT_S = 0.05f
    }

    private lateinit var binding: ActivityVrWalkthroughBinding

    private lateinit var poseRenderer: ArPoseRenderer
    private var arSession: ARSession? = null
    private var sessionResumed = false

    private var modelNode: ModelNode? = null
    private var cameraController: VrCameraController? = null

    /** 真实走动（AR 位姿跟踪）是否启用；菜单可切换 */
    private var trackingEnabled = true

    private var started = false
    private var lastFrameMs = 0L
    private var latestArPose: Mat4? = null

    /**
     * 下一次有效位姿到来时重建 AR 参考：跟踪丢失恢复、屏幕方向变化、重新开启跟踪。
     */
    private var needsReanchor = false

    private var projectionAspect = 0.0

    private var volumeDownAt = 0L
    private var lastStatusAt = 0L
    private var lastStartHintAt = 0L
    private var lastPoseLogAt = 0L
    private var realWalkHintShown = false
    private var arEngineDialogShown = false
    private var suppressSwitchCallback = false

    private val speedScales = floatArrayOf(0.5f, 1f, 2f)
    private var speedIndex = 1

    private val handler = Handler(Looper.getMainLooper())
    private val exitRunnable = Runnable { finish() }
    private val menuHideRunnable = Runnable { setMenuOpen(false) }

    private val displayManager by lazy { getSystemService(DisplayManager::class.java) }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            poseRenderer.displayGeometryDirty = true
            // display-oriented pose 的坐标系随屏幕旋转变化，必须重建参考
            if (started) needsReanchor = true
        }
    }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                if (trackingEnabled) startArSessionIfPossible(resumeAfterCreate = true)
            } else {
                // 相机权限只影响真实走动；按键与滑动漫游仍可用
                trackingEnabled = false
                setRealWalkChecked(false)
                Toast.makeText(
                    this,
                    "未授权相机：只能使用方向键和滑动漫游",
                    Toast.LENGTH_LONG
                ).show()
                updateStartHint()
            }
        }

    // ---------------- 生命周期 ----------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enterImmersiveMode()

        binding = ActivityVrWalkthroughBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.sceneView.setZOrderMediaOverlay(true)
        // 漫游期间不使用 SceneView 自带的轨道相机手势
        binding.sceneView.cameraManipulator = null

        loadRoomModel()
        loadEnvironment()
        initPoseRenderer()
        initControls()

        // 先摆到房间起点，开始前就能看到室内
        cameraController?.let {
            binding.sceneView.cameraNode.worldTransform = it.initialCameraPose()
        }
        binding.vrTouchControls.inputEnabled = false
        updateStartHint(force = true)
    }

    override fun onResume() {
        super.onResume()
        if (!::binding.isInitialized) return

        if (!started) {
            // 从后台回来重新进入“开始漫游”状态，避免用过期参考位姿
            cameraController?.resetToStart(null)
            cameraController?.let {
                binding.sceneView.cameraNode.worldTransform = it.initialCameraPose()
            }
            binding.startOverlay.visibility = View.VISIBLE
            binding.vrTouchControls.inputEnabled = false
        }

        if (!trackingEnabled) {
            updateStartHint()
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
            return
        }
        startArSessionIfPossible(resumeAfterCreate = false)
        updateStartHint()
    }

    override fun onPause() {
        if (::binding.isInitialized) {
            started = false
            lastFrameMs = 0L
            binding.vrTouchControls.clearTouches()
            binding.vrTouchControls.inputEnabled = false
            binding.startOverlay.visibility = View.VISIBLE
            binding.menuPanel.visibility = View.GONE
            handler.removeCallbacks(menuHideRunnable)
        }
        pauseArPump()
        super.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        poseRenderer.session = null
        arSession?.stop()
        arSession = null
        if (::binding.isInitialized) {
            binding.sceneView.destroy()
        }
        super.onDestroy()
    }

    private fun enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply { screenBrightness = 1f }
    }

    // ---------------- 初始化 ----------------

    private fun loadRoomModel() {
        val assetPath = intent.getStringExtra(EXTRA_MODEL_ASSET)
        val filePath = intent.getStringExtra(EXTRA_MODEL_PATH)

        val instance = try {
            when {
                assetPath != null -> binding.sceneView.modelLoader.createModelInstance(assetPath)
                filePath != null ->
                    binding.sceneView.modelLoader.createModelInstance(File(filePath))
                else -> null
            }
        } catch (e: Exception) {
            Log.e(TAG, "模型加载失败", e)
            null
        }

        if (instance == null) {
            Toast.makeText(this, "没有可加载的模型", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        val node = ModelNode(modelInstance = instance)
        binding.sceneView.addChildNode(node)
        modelNode = node

        // 用模型包围盒自动定地面与人眼高度。重建模型的 y=0 不一定在地面，
        // 例如 Room-nonagent.glb 的地面在 y=-1.595m，所以不能假设原点即地面。
        val box = node.boundingBox
        val minY = box.center[1] - box.halfExtent[1]
        val centerX = box.center[0]
        val centerZ = box.center[2]
        val sizeX = box.halfExtent[0] * 2f
        val sizeY = box.halfExtent[1] * 2f
        val sizeZ = box.halfExtent[2] * 2f

        val eyeY = minY + EYE_HEIGHT_M
        // 默认视线朝向房间较长的一条水平轴，看到更开阔的室内
        val yawDeg = if (sizeX >= sizeZ) 90f else 0f

        cameraController = VrCameraController(
            startPosition = Float3(centerX, eyeY, centerZ),
            startYawDegrees = yawDeg,
            roomMinX = centerX - sizeX * 0.5f,
            roomMaxX = centerX + sizeX * 0.5f,
            roomMinZ = centerZ - sizeZ * 0.5f,
            roomMaxZ = centerZ + sizeZ * 0.5f,
            moveGain = MOVE_GAIN
        )

        Log.i(
            TAG,
            "房间包围盒 size=(${sizeX}, ${sizeY}, ${sizeZ}) minY=$minY " +
                "起点=($centerX, $eyeY, $centerZ) yaw=$yawDeg"
        )

        if (sizeX < 1f || sizeZ < 1f || sizeY < 1f) {
            Toast.makeText(
                this,
                "当前模型尺寸较小（${"%.2f".format(sizeX)}×${"%.2f".format(sizeZ)}m），" +
                    "按 1:1 进入可能看不到房间内容",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    private fun loadEnvironment() {
        lifecycleScope.launch {
            val environment = binding.sceneView.environmentLoader
                .loadHDREnvironment("environments/studio_small_09_2k.hdr")
            binding.sceneView.indirectLight = environment?.indirectLight
            binding.sceneView.skybox = environment?.skybox
        }
    }

    private fun initPoseRenderer() {
        poseRenderer = ArPoseRenderer { currentDisplayRotation() }
        binding.arPoseView.apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setEGLConfigChooser(8, 8, 8, 8, 16, 0)
            setRenderer(poseRenderer)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
        binding.sceneView.onFrame = { onSceneFrame() }
    }

    private fun initControls() {
        binding.btnStart.setOnClickListener { startWalkthrough() }

        binding.vrTouchControls.listener = VrTouchControlsView.Listener { dx, dy ->
            cameraController?.applyLookDelta(dx, dy)
        }

        binding.btnMenu.setOnClickListener {
            setMenuOpen(binding.menuPanel.visibility != View.VISIBLE)
        }
        binding.btnRecenter.setOnClickListener {
            recenter()
            resetMenuTimer()
        }
        binding.btnReset.setOnClickListener {
            resetToStart()
            resetMenuTimer()
        }
        binding.btnExitVr.setOnClickListener { finish() }
        binding.btnSpeed.setOnClickListener {
            cycleSpeed()
            resetMenuTimer()
        }
        binding.switchRealWalk.setOnCheckedChangeListener { _, checked ->
            if (suppressSwitchCallback) return@setOnCheckedChangeListener
            setTrackingEnabled(checked)
            resetMenuTimer()
        }
    }

    // ---------------- 开始 / 菜单 ----------------

    private fun startWalkthrough() {
        val controller = cameraController ?: return
        controller.resetToStart(null)
        controller.speedScale = speedScales[speedIndex]

        val snapshot = poseRenderer.poseSnapshot.get()
        if (trackingEnabled && snapshot.isTracking) {
            val arPose = snapshot.viewToWorld.toMat4()
            controller.attachArReference(arPose)
            latestArPose = arPose
            needsReanchor = false
        } else {
            // 等第一帧有效位姿到来时再建立参考（保持当前视角）
            needsReanchor = trackingEnabled
        }

        started = true
        lastFrameMs = 0L
        binding.startOverlay.visibility = View.GONE
        binding.vrTouchControls.inputEnabled = binding.menuPanel.visibility != View.VISIBLE
        binding.sceneView.cameraNode.worldTransform = controller.cameraPose()

        if (binding.switchRealWalk.isChecked && !realWalkHintShown) {
            realWalkHintShown = true
            Toast.makeText(this, "走动时请留意现实环境", Toast.LENGTH_LONG).show()
        }
        showStatus("左下方向键移动 · 右半屏滑动转向 · 右上角菜单")
    }

    private fun setMenuOpen(open: Boolean) {
        binding.menuPanel.visibility = if (open) View.VISIBLE else View.GONE
        binding.vrTouchControls.inputEnabled = started && !open
        if (open) {
            resetMenuTimer()
        } else {
            handler.removeCallbacks(menuHideRunnable)
        }
    }

    private fun resetMenuTimer() {
        handler.removeCallbacks(menuHideRunnable)
        if (binding.menuPanel.visibility == View.VISIBLE) {
            handler.postDelayed(menuHideRunnable, MENU_AUTO_HIDE_MS)
        }
    }

    private fun cycleSpeed() {
        speedIndex = (speedIndex + 1) % speedScales.size
        val scale = speedScales[speedIndex]
        cameraController?.speedScale = scale
        binding.btnSpeed.text = "速度 ${"%.1f".format(scale)}×"
    }

    // ---------------- 真实走动开关 ----------------

    private fun setTrackingEnabled(enabled: Boolean) {
        trackingEnabled = enabled
        if (enabled) {
            if (!realWalkHintShown) {
                realWalkHintShown = true
                Toast.makeText(this, "走动时请留意现实环境", Toast.LENGTH_LONG).show()
            }
            if (checkSelfPermission(Manifest.permission.CAMERA) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                return
            }
            startArSessionIfPossible(resumeAfterCreate = false)
            needsReanchor = true
            showStatus("已开启真实走动")
        } else {
            pauseArPump()
            // 把当前 AR 贡献折算进基准，画面不跳变
            cameraController?.detachAr()
            needsReanchor = false
            showStatus("已关闭真实走动：可继续用方向键和滑动")
        }
        updateStartHint(force = true)
    }

    private fun setRealWalkChecked(checked: Boolean) {
        suppressSwitchCallback = true
        binding.switchRealWalk.isChecked = checked
        suppressSwitchCallback = false
    }

    // ---------------- AR 会话 ----------------

    /**
     * @param resumeAfterCreate 权限弹窗回调里调用时为 true：此时 onResume 已执行过，
     *                          需要在这里补做 resume + GLSurfaceView.onResume。
     */
    private fun startArSessionIfPossible(resumeAfterCreate: Boolean) {
        if (!AREnginesApk.isAREngineApkReady(this)) {
            onArEngineMissing()
            return
        }

        if (arSession == null) {
            try {
                val session = ARSession(applicationContext)
                val config = ARWorldTrackingConfig(session).apply {
                    focusMode = ARConfigBase.FocusMode.AUTO_FOCUS
                    // VR 漫游不需要平面/Anchor，关掉可省 CPU
                    planeFindingMode = ARConfigBase.PlaneFindingMode.DISABLED
                    lightingMode = ARConfigBase.LIGHT_MODE_NONE
                }
                session.configure(config)
                arSession = session
                poseRenderer.session = session
                poseRenderer.displayGeometryDirty = true
            } catch (e: Exception) {
                Log.e(TAG, "AR 会话启动失败", e)
                Toast.makeText(this, "AR 会话启动失败：${e.message}", Toast.LENGTH_LONG).show()
                trackingEnabled = false
                setRealWalkChecked(false)
                updateStartHint(force = true)
                return
            }
        }

        if (sessionResumed) return
        try {
            arSession?.resume()
        } catch (e: Exception) {
            Log.e(TAG, "相机打开失败", e)
            Toast.makeText(this, "相机打开失败：${e.message}", Toast.LENGTH_LONG).show()
            trackingEnabled = false
            setRealWalkChecked(false)
            updateStartHint(force = true)
            return
        }
        binding.arPoseView.onResume()
        displayManager.registerDisplayListener(displayListener, null)
        sessionResumed = true

        if (resumeAfterCreate && started) {
            needsReanchor = true
        }
    }

    private fun pauseArPump() {
        if (!sessionResumed) return
        displayManager.unregisterDisplayListener(displayListener)
        // 先停 GL 线程（阻塞至空闲），再停会话，避免跨线程访问
        binding.arPoseView.onPause()
        poseRenderer.reset()
        try {
            arSession?.pause()
        } catch (e: Exception) {
            Log.w(TAG, "AR 会话暂停失败", e)
        }
        sessionResumed = false
    }

    private fun onArEngineMissing() {
        trackingEnabled = false
        setRealWalkChecked(false)
        updateStartHint(force = true)
        if (arEngineDialogShown) return
        arEngineDialogShown = true

        AlertDialog.Builder(this)
            .setTitle("需要华为 AR Engine 服务")
            .setMessage(
                "真实走动依赖 AR Engine 的运动跟踪。未安装/未启用时仍可用方向键和滑动漫游。"
            )
            .setPositiveButton("去应用市场") { _, _ ->
                try {
                    startActivity(
                        Intent("com.huawei.appmarket.intent.action.AppDetail").apply {
                            putExtra("APP_PACKAGENAME", "com.huawei.arengine.service")
                            setPackage("com.huawei.appmarket")
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                    )
                } catch (_: Exception) {
                    Toast.makeText(this, "未找到华为应用市场", Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton("仅用方向键") { _, _ -> }
            .show()
    }

    // ---------------- 每帧：输入 + 位姿 → 相机 ----------------

    private fun onSceneFrame() {
        updateProjectionIfNeeded()

        val now = SystemClock.elapsedRealtime()
        val dt = if (lastFrameMs == 0L) {
            0f
        } else {
            ((now - lastFrameMs) / 1000f).coerceIn(0f, MAX_FRAME_DT_S)
        }
        lastFrameMs = now

        if (!started) {
            updateStartHint()
            return
        }

        val controller = cameraController ?: return

        // 方向键：每帧读取当前按压状态（多指并集）
        controller.applyMoveInput(
            binding.vrTouchControls.moveForward,
            binding.vrTouchControls.moveStrafe,
            dt
        )

        val snapshot = poseRenderer.poseSnapshot.get()
        if (trackingEnabled) {
            if (snapshot.isTracking) {
                val arPose = snapshot.viewToWorld.toMat4()
                when {
                    // 跟踪恢复 / 重新开启 / 屏幕旋转：保持当前视角，重建参考
                    needsReanchor -> {
                        controller.reanchorKeepingView(arPose)
                        needsReanchor = false
                    }

                    !controller.hasArReference -> controller.attachArReference(arPose)
                    else -> controller.updateArPose(arPose)
                }
                latestArPose = arPose
                hideStatusIfNeeded()
            } else {
                // 只冻结 AR 增量（t_ar、ψ_ar 保持上一帧），按键与滑动照常更新
                needsReanchor = true
                showStatusThrottled(
                    if (controller.hasArReference) {
                        "跟踪丢失：可继续用方向键和滑动移动"
                    } else {
                        "等待 AR 跟踪…可先用方向键移动"
                    }
                )
            }
        } else {
            hideStatusIfNeeded()
        }

        val cameraPose = controller.cameraPose()
        binding.sceneView.cameraNode.worldTransform = cameraPose
        logPoseThrottled(cameraPose, controller)
    }

    private fun updateProjectionIfNeeded() {
        val width = binding.sceneView.width
        val height = binding.sceneView.height
        if (width <= 0 || height <= 0) return
        val aspect = width.toDouble() / height
        if (abs(aspect - projectionAspect) > 1e-3) {
            // 注意：CameraNode.updateProjection() 的首参是“毫米焦距”，不是角度。
            // 直接传 80 会得到约 17° 的长焦视野，必须用 setProjection 指定竖直 FOV。
            binding.sceneView.cameraNode.setProjection(
                VERTICAL_FOV_DEG,
                NEAR_PLANE,
                FAR_PLANE,
                Camera.Fov.VERTICAL,
                aspect
            )
            projectionAspect = aspect
        }
    }

    // ---------------- 重定位 ----------------

    private fun recenter() {
        val controller = cameraController ?: return
        controller.recenter(currentTrackingPose())
        binding.sceneView.cameraNode.worldTransform = controller.cameraPose()
        showStatus("已重新居中")
    }

    private fun resetToStart() {
        val controller = cameraController ?: return
        val arPose = currentTrackingPose()
        controller.resetToStart(arPose)
        latestArPose = arPose
        binding.sceneView.cameraNode.worldTransform = controller.cameraPose()
        showStatus("已回到房间起点")
    }

    private fun currentTrackingPose(): Mat4? {
        if (!trackingEnabled) return null
        val snapshot = poseRenderer.poseSnapshot.get()
        return if (snapshot.isTracking) snapshot.viewToWorld.toMat4() else null
    }

    // ---------------- 音量键（调试快捷键） ----------------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_VOLUME_UP -> {
                if (event.action == KeyEvent.ACTION_UP) recenter()
                return true
            }

            KeyEvent.KEYCODE_VOLUME_DOWN -> {
                when (event.action) {
                    KeyEvent.ACTION_DOWN -> {
                        if (event.repeatCount == 0) {
                            volumeDownAt = SystemClock.elapsedRealtime()
                            handler.postDelayed(exitRunnable, LONG_PRESS_MS)
                        }
                    }

                    KeyEvent.ACTION_UP -> {
                        handler.removeCallbacks(exitRunnable)
                        if (SystemClock.elapsedRealtime() - volumeDownAt < LONG_PRESS_MS) {
                            resetToStart()
                        }
                    }
                }
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    // ---------------- 状态文案 ----------------

    private fun updateStartHint(force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastStartHintAt < 500) return
        lastStartHintAt = now
        binding.tvStartHint.text = when {
            !trackingEnabled -> "真实走动已关闭：可用方向键与滑动漫游"
            poseRenderer.poseSnapshot.get().isTracking -> "AR 跟踪就绪 · 点击开始漫游"
            else -> "等待 AR 跟踪…（也可直接开始，仅用方向键移动）"
        }
    }

    private fun showStatus(text: String) {
        lastStatusAt = SystemClock.elapsedRealtime()
        binding.tvVrStatus.text = text
        binding.tvVrStatus.visibility = View.VISIBLE
    }

    private fun showStatusThrottled(text: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastStatusAt < 500) return
        showStatus(text)
    }

    private fun hideStatusIfNeeded() {
        if (binding.tvVrStatus.visibility == View.VISIBLE && started) {
            val now = SystemClock.elapsedRealtime()
            if (now - lastStatusAt > 1_500) {
                binding.tvVrStatus.visibility = View.GONE
            }
        }
    }

    private fun logPoseThrottled(cameraPose: Mat4, controller: VrCameraController) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPoseLogAt < 1_000) return
        lastPoseLogAt = now
        val p = cameraPose.translation
        Log.i(
            TAG,
            "pos=(${"%.3f".format(p.x)}, ${"%.3f".format(p.y)}, ${"%.3f".format(p.z)}) " +
                "heading=${"%.1f".format(controller.headingDegrees)} " +
                "arRef=${controller.hasArReference} tracking=$trackingEnabled"
        )
    }

    private fun currentDisplayRotation(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.rotation
        }
    }
}
