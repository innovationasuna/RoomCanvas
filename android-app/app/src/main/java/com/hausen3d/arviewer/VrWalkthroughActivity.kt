package com.hausen3d.arviewer

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.net.Uri
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
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import com.hausen3d.arviewer.ar.ArDisplayGeometry
import com.hausen3d.arviewer.ar.ArPoseFrameCache
import com.hausen3d.arviewer.ar.ArPoseRenderer
import com.hausen3d.arviewer.databinding.ActivityVrWalkthroughBinding
import com.hausen3d.arviewer.rendering.DebugCameraTrack
import com.hausen3d.arviewer.rendering.PhysicalRoomLighting
import com.hausen3d.arviewer.rendering.RenderExperiment
import com.hausen3d.arviewer.rendering.RenderPerfMonitor
import com.hausen3d.arviewer.vr.ArticulationController
import com.hausen3d.arviewer.vr.DeviceMotionMonitor
import com.hausen3d.arviewer.vr.GlbAnimationTargets
import com.hausen3d.arviewer.vr.VrCameraController
import com.hausen3d.arviewer.vr.VrTouchControlsView
import com.google.android.filament.Camera
import com.huawei.hiar.ARConfigBase
import com.huawei.hiar.AREnginesApk
import com.huawei.hiar.ARSession
import com.huawei.hiar.ARWorldTrackingConfig
import dev.romainguy.kotlin.math.Float3
import dev.romainguy.kotlin.math.Mat4
import io.github.sceneview.environment.Environment
import io.github.sceneview.model.ModelInstance
import io.github.sceneview.node.ModelNode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
        const val DEBUG_ACTION_RUN_EXPERIMENT =
            "com.hausen3d.arviewer.action.DEBUG_RUN_EXPERIMENT"
        const val DEBUG_ACTION_CAPTURE_VIEW =
            "com.hausen3d.arviewer.action.DEBUG_CAPTURE_VIEW"
        const val DEBUG_EXTRA_EXPERIMENT = "experiment"
        const val DEBUG_EXTRA_VIEW = "view"

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

        /** 记住上次导入的房间模型，下次启动直接进入 */
        private const val PREFS_NAME = "vr_walkthrough"
        private const val PREF_MODEL_PATH = "last_model_path"

        /** 记住原始文件名，开始页回显用（私有目录里的文件名带时间戳） */
        private const val PREF_MODEL_NAME = "last_model_name"
    }

    private lateinit var binding: ActivityVrWalkthroughBinding

    private lateinit var poseRenderer: ArPoseRenderer
    private lateinit var motionMonitor: DeviceMotionMonitor
    private val roomLightingDelegate = lazy { PhysicalRoomLighting(binding.sceneView) }
    private val roomLighting by roomLightingDelegate
    private var arSession: ARSession? = null
    private var sessionResumed = false

    private var modelNode: ModelNode? = null
    private var roomEnvironment: Environment? = null
    private var cameraController: VrCameraController? = null

    /** 驱动柜门/窗扇/推拉门的点击开关；模型没有动画时内部条目为空，点击无副作用 */
    private var articulation: ArticulationController? = null

    /** 正在从文件选择器拷贝/加载模型：期间禁止开始漫游与重复导入 */
    private var importing = false

    /** 启动时异步加载上次的模型：期间禁用“开始漫游”并显示加载提示 */
    private var loadingInitialModel = false

    /** 导入失败提示：在开始页常驻，避免被每 500ms 的状态刷新覆盖 */
    private var importError: String? = null

    /** 上一次实际写入的开始页提示；相同文字不重复 setText，避免每帧触发 requestLayout */
    private var startHintText: String? = null

    /** 网页分享链接导入：同一时刻只跑一个下载任务，新链接取消旧任务 */
    private var shareJob: Job? = null
    private var shareGeneration = 0L
    private var shareDialog: AlertDialog? = null
    private var importProgress: String? = null
    private var shareSource: String? = null

    /** 真实走动（AR 位姿跟踪）是否启用；菜单可切换 */
    private var trackingEnabled = true

    private var started = false
    private var lastFrameMs = 0L
    private val arPoseCache = ArPoseFrameCache()

    /** 每帧复用的相机位姿缓冲（列主序 4x4），避免热路径构造 Mat4 */
    private val cameraPoseBuffer = FloatArray(16)

    private lateinit var perfMonitor: RenderPerfMonitor
    private val debugCameraTrack = DebugCameraTrack()
    private var debugCameraTrackRunning = false
    private var debugFreezeArPose = false
    private var currentExperiment = RenderExperiment.A0
    private var renderPerfDialog: AlertDialog? = null
    private var debugIntentGeneration = 0

    /**
     * 下一次有效位姿到来时重建 AR 参考：跟踪丢失恢复、屏幕方向变化、重新开启跟踪。
     */
    private var needsReanchor = false

    private var projectionAspect = 0.0

    private var volumeDownAt = 0L
    private var lastStatusAt = 0L
    private var lastStartHintAt = 0L
    private var lastPoseLogAt = 0L

    /** 日志序号：EMUI 会去重内容相同的行，带自增序号才能连续看到采样 */
    private var debugLogSeq = 0L
    private var realWalkHintShown = false
    private var arEngineDialogShown = false

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

    private val prefs by lazy { getSharedPreferences(PREFS_NAME, MODE_PRIVATE) }

    /** 直接在当前页面导入房间模型，不再经过“预览页”这一层 */
    private val pickRoomModel =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) importRoomModel(uri)
        }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                if (trackingEnabled) startArSessionIfPossible(resumeAfterCreate = true)
            } else {
                // 相机权限只影响真实走动；按键与滑动漫游仍可用
                trackingEnabled = false
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
        motionMonitor = DeviceMotionMonitor(this)

        binding.sceneView.setZOrderMediaOverlay(true)
        // 漫游期间不使用 SceneView 自带的轨道相机手势
        binding.sceneView.cameraManipulator = null

        // 返回键分级：先收菜单 → 再结束漫游回开始页 → 最后才退出应用。
        // 本页是 launcher，直接 finish() 会关掉整个应用（旧版「退出」就是这个故障）。
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    binding.menuPanel.visibility == View.VISIBLE -> setMenuOpen(false)
                    started -> exitRoaming()
                    else -> finish()
                }
            }
        })

        // 先就绪渲染/控件，再加载模型：模型可能来自异步文件选择器
        initPoseRenderer()
        initControls()
        if (!handleShareIntent(intent)) loadRoomModel()
        loadEnvironment()

        // 先摆到房间起点，开始前就能看到室内
        cameraController?.let {
            binding.sceneView.cameraNode.worldTransform = it.initialCameraPose()
        }
        binding.vrTouchControls.inputEnabled = false
        updateStartHint(force = true)
        if (BuildConfig.DEBUG) handleDebugIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleShareIntent(intent)
        if (BuildConfig.DEBUG) handleDebugIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (!::binding.isInitialized) return
        // IMU 只在漫游期间需要，由 startWalkthrough/exitRoaming 成对管理；
        // 开始页、模型加载与 AR 关闭时不再占用两条 50Hz 传感器。
        if (BuildConfig.DEBUG) perfMonitor.resetFrameClock()

        if (!started) {
            // 从后台回来重新进入“开始漫游”状态，避免用过期参考位姿
            cameraController?.resetToStart(null)
            cameraController?.let {
                binding.sceneView.cameraNode.worldTransform = it.initialCameraPose()
            }
            binding.startOverlay.visibility = View.VISIBLE
            binding.menuRoot.visibility = View.GONE
            binding.tvVrStatus.visibility = View.GONE
            binding.vrTouchControls.inputEnabled = false
        }

        if (!trackingEnabled || !currentExperiment.quality.arEnabled) {
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
            if (BuildConfig.DEBUG) {
                debugIntentGeneration++
                debugCameraTrackRunning = false
                debugFreezeArPose = false
                perfMonitor.cancelRun()
            }
            renderPerfDialog?.dismiss()
            started = false
            lastFrameMs = 0L
            binding.vrTouchControls.clearTouches()
            binding.vrTouchControls.inputEnabled = false
            binding.startOverlay.visibility = View.VISIBLE
            binding.menuPanel.visibility = View.GONE
            binding.menuRoot.visibility = View.GONE
            binding.tvVrStatus.visibility = View.GONE
            handler.removeCallbacks(menuHideRunnable)
        }
        motionMonitor.stop()
        pauseArPump()
        super.onPause()
    }

    override fun onDestroy() {
        shareGeneration++
        shareJob?.cancel()
        shareDialog?.dismiss()
        handler.removeCallbacksAndMessages(null)
        renderPerfDialog?.dismiss()
        if (BuildConfig.DEBUG) perfMonitor.cancelRun()
        poseRenderer.session = null
        arSession?.stop()
        arSession = null
        articulation?.release()
        articulation = null
        if (::binding.isInitialized) {
            // 必须在 SceneView 销毁前归还灯光实体 ID；未初始化过则不要为了释放而构造它
            if (roomLightingDelegate.isInitialized()) roomLighting.release()
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

    /**
     * 应用启动即进入本页面，模型来源优先级：
     * Intent 传入 > 上次导入（filesDir） > 无（提示用户直接在本页导入）。
     */
    private fun loadRoomModel() {
        val assetPath = intent.getStringExtra(EXTRA_MODEL_ASSET)
        val filePath = intent.getStringExtra(EXTRA_MODEL_PATH)
        val savedPath = prefs.getString(PREF_MODEL_PATH, null)
        val savedName = prefs.getString(PREF_MODEL_NAME, null)

        when {
            assetPath != null -> loadModelAsync(
                targets = { GlbAnimationTargets.parseAsset(assets, assetPath) },
                loader = { binding.sceneView.modelLoader.createModelInstance(assetPath) },
                label = assetPath.substringAfterLast('/')
            )

            filePath != null -> loadModelAsync(
                targets = { GlbAnimationTargets.parseFile(File(filePath)) },
                loader = { binding.sceneView.modelLoader.createModelInstance(File(filePath)) },
                label = File(filePath).name
            )

            savedPath != null && File(savedPath).isFile -> loadModelAsync(
                targets = { GlbAnimationTargets.parseFile(File(savedPath)) },
                loader = { binding.sceneView.modelLoader.createModelInstance(File(savedPath)) },
                // 私有目录文件名带毫秒时间戳，优先用导入时记下的原始文件名；
                // 老版本没有记录名字时，至少把 "-1792638205582" 这段后缀去掉
                label = savedName ?: File(savedPath).name
                    .replace(Regex("-\\d{13}(?=\\.[^.]*$)"), "")
            )

            else -> {
                // 记住的模型已损坏/被删除：清掉引用，避免每次启动重复失败
                prefs.edit().remove(PREF_MODEL_PATH).remove(PREF_MODEL_NAME).apply()
                showChooseRoomHint()
            }
        }
    }

    /**
     * 启动时加载模型：只把 JSON 解析放到 IO 线程（大房间的 JSON chunk 可能卡住首帧），
     * Filament 的 createModelInstance 仍留在主线程。
     */
    private fun loadModelAsync(
        targets: () -> GlbAnimationTargets.Result,
        loader: () -> ModelInstance?,
        label: String?
    ) {
        loadingInitialModel = true
        binding.btnStart.isEnabled = false
        updateStartHint(force = true)
        lifecycleScope.launch {
            try {
                val animation = withContext(Dispatchers.IO) { targets() }
                // 解析期间用户可能已经手动导入了别的模型，别用启动时的旧模型覆盖
                if (importing || modelNode != null) return@launch
                if (!tryLoadModel(animation, label, loader)) {
                    prefs.edit().remove(PREF_MODEL_PATH).remove(PREF_MODEL_NAME).apply()
                    showChooseRoomHint()
                }
            } finally {
                loadingInitialModel = false
                updateStartHint(force = true)
            }
        }
    }

    private inline fun tryLoadModel(
        animation: GlbAnimationTargets.Result,
        label: String?,
        block: () -> ModelInstance?
    ): Boolean {
        val instance = try {
            block()
        } catch (e: Exception) {
            Log.e(TAG, "模型加载失败", e)
            null
        }
        if (instance == null) return false
        applyModelInstance(instance, animation, label)
        return true
    }

    /** 把模型挂进场景，并按包围盒重建漫游起点与房间边界 */
    private fun applyModelInstance(
        instance: ModelInstance,
        animation: GlbAnimationTargets.Result = GlbAnimationTargets.Result(),
        label: String? = null
    ) {
        importError = null
        // 不自动播放：SceneView 默认会对每条动画 playAnimation(loop = true)，
        // 正是柜门/窗户不停开合的来源。开关改由 ArticulationController 驱动。
        val node = ModelNode(modelInstance = instance, autoAnimate = false)
        // 先构造新节点：新模型构造失败时不能销毁旧的可用房间
        modelNode?.let { releaseModelNode(it) }
        binding.sceneView.addChildNode(node)
        modelNode = node
        roomLighting.setEnvironment(roomEnvironment)
        roomLighting.applyTo(node)
        articulation = ArticulationController(
            sceneView = binding.sceneView,
            modelNode = node,
            animationTargets = animation.targets,
            openTimes = animation.openTimes
        ) { label, open ->
            if (started) showStatus(if (open) "正在打开 $label" else "正在关闭 $label")
        }

        // 用模型包围盒自动定地面与人眼高度。重建模型的 y=0 不一定在地面，
        // 例如 Room-nonagent.glb 的地面在 y=-1.595m，所以不能假设原点即地面。
        val box = node.boundingBox
        val minY = animation.floorY?.takeIf {
            it >= box.center[1] - box.halfExtent[1] - .1f && it < box.center[1] + box.halfExtent[1]
        } ?: (box.center[1] - box.halfExtent[1])
        val centerX = box.center[0]
        val centerZ = box.center[2]
        val sizeX = box.halfExtent[0] * 2f
        val sizeY = box.halfExtent[1] * 2f
        val sizeZ = box.halfExtent[2] * 2f

        val eyeY = minY + EYE_HEIGHT_M
        // 默认视线朝向房间较长的一条水平轴，看到更开阔的室内
        val yawDeg = if (sizeX >= sizeZ) 90f else 0f

        val controller = VrCameraController(
            startPosition = Float3(centerX, eyeY, centerZ),
            startYawDegrees = yawDeg,
            roomMinX = centerX - sizeX * 0.5f,
            roomMaxX = centerX + sizeX * 0.5f,
            roomMinZ = centerZ - sizeZ * 0.5f,
            roomMaxZ = centerZ + sizeZ * 0.5f,
            // 升降范围按模型真实上下界给出，控制器内部再内缩出人眼安全距离
            roomMinY = minY,
            roomMaxY = box.center[1] + box.halfExtent[1],
            moveGain = MOVE_GAIN
        )
        cameraController = controller
        binding.sceneView.cameraNode.worldTransform = controller.initialCameraPose()

        // 更换模型后回到“开始漫游”状态，避免沿用旧模型的参考位姿
        started = false
        lastFrameMs = 0L
        binding.vrTouchControls.clearTouches()
        binding.vrTouchControls.inputEnabled = false
        binding.startOverlay.visibility = View.VISIBLE
        binding.menuRoot.visibility = View.GONE
        binding.tvVrStatus.visibility = View.GONE
        binding.btnStart.isEnabled = true
        updateModelChip(label)
        updateStartHint(force = true)

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

    /**
     * 彻底释放旧模型：只 removeChildNode 只是从场景树摘下，
     * FilamentAsset（几何/贴图）仍由 ModelLoader 持有，必须显式销毁。
     *
     * 注意不要先调 node.destroy()：ModelNode 的 entity 就是 asset 的根实体，
     * destroyModel() 会连同根实体一起销毁，先 destroy 会造成重复销毁。
     */
    private fun releaseModelNode(node: ModelNode) {
        // 控制器持有 animator / asset / 拾取回调，必须先于 destroyModel 失效
        articulation?.release()
        articulation = null
        binding.sceneView.removeChildNode(node)
        binding.sceneView.modelLoader.destroyModel(node.model)
    }

    private fun showChooseRoomHint() {
        articulation?.release()
        articulation = null
        modelNode = null
        cameraController = null
        binding.btnStart.isEnabled = false
        binding.startOverlay.visibility = View.VISIBLE
        binding.menuRoot.visibility = View.GONE
        updateModelChip(null)
        setStartHint("尚未选择房间模型，请点击「选择房间模型」导入 .glb 文件")
    }

    /** 开始页的模型名标签：没有名字时直接隐藏，避免留下空胶囊 */
    private fun updateModelChip(label: String?) {
        val text = label?.trim().orEmpty()
        if (text.isEmpty()) {
            binding.tvModelName.visibility = View.GONE
        } else {
            binding.tvModelName.text = text
            binding.tvModelName.visibility = View.VISIBLE
        }
    }

    /** 通过系统文件选择器导入房间模型：拷贝到私有目录并记住，下次启动直接加载 */
    private fun importRoomModel(uri: Uri) {
        if (importing) return

        // DISPLAY_NAME 来自外部 DocumentsProvider，必须只取文件名防止路径穿越
        val safeName = File(displayName(uri)).name
        val extension = safeName.substringAfterLast('.', "").lowercase()
        if (extension.isNotEmpty() && extension != "glb") {
            importError = "请选择 .glb 房间模型（.gltf 需连同外部资源，暂不支持）"
            updateStartHint(force = true)
            Toast.makeText(this, importError, Toast.LENGTH_LONG).show()
            return
        }

        importing = true
        importError = null
        binding.btnStart.isEnabled = false
        binding.btnPickRoom.isEnabled = false
        updateStartHint(force = true)

        lifecycleScope.launch {
            var copied: File? = null
            var applied = false
            try {
                val file = withContext(Dispatchers.IO) {
                    val dir = File(filesDir, "models/current")
                    if (!dir.exists()) dir.mkdirs()
                    // 写入唯一文件名，成功加载后再清理旧文件：
                    // 失败时不会把“上次记住的模型”一起删掉。
                    val base = safeName.substringBeforeLast('.', safeName).ifBlank { "room" }
                    val dest = File(dir, "$base-${System.currentTimeMillis()}.glb")
                    contentResolver.openInputStream(uri)?.use { input ->
                        dest.outputStream().use { output -> input.copyTo(output) }
                    } ?: throw IllegalStateException("无法读取所选文件")
                    dest
                }
                copied = file

                // 只读 JSON/BIN 里的动画信息，放到 IO 线程；解析失败返回空结果，不影响加载
                val animation = withContext(Dispatchers.IO) {
                    GlbAnimationTargets.parseFile(file)
                }
                // Filament 的模型创建必须在主线程
                val instance = binding.sceneView.modelLoader.createModelInstance(file)
                val shownName = safeName.ifBlank { file.name }
                applyModelInstance(instance, animation, shownName)
                applied = true
                prefs.edit()
                    .putString(PREF_MODEL_PATH, file.absolutePath)
                    .putString(PREF_MODEL_NAME, shownName)
                    .apply()

                // 新模型已加载成功，才清掉旧文件
                withContext(Dispatchers.IO) {
                    file.parentFile?.listFiles()?.forEach {
                        if (it != file) it.delete()
                    }
                }

                Toast.makeText(
                    this@VrWalkthroughActivity,
                    "已加载：${safeName.ifBlank { file.name }}",
                    Toast.LENGTH_SHORT
                ).show()
            } catch (e: Exception) {
                Log.e(TAG, "导入房间模型失败", e)
                // 已经挂进场景的文件不能删，否则下次启动会加载失败
                if (!applied) copied?.delete()
                importError = "模型加载失败：${e.message ?: "格式不支持或文件损坏"}"
                Toast.makeText(
                    this@VrWalkthroughActivity,
                    importError,
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                importing = false
                binding.btnPickRoom.isEnabled = true
                binding.btnStart.isEnabled = modelNode != null
                updateStartHint(force = true)
            }
        }
    }

    /** 浏览器点击一次只导入一份不可变快照；更新的链接会取消旧任务 */
    private fun handleShareIntent(incoming: Intent): Boolean {
        if (incoming.action != Intent.ACTION_VIEW || incoming.data?.scheme != "roomcanvas") return false
        val source = try {
            RoomShareImport.manifestUrl(incoming.data.toString())
        } catch (e: Exception) {
            importError = e.message ?: "分享链接无效"
            updateStartHint(force = true)
            return false
        }
        if (importing && shareJob == null) {
            Toast.makeText(this, "正在导入本地文件，完成后请重新打开分享", Toast.LENGTH_LONG).show()
            return true
        }
        if (shareJob?.isActive == true && shareSource == source.toString()) return true
        shareGeneration++
        val generation = shareGeneration
        shareJob?.cancel()
        shareDialog?.dismiss()
        if (started) exitRoaming()
        importing = true
        importError = null
        importProgress = "正在连接电脑…"
        binding.btnStart.isEnabled = false
        binding.btnPickRoom.isEnabled = false
        shareDialog = AlertDialog.Builder(this)
            .setTitle("导入手机房间")
            .setMessage(importProgress)
            .setCancelable(false)
            .setNegativeButton("取消") { _, _ ->
                shareGeneration++
                shareJob?.cancel(); shareJob = null
                importing = false; importProgress = null
                binding.btnPickRoom.isEnabled = true
                binding.btnStart.isEnabled = modelNode != null
                updateStartHint(force = true)
                if (modelNode == null) loadRoomModel()
            }.show()
        shareSource = source.toString()
        updateStartHint(force = true)
        val destination = File(filesDir, "models/shared/${java.util.UUID.randomUUID()}.glb")
        shareJob = lifecycleScope.launch {
            var applied = false
            try {
                val result = withContext(Dispatchers.IO) {
                    RoomShareImport.download(source, destination) { message ->
                        runOnUiThread {
                            if (generation == shareGeneration) {
                                importProgress = message
                                shareDialog?.setMessage(message)
                                updateStartHint(force = true)
                            }
                        }
                    }
                }
                ensureActive()
                if (generation != shareGeneration) return@launch
                importProgress = "正在解析房间…"; shareDialog?.setMessage(importProgress)
                val animation = withContext(Dispatchers.IO) { GlbAnimationTargets.parseFile(result.file) }
                ensureActive()
                if (generation != shareGeneration) return@launch
                val instance = binding.sceneView.modelLoader.createModelInstance(result.file)
                    ?: throw IllegalStateException("模型无法解析")
                val previous = prefs.getString(PREF_MODEL_PATH, null)
                val label = "${result.name} · ${result.version.take(8)}"
                applyModelInstance(instance, animation, label)
                applied = true
                prefs.edit().putString(PREF_MODEL_PATH, result.file.absolutePath)
                    .putString(PREF_MODEL_NAME, label).putString("last_share_version", result.version)
                    .putString("last_share_manifest", source.toString()).apply()
                // 只清理上一份已提交的文件，绝不碰另一个正在下载的任务
                if (previous != null && previous != result.file.absolutePath) {
                    val old = File(previous)
                    if (old.canonicalPath.startsWith(File(filesDir, "models").canonicalPath + File.separator)) old.delete()
                }
                Toast.makeText(this@VrWalkthroughActivity, "房间已导入，可离线打开", Toast.LENGTH_LONG).show()
            } catch (_: CancellationException) {
                // 取消或新链接：保持上一个可用房间不受影响
            } catch (e: Exception) {
                if (generation == shareGeneration) {
                    importError = "导入失败：${e.message ?: "请确认同一 Wi-Fi 且电脑服务仍在运行"}"
                    shareDialog?.dismiss()
                    AlertDialog.Builder(this@VrWalkthroughActivity).setTitle("房间未导入")
                        .setMessage(importError).setPositiveButton("重试") { _, _ -> handleShareIntent(incoming) }
                        .setNegativeButton("返回", null).show()
                }
            } finally {
                if (!applied) destination.delete()
                File(destination.path + ".part").delete()
                if (generation == shareGeneration) {
                    importing = false; shareJob = null; importProgress = null
                    shareDialog?.dismiss(); shareDialog = null
                    binding.btnPickRoom.isEnabled = true
                    binding.btnStart.isEnabled = modelNode != null
                    updateStartHint(force = true)
                    if (!applied && modelNode == null) loadRoomModel()
                }
            }
        }
        return true
    }

    private fun displayName(uri: Uri): String {
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && cursor.moveToFirst()) return cursor.getString(idx) ?: ""
        }
        return uri.lastPathSegment ?: ""
    }

    private fun loadEnvironment() {
        lifecycleScope.launch {
            roomEnvironment = try {
                binding.sceneView.environmentLoader
                    .loadHDREnvironment("environments/studio_small_09_2k.hdr")
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.w(TAG, "房间环境加载失败，保留原有照明", error)
                null
            }
            // A model may finish before or after the HDR. Keep both orders
            // equivalent without initializing lighting for an empty Activity.
            if (modelNode != null) roomLighting.setEnvironment(roomEnvironment)
        }
    }

    private fun initPoseRenderer() {
        poseRenderer = ArPoseRenderer {
            ArDisplayGeometry(
                rotation = currentDisplayRotation(),
                width = binding.sceneView.width,
                height = binding.sceneView.height
            )
        }
        binding.sceneView.addOnLayoutChangeListener { _, left, top, right, bottom,
            oldLeft, oldTop, oldRight, oldBottom ->
            if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
                poseRenderer.displayGeometryDirty = true
            }
        }
        binding.arPoseView.apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setEGLConfigChooser(8, 8, 8, 8, 0, 0)
            setRenderer(poseRenderer)
            renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        }
        if (BuildConfig.DEBUG) {
            perfMonitor = RenderPerfMonitor(
                context = this,
                filamentView = binding.sceneView.view,
                qualitySummary = {
                    // 诊断日志不能成为构造 PhysicalRoomLighting 的副作用：
                    // 它会清空 SceneView 默认主光，影响“未加载模型不初始化灯光”的语义。
                    val lights = if (roomLightingDelegate.isInitialized()) {
                        roomLighting.debugLightSummary
                    } else {
                        "lights=0"
                    }
                    "${currentExperiment.quality.summary()} $lights"
                },
                poseRenderer = { poseRenderer }
            )
        }
        binding.sceneView.onFrame = { frameTimeNanos -> onSceneFrame(frameTimeNanos) }
    }

    private fun initControls() {
        binding.btnStart.setOnClickListener { startWalkthrough() }
        binding.btnPickRoom.setOnClickListener {
            pickRoomModel.launch(
                arrayOf(
                    // 只支持单文件 .glb；*/* 是部分文件管理器识别不了 glb 时的兜底，
                    // 选中后仍会按扩展名校验
                    "model/gltf-binary",
                    "application/octet-stream",
                    "*/*"
                )
            )
        }

        binding.vrTouchControls.listener = VrTouchControlsView.Listener { dx, dy ->
            cameraController?.applyLookDelta(dx, dy)
        }
        // 触摸层与 SceneView 同为全屏、同原点，屏幕坐标可直接用于拾取
        binding.vrTouchControls.onTap = { x, y -> articulation?.toggleAt(x, y) }

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
        // “结束漫游”只回到开始页，不退出应用：本页是 launcher，finish() 会直接关掉 App
        binding.btnExitVr.setOnClickListener { exitRoaming() }
        binding.btnSpeed.setOnClickListener {
            cycleSpeed()
            resetMenuTimer()
        }
        binding.btnRenderPerf.visibility = if (BuildConfig.DEBUG) View.VISIBLE else View.GONE
        binding.btnRenderPerf.setOnClickListener { showRenderPerfDialog() }
    }

    private fun showRenderPerfDialog() {
        if (!BuildConfig.DEBUG) return
        setMenuOpen(false)
        val experiments = RenderExperiment.values()
        val spinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@VrWalkthroughActivity,
                android.R.layout.simple_spinner_dropdown_item,
                experiments.map { it.displayName }
            )
            setSelection(experiments.indexOf(currentExperiment).coerceAtLeast(0))
        }
        val status = TextView(this).apply {
            text = "每次只改一个变量。流程：20 秒预热 → 60 秒采样；日志标签 RenderPerf。"
        }
        val startButton = Button(this).apply { text = "应用实验并开始固定轨迹" }
        val stopButton = Button(this).apply { text = "停止实验并恢复 A0" }
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (20 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding / 2, padding, 0)
            addView(status)
            addView(spinner)
            addView(startButton)
            addView(stopButton)
        }
        val dialog = AlertDialog.Builder(this)
            .setTitle("阶段 0 · 视觉与性能基准")
            .setView(ScrollView(this).apply { addView(content) })
            .setNegativeButton("关闭（实验继续）", null)
            .create()
        renderPerfDialog?.dismiss()
        renderPerfDialog = dialog
        dialog.show()

        startButton.setOnClickListener {
            val experiment = experiments[spinner.selectedItemPosition]
            if (!experiment.isSupported) {
                status.text = "A8 需要独立的低模阴影代理资产；当前不能用关闭阴影或减面主模型代替。"
                return@setOnClickListener
            }
            applyRenderExperiment(experiment)
            if (!started) startWalkthrough()
            if (!started || cameraController == null) {
                status.text = "请先等待房间模型加载完成。"
                return@setOnClickListener
            }
            debugFreezeArPose = true
            debugCameraTrack.start(System.nanoTime())
            debugCameraTrackRunning = true
            binding.vrTouchControls.inputEnabled = false
            perfMonitor.startRun(experiment.name)
            status.text = "${experiment.displayName}\n正在预热 20 秒，随后采样 60 秒。关闭对话框不会中断。"
            showStatus("诊断 ${experiment.name}：固定轨迹运行中")
        }
        stopButton.setOnClickListener {
            stopRenderExperiment(restoreBaseline = true)
            status.text = "已停止固定轨迹，恢复当前视觉基准 A0。"
        }
    }

    private fun handleDebugIntent(intent: Intent) {
        if (intent.action == DEBUG_ACTION_CAPTURE_VIEW) {
            handleDebugCaptureIntent(intent)
            return
        }
        if (intent.action != DEBUG_ACTION_RUN_EXPERIMENT) return
        val name = intent.getStringExtra(DEBUG_EXTRA_EXPERIMENT)
        val experiment = RenderExperiment.values().find { it.name == name }
        if (experiment == null || !experiment.isSupported) {
            Log.w(TAG, "拒绝未知或未支持的诊断实验：$name")
            return
        }

        debugFreezeArPose = true
        val generation = ++debugIntentGeneration
        val deadline = SystemClock.elapsedRealtime() + 30_000L
        renderPerfDialog?.dismiss()
        handler.post(object : Runnable {
            override fun run() {
                if (generation != debugIntentGeneration || isDestroyed || isFinishing) return
                if (importing || loadingInitialModel || cameraController == null) {
                    if (SystemClock.elapsedRealtime() < deadline) {
                        handler.postDelayed(this, 250L)
                    } else {
                        Log.w(TAG, "诊断实验等待模型加载超时：${experiment.name}")
                    }
                    return
                }

                applyRenderExperiment(experiment)
                if (currentExperiment != experiment) {
                    Log.w(TAG, "诊断实验未启用：${experiment.name}")
                    return
                }
                if (!started) startWalkthrough()
                if (!started) {
                    Log.w(TAG, "诊断实验无法进入漫游：${experiment.name}")
                    return
                }
                renderPerfDialog?.dismiss()
                debugCameraTrack.start(System.nanoTime())
                debugCameraTrackRunning = true
                binding.vrTouchControls.inputEnabled = false
                perfMonitor.startRun(experiment.name)
                showStatus("诊断 ${experiment.name}：固定轨迹运行中")
            }
        })
    }

    private fun handleDebugCaptureIntent(intent: Intent) {
        val name = intent.getStringExtra(DEBUG_EXTRA_EXPERIMENT)
        val experiment = RenderExperiment.values().find { it.name == name }
        val view = intent.getStringExtra(DEBUG_EXTRA_VIEW) ?: "entry"
        if (experiment == null || !experiment.isSupported || view !in setOf("entry", "piano")) {
            Log.w(TAG, "拒绝未知视觉对照请求：$name view=$view")
            return
        }

        val generation = ++debugIntentGeneration
        val deadline = SystemClock.elapsedRealtime() + 30_000L
        renderPerfDialog?.dismiss()
        handler.post(object : Runnable {
            override fun run() {
                if (generation != debugIntentGeneration || isDestroyed || isFinishing) return
                if (importing || loadingInitialModel || cameraController == null) {
                    if (SystemClock.elapsedRealtime() < deadline) {
                        handler.postDelayed(this, 250L)
                    } else {
                        Log.w(TAG, "视觉对照等待模型加载超时：${experiment.name}")
                    }
                    return
                }

                applyRenderExperiment(experiment)
                if (currentExperiment != experiment) {
                    Log.w(TAG, "视觉对照实验未启用：${experiment.name}")
                    return
                }
                perfMonitor.cancelRun()
                debugCameraTrackRunning = false
                debugFreezeArPose = true
                needsReanchor = false
                val controller = cameraController ?: return
                controller.resetToStart(null)
                if (view == "piano") controller.applyLookDelta(-1200f, 0f)

                started = true
                lastFrameMs = 0L
                binding.startOverlay.visibility = View.GONE
                binding.menuRoot.visibility = View.VISIBLE
                binding.menuPanel.visibility = View.GONE
                binding.vrTouchControls.clearTouches()
                binding.vrTouchControls.inputEnabled = false
                binding.sceneView.cameraNode.worldTransform = controller.cameraPose()
                Log.i(TAG, "VisualCapture experiment=${experiment.name} view=$view")
            }
        })
    }

    private fun applyRenderExperiment(experiment: RenderExperiment) {
        val wasArEnabled = currentExperiment.quality.arEnabled
        currentExperiment = experiment
        roomLighting.applyQuality(experiment.quality)
        modelNode?.let { roomLighting.applyTo(it) }
        if (BuildConfig.DEBUG) perfMonitor.setExperiment(experiment.name)

        if (wasArEnabled && !experiment.quality.arEnabled) {
            pauseArPump()
            cameraController?.detachAr()
            needsReanchor = false
        } else if (!wasArEnabled && experiment.quality.arEnabled) {
            needsReanchor = trackingEnabled
            if (trackingEnabled &&
                checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
            ) {
                startArSessionIfPossible(resumeAfterCreate = false)
            }
        }
        // A7 关闭 AR 时同步注销传感器；切回 A0 且仍在漫游时重新注册。
        syncMotionSensors()
    }

    private fun stopRenderExperiment(restoreBaseline: Boolean) {
        debugCameraTrackRunning = false
        debugFreezeArPose = false
        if (BuildConfig.DEBUG) perfMonitor.cancelRun()
        binding.vrTouchControls.inputEnabled = started && binding.menuPanel.visibility != View.VISIBLE
        if (restoreBaseline && currentExperiment != RenderExperiment.A0) {
            applyRenderExperiment(RenderExperiment.A0)
        }
        showStatus("已停止诊断${if (restoreBaseline) "，恢复 A0" else ""}")
    }

    // ---------------- 开始 / 菜单 ----------------

    private fun startWalkthrough() {
        if (importing || loadingInitialModel) {
            Toast.makeText(this, "正在加载模型，请稍候", Toast.LENGTH_SHORT).show()
            return
        }
        val controller = cameraController ?: run {
            Toast.makeText(this, "请先选择房间模型", Toast.LENGTH_SHORT).show()
            return
        }
        controller.resetToStart(null)
        controller.speedScale = speedScales[speedIndex]

        val trackingPose = currentTrackingPose()
        if (trackingPose != null) {
            controller.attachArReference(trackingPose.first, trackingPose.second)
            needsReanchor = false
        } else {
            // 等第一帧有效位姿到来时再建立参考（保持当前视角）
            needsReanchor = trackingEnabled && currentExperiment.quality.arEnabled
        }

        started = true
        syncMotionSensors()
        lastFrameMs = 0L
        binding.startOverlay.visibility = View.GONE
        binding.menuRoot.visibility = View.VISIBLE
        binding.menuPanel.visibility = View.GONE
        binding.vrTouchControls.inputEnabled = true
        binding.sceneView.cameraNode.worldTransform = controller.cameraPose()

        if (trackingEnabled && currentExperiment.quality.arEnabled &&
            controller.isArPoseApplied && !realWalkHintShown
        ) {
            realWalkHintShown = true
            val hint = if (motionMonitor.hasRequiredSensors) {
                "走动时请留意现实环境"
            } else {
                "设备缺少运动传感器：AR 位姿已冻结，可继续用方向键和滑屏"
            }
            Toast.makeText(this, hint, Toast.LENGTH_LONG).show()
        }
        showStatus("左下方向键移动，左上「升/降」调高度，右半屏滑动转向，右上角菜单")
    }

    /**
     * IMU 只在“正在漫游 + AR 实际可用”时注册：权限拒绝、AR Engine 缺失、
     * 选 A7 或切后台都会注销；从 A7 切回 A0 时重新注册。
     */
    private fun syncMotionSensors() {
        val shouldRun = started && trackingEnabled &&
            currentExperiment.quality.arEnabled && sessionResumed
        if (shouldRun) motionMonitor.start() else motionMonitor.stop()
    }

    /**
     * 结束漫游：回到“开始漫游”页，保留已加载的模型。
     *
     * 不能调 finish()——VrWalkthroughActivity 是 launcher，也没有父页面可返回，
     * finish() 会让整个应用退出。这里只把漫游状态复位，把开始覆盖层重新显示出来。
     */
    private fun exitRoaming() {
        val controller = cameraController
        if (BuildConfig.DEBUG && (debugCameraTrackRunning || currentExperiment != RenderExperiment.A0)) {
            stopRenderExperiment(restoreBaseline = true)
        }
        if (BuildConfig.DEBUG) {
            // A0 采样/截图结束后 debugCameraTrackRunning 已为 false，但冻结状态可能仍在；
            // 离开漫游时无条件清理，保证下次进入重新消费 AR 位姿。
            debugCameraTrackRunning = false
            debugFreezeArPose = false
        }
        started = false
        lastFrameMs = 0L
        needsReanchor = false
        syncMotionSensors()

        setMenuOpen(false)          // 收起菜单面板
        handler.removeCallbacks(menuHideRunnable)
        binding.vrTouchControls.clearTouches()
        binding.vrTouchControls.inputEnabled = false
        binding.menuRoot.visibility = View.GONE
        binding.tvVrStatus.visibility = View.GONE
        binding.startOverlay.visibility = View.VISIBLE

        // 回到房间起点，下次“开始漫游”从固定位置进入
        controller?.resetToStart(null)
        controller?.let {
            binding.sceneView.cameraNode.worldTransform = it.initialCameraPose()
        }
        updateStartHint(force = true)
    }

    private fun setMenuOpen(open: Boolean) {
        binding.menuPanel.visibility = if (open) View.VISIBLE else View.GONE
        binding.vrTouchControls.inputEnabled = started && !open && !debugCameraTrackRunning
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

    // ---------------- AR 会话 ----------------

    /**
     * @param resumeAfterCreate 权限弹窗回调里调用时为 true：此时 onResume 已执行过，
     *                          需要在这里补做 resume + GLSurfaceView.onResume。
     */
    private fun startArSessionIfPossible(resumeAfterCreate: Boolean) {
        if (!currentExperiment.quality.arEnabled) return
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
            updateStartHint(force = true)
            return
        }
        binding.arPoseView.onResume()
        displayManager.registerDisplayListener(displayListener, null)
        sessionResumed = true

        if (resumeAfterCreate && started) {
            needsReanchor = true
        }
        // 权限弹窗期间已开始漫游时，ARSession 就绪后补注册传感器。
        syncMotionSensors()
    }

    private fun pauseArPump() {
        arPoseCache.reset()
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

    private fun onSceneFrame(frameTimeNanos: Long) {
        val callbackStartedAt = System.nanoTime()
        var inputCpuNanos = 0L
        var arControllerCpuNanos = 0L
        var animationCpuNanos = 0L
        var cameraCpuNanos = 0L
        try {
            updateProjectionIfNeeded()

            val now = SystemClock.elapsedRealtime()
            val dt = if (lastFrameMs == 0L) {
                0f
            } else {
                ((now - lastFrameMs) / 1000f).coerceIn(0f, MAX_FRAME_DT_S)
            }
            lastFrameMs = now

            val animationStartedAt = System.nanoTime()
            // 开关动画与是否开始漫游无关：开始页也能看到柜门缓慢合上
            articulation?.step(dt)
            animationCpuNanos = System.nanoTime() - animationStartedAt

            if (!started) {
                updateStartHint()
                return
            }

            val controller = cameraController ?: return
            val inputStartedAt = System.nanoTime()
            if (BuildConfig.DEBUG && debugCameraTrackRunning) {
                debugCameraTrack.advance(frameTimeNanos)
                if (debugCameraTrack.resetRequested) {
                    val pose = currentTrackingPose()
                    controller.resetToStart(pose?.first, pose?.second ?: 0L)
                }
                controller.applyMoveInput(
                    debugCameraTrack.forwardAxis,
                    0f,
                    0f,
                    debugCameraTrack.movementDeltaSeconds
                )
                controller.applyLookDelta(debugCameraTrack.lookDeltaXPixels, 0f)
                if (debugCameraTrack.toggleAnimationIndex >= 0) {
                    articulation?.toggleAnimationForDebug(debugCameraTrack.toggleAnimationIndex)
                }
            } else {
                // 方向键：每帧读取当前按压状态（多指并集）
                controller.applyMoveInput(
                    binding.vrTouchControls.moveForward,
                    binding.vrTouchControls.moveStrafe,
                    binding.vrTouchControls.moveVertical,
                    dt
                )
            }
            inputCpuNanos = System.nanoTime() - inputStartedAt

            val arStartedAt = System.nanoTime()
            if (trackingEnabled && currentExperiment.quality.arEnabled && !debugFreezeArPose) {
                var isNewArFrame = false
                val arPose = poseRenderer.withPoseSnapshot { snapshot ->
                    if (!snapshot.isTracking) {
                        null
                    } else {
                        isNewArFrame = arPoseCache.isNew(snapshot)
                        arPoseCache.get(snapshot)
                    }
                }
                if (arPose != null) {
                    val timestampNs = arPoseCache.timestampNs
                    when {
                        // 跟踪恢复 / 重新开启 / 屏幕旋转：保持当前视角，重建参考
                        needsReanchor -> {
                            controller.reanchorKeepingView(arPose, timestampNs)
                            needsReanchor = false
                        }

                        !controller.hasArReference -> {
                            controller.attachArReference(arPose, timestampNs)
                        }

                        isNewArFrame -> controller.updateArPose(
                            arPose,
                            timestampNs,
                            motionMonitor.snapshot()
                        )
                    }
                    hideStatusIfNeeded()
                } else {
                    // 只冻结 AR 增量（t_ar、ψ_ar 保持上一帧），按键与滑动照常更新
                    needsReanchor = true
                    if (controller.isArPoseApplied) {
                        showStatusThrottled(
                            if (controller.hasArReference) {
                                "跟踪丢失（可能是后置摄像头被遮挡）：可继续用方向键和滑动移动"
                            } else {
                                "等待 AR 跟踪…请勿遮挡后置摄像头，可先用方向键移动"
                            }
                        )
                    }
                }
            } else {
                hideStatusIfNeeded()
            }
            arControllerCpuNanos = System.nanoTime() - arStartedAt

            val cameraStartedAt = System.nanoTime()
            controller.cameraPoseInto(cameraPoseBuffer)
            applyCameraPose(cameraPoseBuffer)
            logPoseThrottled(cameraPoseBuffer, controller)
            cameraCpuNanos = System.nanoTime() - cameraStartedAt
        } finally {
            if (BuildConfig.DEBUG) {
                perfMonitor.recordFrame(
                    frameTimeNanos = frameTimeNanos,
                    callbackCpuNanos = System.nanoTime() - callbackStartedAt,
                    inputCpuNanos = inputCpuNanos,
                    arControllerCpuNanos = arControllerCpuNanos,
                    animationCpuNanos = animationCpuNanos,
                    cameraCpuNanos = cameraCpuNanos
                )
                if (debugCameraTrackRunning && !perfMonitor.isRunActive) {
                    debugCameraTrackRunning = false
                    // 采样结束后必须解除 AR 冻结；否则退出再进入会一直跳过位姿更新。
                    debugFreezeArPose = false
                    if (started) needsReanchor = true
                    binding.vrTouchControls.inputEnabled =
                        started && binding.menuPanel.visibility != View.VISIBLE
                    showStatus("${currentExperiment.name} 采样完成，画质保持；可在诊断面板恢复 A0")
                }
            }
        }
    }

    /**
     * 直接把位姿写进 Filament TransformManager，避免每帧构造 Mat4 与临时 FloatArray。
     * 与 `cameraNode.worldTransform = Mat4` 等价：Node 的 setter 内部也是
     * setTransform + onWorldTransformChanged。
     */
    private fun applyCameraPose(pose: FloatArray) {
        val cameraNode = binding.sceneView.cameraNode
        binding.sceneView.engine.transformManager.setTransform(
            cameraNode.transformInstance,
            pose
        )
        cameraNode.onWorldTransformChanged()
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
        val pose = currentTrackingPose()
        controller.recenter(pose?.first, pose?.second ?: 0L)
        binding.sceneView.cameraNode.worldTransform = controller.cameraPose()
        showStatus("已重新居中")
    }

    private fun resetToStart() {
        val controller = cameraController ?: return
        val pose = currentTrackingPose()
        controller.resetToStart(pose?.first, pose?.second ?: 0L)
        binding.sceneView.cameraNode.worldTransform = controller.cameraPose()
        showStatus("已回到房间起点")
    }

    private fun currentTrackingPose(): Pair<Mat4, Long>? = poseRenderer.withPoseSnapshot { snapshot ->
        if (trackingEnabled && currentExperiment.quality.arEnabled && snapshot.isTracking) {
            arPoseCache.get(snapshot) to snapshot.timestampNs
        } else {
            null
        }
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
        // 导入中/上次导入失败：保持提示，不被每 500ms 的状态刷新覆盖
        if (importing) {
            setStartHint(importProgress ?: "正在导入模型…")
            return
        }
        if (loadingInitialModel) {
            setStartHint("正在加载房间模型…")
            return
        }
        importError?.let {
            setStartHint(it)
            return
        }

        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastStartHintAt < 500) return
        lastStartHintAt = now
        setStartHint(
            when {
                modelNode == null -> "尚未选择房间模型，请点击「选择房间模型」导入 .glb 文件"
                cameraController?.isArPoseApplied != true -> "点击开始漫游：方向键移动，滑屏转向"
                !trackingEnabled -> "相机/AR 不可用：可用方向键与滑动漫游"
                poseRenderer.withPoseSnapshot { it.isTracking } -> "AR 跟踪就绪，点击开始漫游"
                else -> "等待 AR 跟踪…（也可直接开始，仅用方向键移动）"
            }
        )
    }

    /**
     * 开始页提示只在文字变化时写入 TextView。
     *
     * onSceneFrame 在未开始漫游时每帧调用 updateStartHint()；TextView.setText 对相同
     * 字符串没有短路，wrap_content 宽度会走 checkForRelayout → 每帧 requestLayout。
     * 分享导入可持续数分钟，必须在这里挡住重复写入。
     */
    private fun setStartHint(text: String) {
        if (text == startHintText) return
        startHintText = text
        binding.tvStartHint.text = text
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

    private fun logPoseThrottled(cameraPose: FloatArray, controller: VrCameraController) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastPoseLogAt < 500) return
        lastPoseLogAt = now
        val pX = cameraPose[12]
        val pY = cameraPose[13]
        val pZ = cameraPose[14]
        val base = controller.debugBasePosition
        val tAr = controller.debugArTranslation
        val mOff = controller.debugMoveOffset
        val arTracking = poseRenderer.withPoseSnapshot { it.isTracking }
        val motion = motionMonitor.snapshot()
        // 带自增 seq，华为 EMUI 不会把行去重掉；关键是要能分辨
        // 「AR 正常但判定静止」与「AR 位姿根本没更新」。
        Log.i(
            TAG,
            "seq=${++debugLogSeq} t=${now / 1000f} " +
                "pos=(${"%.3f".format(pX)}, ${"%.3f".format(pZ)}) y=${"%.3f".format(pY)} " +
                "base=(${"%.3f".format(base.x)}, ${"%.3f".format(base.z)}) " +
                "tAr=(${"%.3f".format(tAr.x)}, ${"%.3f".format(tAr.z)}) " +
                "mOff=(${"%.3f".format(mOff.x)}, ${"%.3f".format(mOff.z)}) " +
                "rawAr=(${"%.3f".format(controller.debugRawArX)}, ${"%.3f".format(controller.debugRawArZ)}) " +
                "head=${"%.1f".format(controller.headingDegrees)} " +
                "arYaw=${"%.1f".format(controller.debugArYawDeltaDegrees)} " +
                "arYawApplied=${"%.1f".format(controller.debugAppliedArYawDegrees)} " +
                "lookYaw=${"%.1f".format(controller.debugLookYawDegrees)} " +
                "arWalk=${"%.2f".format(controller.arWalkSpeedMps)} " +
                "follow=${controller.isFollowingArWalk} " +
                "moveIMU=${motion.translationActive} turnIMU=${motion.rotationActive} " +
                "lin=${"%.3f".format(motion.linearAccelerationMps2)} " +
                "gyro=${"%.3f".format(motion.angularVelocityRadS)} " +
                "still=${"%.2f".format(controller.debugArStillSeconds)} " +
                "step=(${"%.4f".format(controller.debugLastStepX)}, ${"%.4f".format(controller.debugLastStepZ)}) " +
                "dt=${"%.4f".format(controller.debugLastDt)} " +
                "arTrack=$arTracking " +
                "poseFrames=${poseRenderer.poseCounter.get()} " +
                "glFrames=${poseRenderer.frameCounter.get()} " +
                "arUpdates=${controller.arPoseUpdateCount} " +
                "arApplied=${controller.isArPoseApplied} " +
                "walkEnabled=$trackingEnabled"
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
