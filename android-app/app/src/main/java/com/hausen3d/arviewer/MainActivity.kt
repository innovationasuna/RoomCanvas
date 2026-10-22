package com.hausen3d.arviewer

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.net.Uri
import android.opengl.GLSurfaceView
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.Surface
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.hausen3d.arviewer.ar.ArGestureHandler
import com.hausen3d.arviewer.ar.CameraBackgroundRenderer
import com.hausen3d.arviewer.ar.toMat4
import com.hausen3d.arviewer.databinding.ActivityMainBinding
import com.hausen3d.arviewer.vr.ArticulationController
import com.hausen3d.arviewer.vr.GlbAnimationTargets
import com.huawei.hiar.ARConfigBase
import com.huawei.hiar.AREnginesApk
import com.huawei.hiar.ARSession
import com.huawei.hiar.ARWorldTrackingConfig
import io.github.sceneview.gesture.CameraGestureDetector
import io.github.sceneview.math.Position
import io.github.sceneview.math.Rotation
import io.github.sceneview.math.Scale
import io.github.sceneview.math.Transform
import io.github.sceneview.model.ModelInstance
import io.github.sceneview.node.ModelNode
import io.github.sceneview.node.Node
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/**
 * glTF 查看器（M1 保底交付物）+ AR 实景查看（阶段 2）。
 *
 * 查看器模式（M1，全部保留）：
 * - SAF 文件选择器导入 .glb/.gltf（.gltf 自动解析外部引用并引导补选）
 * - SceneView（Filament）渲染，HDR 环境光 + PBR 材质
 * - 轨道相机手势：单指旋转、双指缩放/平移
 *
 * AR 模式（阶段 2，SceneView 纯渲染 + HUAWEI AR Engine 位姿自行集成）：
 * - 不用 SceneView 的 arsceneview（绑定 Google ARCore，华为手机不可用）
 * - GLSurfaceView 底层渲染相机画面（OES 纹理），SceneView 透明叠加渲染模型
 * - AR Engine 提供 6DoF 位姿/投影矩阵 → 每帧驱动 SceneView 相机
 * - 点击平面命中测试创建 Anchor，模型挂载 Anchor；单指旋转、双指缩放
 * - 1:1 原始尺寸开关 = 房间模式（保留模型原始尺寸与自身原点）
 *
 * 线程模型：所有 hiar 调用收敛在 [CameraBackgroundRenderer] 的 GL 线程；
 * SceneView 场景操作全部在主线程；两线程经快照/队列通信。
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        /** 切后台 / GC 卡顿后的单帧时间上限，防止开关动画瞬移 */
        private const val MAX_FRAME_DT_S = 0.05f

        /** 轻点判定：与网页 walk/app.js 一致 */
        private const val TAP_SLOP_DP = 6f
        private const val TAP_TIMEOUT_MS = 500L
    }

    private lateinit var binding: ActivityMainBinding
    private var currentNode: ModelNode? = null

    /** 当前已加载的模型实例（查看器与 AR 两种模式共用） */
    private var lastModelInstance: ModelInstance? = null

    /** 柜门/窗扇的点击开关；查看器与 AR 放置各持有自己的节点，切模式时重建 */
    private var articulation: ArticulationController? = null

    /** 当前模型的动画目标与往返片段中点时间，随模型一起切换 */
    private var animationInfo: GlbAnimationTargets.Result = GlbAnimationTargets.Result()

    private var lastFrameMs = 0L

    // 查看器轻点判定（不影响 SceneView 自身的旋转/缩放手势）
    private val tapSlopPx get() = TAP_SLOP_DP * resources.displayMetrics.density
    private var tapTracking = false
    private var tapPointerId = -1
    private var tapDownX = 0f
    private var tapDownY = 0f
    private var tapDownAtMs = 0L

    /**
     * 当前模型来源：供 [VrWalkthroughActivity] 在新 Engine 中重新加载。
     * 两个 Activity 各自持有 Filament Engine，不能直接共享 ModelInstance。
     */
    private var currentModelPath: String? = null
    private var currentModelAsset: String? = null

    // ---------------- AR 模式状态 ----------------

    private var arModeActive = false
    private var arSession: ARSession? = null
    private lateinit var arRenderer: CameraBackgroundRenderer
    private lateinit var arGestures: ArGestureHandler

    /** AR 场景树：anchorNode（跟随 Anchor 位姿）→ gestureNode（手势旋转/缩放）→ arModelNode */
    private var anchorNode: Node? = null
    private var gestureNode: Node? = null
    private var arModelNode: ModelNode? = null
    private var arPlaced = false
    private var cameraTracking = false
    private var gestureYawDeg = 0f
    private var gestureScale = 1f
    private var lastArStatusAt = 0L

    /** 进入 AR 前保存的查看器状态，退出时恢复 */
    private var savedCameraManipulator: CameraGestureDetector.CameraManipulator? = null
    private var hdrSkybox: com.google.android.filament.Skybox? = null

    private val displayManager by lazy { getSystemService(DisplayManager::class.java) }

    private val displayListener = object : DisplayManager.DisplayListener {
        override fun onDisplayAdded(displayId: Int) {}
        override fun onDisplayRemoved(displayId: Int) {}
        override fun onDisplayChanged(displayId: Int) {
            arRenderer.displayGeometryDirty = true
        }
    }

    // ---------------- 文件选择器 ----------------

    private val pickModel =
        registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) loadModel(uri) else setStatus("已取消选择")
        }

    // .gltf 外部资源（.bin / 贴图）待补选择时的暂存状态
    private var pendingGltfFile: File? = null
    private var pendingGltfDir: File? = null
    private var pendingRefs: List<String> = emptyList()

    private val pickAuxFiles =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            onAuxFilesPicked(uris)
        }

    private val cameraPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                enterArMode()
            } else {
                Toast.makeText(this, "AR 模式需要相机权限", Toast.LENGTH_LONG).show()
            }
        }

    // ---------------- 生命周期 ----------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.sceneView.cameraNode.position = Position(z = 3.0f)

        // SceneView 表面一次性配为"可透明 + 媒体叠加层"（须在 surface 创建前设置）：
        // 查看器模式下内容本身不透明，行为与之前一致；AR 模式下透出底层相机画面
        binding.sceneView.uiHelper.isOpaque = false
        binding.sceneView.setZOrderMediaOverlay(true)
        // SceneView 在 XML 实例化时已按默认“不透明”格式 attach 到 UiHelper，
        // 仅修改 uiHelper.isOpaque 不会更新 Surface 格式（SurfaceFlinger 中该层仍 isOpaque=true，
        // 会把底层相机 GLSurfaceView 完全盖住，表现为 AR 模式全黑）。
        // 必须在 surface 创建前手动把 holder 格式改为 TRANSLUCENT，让相机画面透出来。
        @Suppress("DEPRECATION")
        binding.sceneView.holder.setFormat(android.graphics.PixelFormat.TRANSLUCENT)

        // HDR 环境光照：PBR 材质必须有环境光才能正常显示（AR 模式下同样作 IBL 光源）
        lifecycleScope.launch {
            val environment = binding.sceneView.environmentLoader
                .loadHDREnvironment("environments/studio_small_09_2k.hdr")
            binding.sceneView.indirectLight = environment?.indirectLight
            hdrSkybox = environment?.skybox
            if (!arModeActive) {
                binding.sceneView.skybox = environment?.skybox
            }
        }

        initAr()

        // 旧 AR 叠加入口停用：主流程改为“房间漫游”（VR）。
        // AR 相关代码保留，便于后续对比/调试，不再从 UI 触发。
        binding.btnArMode.text = "房间漫游"
        binding.btnArMode.setOnClickListener { startVrWalkthrough() }

        binding.btnPick.setOnClickListener {
            pickModel.launch(
                arrayOf(
                    "model/gltf-binary",
                    "model/gltf+json",
                    "application/octet-stream",
                    "*/*"
                )
            )
        }

        // 首次启动加载内置示例模型，便于无文件时冒烟测试
        loadBundledDefault()
    }

    private fun initAr() {
        arRenderer = CameraBackgroundRenderer { currentDisplayRotation() }
        arRenderer.onPlacementResult = { placed -> onPlacementResult(placed) }
        binding.arCameraView.apply {
            preserveEGLContextOnPause = true
            setEGLContextClientVersion(2)
            setEGLConfigChooser(8, 8, 8, 8, 16, 0)
            setRenderer(arRenderer)
            renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
        }
        arGestures = ArGestureHandler(
            this,
            onTap = { x, y -> handleArTap(x, y) },
            onRotate = { delta ->
                gestureYawDeg = (gestureYawDeg + delta) % 360f
                applyGestureToModel()
            },
            onScale = { factor ->
                gestureScale *= factor
                applyGestureToModel()
            }
        )
        binding.btnArMode.setOnClickListener {
            if (arModeActive) exitArMode() else tryEnterArMode()
        }
        // SceneView 每帧渲染前的回调：推进开关动画 + 应用 AR 位姿快照（主线程）
        binding.sceneView.onFrame = { onSceneFrame() }

        // 查看器轻点：返回 false 保留 SceneView 的旋转/缩放手势。
        // AR 模式下事件被 setOnTouchListener 吞掉，不会走到这里。
        binding.sceneView.onTouchEvent = { event, _ ->
            handleViewerTouch(event)
            false
        }
    }

    private fun onSceneFrame() {
        val now = SystemClock.elapsedRealtime()
        val dt = if (lastFrameMs == 0L) {
            0f
        } else {
            ((now - lastFrameMs) / 1000f).coerceIn(0f, MAX_FRAME_DT_S)
        }
        lastFrameMs = now

        articulation?.step(dt)
        applyArSnapshots()
    }

    // ---------------- 点击开关 ----------------

    /** AR：已放置时点击活动部件只开关；点空处或部件未被命中才重新放置。 */
    private fun handleArTap(x: Float, y: Float) {
        if (!arModeActive) return
        if (!arPlaced) {
            arRenderer.requestPlacement(x, y)
            return
        }
        val controller = articulation
        val handled = controller?.toggleAt(x, y) { toggled ->
            if (!toggled) arRenderer.requestPlacement(x, y)
        } ?: false
        if (!handled) arRenderer.requestPlacement(x, y)
    }

    /** 查看器：位移 / 时长判定与网页一致，拖动旋转不会误触。 */
    private fun handleViewerTouch(event: MotionEvent) {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                val index = event.actionIndex
                tapTracking = true
                tapPointerId = event.getPointerId(index)
                tapDownX = event.getX(index)
                tapDownY = event.getY(index)
                tapDownAtMs = SystemClock.elapsedRealtime()
            }

            MotionEvent.ACTION_POINTER_DOWN,
            MotionEvent.ACTION_CANCEL -> tapTracking = false

            MotionEvent.ACTION_MOVE -> {
                if (tapTracking) {
                    val index = event.findPointerIndex(tapPointerId)
                    if (index >= 0) {
                        val dx = event.getX(index) - tapDownX
                        val dy = event.getY(index) - tapDownY
                        if (dx * dx + dy * dy > tapSlopPx * tapSlopPx) tapTracking = false
                    }
                }
            }

            MotionEvent.ACTION_POINTER_UP -> {
                if (event.getPointerId(event.actionIndex) == tapPointerId) tapTracking = false
            }

            MotionEvent.ACTION_UP -> {
                val index = event.actionIndex
                if (tapTracking && event.getPointerId(index) == tapPointerId) {
                    val x = event.getX(index)
                    val y = event.getY(index)
                    val dx = x - tapDownX
                    val dy = y - tapDownY
                    val inTime =
                        SystemClock.elapsedRealtime() - tapDownAtMs <= TAP_TIMEOUT_MS
                    if (inTime && dx * dx + dy * dy <= tapSlopPx * tapSlopPx) {
                        articulation?.toggleAt(x, y)
                    }
                }
                tapTracking = false
            }
        }
    }

    private fun createArticulation(node: ModelNode) {
        articulation = ArticulationController(
            sceneView = binding.sceneView,
            modelNode = node,
            animationTargets = animationInfo.targets,
            openTimes = animationInfo.openTimes
        ) { label, open ->
            setStatus(if (open) "正在打开 $label" else "正在关闭 $label")
        }
    }

    private fun releaseArticulation() {
        articulation?.release()
        articulation = null
    }

    // ---------------- 房间漫游（VR） ----------------

    private fun startVrWalkthrough() {
        val path = currentModelPath
        val asset = currentModelAsset
        if (path == null && asset == null) {
            Toast.makeText(this, "请先选择模型", Toast.LENGTH_SHORT).show()
            return
        }
        val intent = Intent(this, VrWalkthroughActivity::class.java).apply {
            if (path != null) putExtra(VrWalkthroughActivity.EXTRA_MODEL_PATH, path)
            if (asset != null) putExtra(VrWalkthroughActivity.EXTRA_MODEL_ASSET, asset)
        }
        startActivity(intent)
    }

    override fun onResume() {
        super.onResume()
        if (arModeActive) {
            // 一次性授权会在 App 退到后台后被系统回收；此时 resume() 不报错，
            // 但 AR Engine 打不开相机，表现为全黑画面。必须主动检查权限。
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(
                    this,
                    "相机权限已被系统回收，已退出 AR 模式。重新进入时请选择“仅使用期间允许”",
                    Toast.LENGTH_LONG
                ).show()
                exitArMode()
                return
            }
            arSession?.let {
                try {
                    it.resume()
                } catch (e: Exception) {
                    Toast.makeText(this, "相机打开失败，已退出 AR 模式", Toast.LENGTH_LONG).show()
                    exitArMode()
                    return
                }
            }
            binding.arCameraView.onResume()
            displayManager.registerDisplayListener(displayListener, null)
        }
    }

    override fun onPause() {
        if (arModeActive) {
            displayManager.unregisterDisplayListener(displayListener)
            // 先停 GL 渲染线程（阻塞至其空闲），再停会话，避免跨线程访问
            binding.arCameraView.onPause()
            arSession?.pause()
        }
        super.onPause()
    }

    override fun onDestroy() {
        releaseArticulation()
        arRenderer.session = null
        arSession?.stop()
        arSession = null
        super.onDestroy()
    }

    // ---------------- AR 模式进入/退出 ----------------

    private fun tryEnterArMode() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            enterArMode()
        } else {
            cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    private fun enterArMode() {
        if (arModeActive) return
        if (!AREnginesApk.isAREngineApkReady(this)) {
            showArEngineMissingDialog()
            return
        }
        try {
            val session = ARSession(applicationContext)
            val config = ARWorldTrackingConfig(session)
            config.focusMode = ARConfigBase.FocusMode.AUTO_FOCUS
            config.semanticMode = ARWorldTrackingConfig.SEMANTIC_PLANE
            config.lightingMode = ARConfigBase.LIGHT_MODE_NONE
            session.configure(config)
            session.resume()
            arSession = session
        } catch (e: Exception) {
            Toast.makeText(this, "AR 会话启动失败：${e.message}", Toast.LENGTH_LONG).show()
            arSession = null
            return
        }
        arModeActive = true

        // 渲染管线切换：透明叠加 + 关闭天空盒 + 禁用轨道相机手势
        savedCameraManipulator = binding.sceneView.cameraManipulator
        binding.sceneView.cameraManipulator = null
        hdrSkybox = binding.sceneView.skybox
        binding.sceneView.skybox = null
        binding.sceneView.view.blendMode = com.google.android.filament.View.BlendMode.TRANSLUCENT
        binding.sceneView.renderer.clearOptions =
            binding.sceneView.renderer.clearOptions.apply {
                clear = true
                clearColor = floatArrayOf(0f, 0f, 0f, 0f)
            }
        // AR 模式触摸全部交给 AR 手势（SceneView 自身手势不再触发）
        binding.sceneView.setOnTouchListener { _, event ->
            arGestures.onTouchEvent(event)
            true
        }

        // 相机背景层
        arRenderer.session = arSession
        arRenderer.displayGeometryDirty = true
        binding.arCameraView.visibility = View.VISIBLE
        binding.arCameraView.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        binding.arCameraView.onResume()

        // 查看器中的模型先撤下，等待点击放置
        releaseArticulation()
        currentNode?.let { binding.sceneView.removeChildNode(it) }
        currentNode = null
        arPlaced = false
        cameraTracking = false
        lastArStatusAt = 0L

        displayManager.registerDisplayListener(displayListener, null)

        binding.btnArMode.text = "退出 AR"
        setStatus("正在检测平面…请将摄像头对准桌面或地面")
    }

    private fun exitArMode() {
        if (!arModeActive) return
        arModeActive = false

        displayManager.unregisterDisplayListener(displayListener)

        // 先停 GL 渲染线程（阻塞至空闲），再停会话，避免跨线程访问
        binding.arCameraView.onPause()
        binding.arCameraView.renderMode = GLSurfaceView.RENDERMODE_WHEN_DIRTY
        arRenderer.session = null
        arRenderer.reset()
        arSession?.stop()
        arSession = null
        binding.arCameraView.visibility = View.GONE

        // 移除 AR 场景树
        releaseArticulation()
        anchorNode?.let { binding.sceneView.removeChildNode(it) }
        anchorNode = null
        gestureNode = null
        arModelNode = null
        arPlaced = false
        gestureYawDeg = 0f
        gestureScale = 1f
        arGestures.reset()

        // 恢复查看器渲染
        binding.sceneView.setOnTouchListener(null)
        binding.sceneView.view.blendMode = com.google.android.filament.View.BlendMode.OPAQUE
        binding.sceneView.renderer.clearOptions =
            binding.sceneView.renderer.clearOptions.apply {
                clear = false
                clearColor = floatArrayOf(0f, 0f, 0f, 1f)
            }
        binding.sceneView.skybox = hdrSkybox
        binding.sceneView.cameraManipulator = savedCameraManipulator
        binding.sceneView.cameraNode.updateProjection()
        binding.sceneView.cameraNode.transform = Transform(position = Position(z = 3.0f))

        // 模型回到查看器
        lastModelInstance?.let { replaceModel(it) }

        binding.btnArMode.text = "AR 模式"
        setStatus("已退出 AR 模式")
    }

    private fun showArEngineMissingDialog() {
        AlertDialog.Builder(this)
            .setTitle("需要华为 AR Engine 服务")
            .setMessage("未检测到可用的 AR Engine 服务。AR 模式依赖该服务，可在华为应用市场安装/更新后重试。")
            .setPositiveButton("去应用市场") { _, _ ->
                try {
                    startActivity(
                        Intent("com.huawei.appmarket.intent.action.AppDetail").apply {
                            putExtra("APP_PACKAGENAME", "com.huawei.arengine.service")
                            setPackage("com.huawei.appmarket")
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                    )
                } catch (e: ActivityNotFoundException) {
                    Toast.makeText(this, "未找到华为应用市场", Toast.LENGTH_LONG).show()
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---------------- AR 每帧驱动（主线程，SceneView.onFrame） ----------------

    private fun applyArSnapshots() {
        if (!arModeActive) return
        val snap = arRenderer.cameraSnapshot.get()
        cameraTracking = snap.isTracking
        if (snap.isTracking) {
            binding.sceneView.cameraNode.worldTransform = snap.viewToWorld.toMat4()
            val projection = snap.projection.toMat4()
            binding.sceneView.cameraNode.setCustomProjection(
                projection,
                CameraBackgroundRenderer.PROJ_NEAR.toDouble(),
                CameraBackgroundRenderer.PROJ_FAR.toDouble(),
                projection
            )
        }
        arRenderer.anchorSnapshot.get()?.let { anchorSnap ->
            if (anchorSnap.isTracking) {
                anchorNode?.let {
                    it.worldTransform = anchorSnap.poseMatrix.toMat4()
                    if (arPlaced && !it.isVisible) it.isVisible = true
                }
            }
        }
        // Anchor 被 AR Engine 置为 STOPPED 并清理后，回到待放置状态
        if (arPlaced && !arRenderer.anchorActive.get()) {
            arPlaced = false
            anchorNode?.isVisible = false
        }
        updateArStatus()
    }

    private fun updateArStatus() {
        val now = SystemClock.uptimeMillis()
        if (now - lastArStatusAt < 500) return
        lastArStatusAt = now
        val planes = arRenderer.planeCount.get()
        val text = when {
            !cameraTracking -> "跟踪丢失：请对准有纹理的表面，缓慢移动手机"
            !arPlaced && planes == 0 -> "正在检测平面…请将摄像头对准桌面或地面"
            !arPlaced -> "已检测到 $planes 个平面，点击屏幕放置模型"
            else -> "已放置：单指旋转 · 双指缩放 · 点击重新放置"
        }
        setStatus(text)
    }

    // ---------------- AR 放置与手势 ----------------

    private fun onPlacementResult(placed: Boolean) {
        if (!arModeActive) return
        if (!placed) {
            setStatus("未命中平面：请对准检测到的平面（桌面/地面）点击")
            lastArStatusAt = SystemClock.uptimeMillis()
            return
        }
        val instance = lastModelInstance
        if (instance == null) {
            setStatus("请先加载模型")
            return
        }
        // 新放置点：手势归零，重新建树或复用
        gestureYawDeg = 0f
        gestureScale = 1f
        arGestures.reset()
        arPlaced = true
        attachModelToAnchor(instance)
        setStatus("已放置：单指旋转 · 双指缩放 · 点击重新放置")
        lastArStatusAt = SystemClock.uptimeMillis()
    }

    private fun attachModelToAnchor(instance: ModelInstance) {
        if (anchorNode == null) {
            val anchor = Node(binding.sceneView.engine)
            val gesture = Node(binding.sceneView.engine)
            anchor.addChildNode(gesture)
            // 等首个 Anchor 位姿到达（applyArSnapshots）后再显示，避免在世界原点闪一帧
            anchor.isVisible = false
            binding.sceneView.addChildNode(anchor)
            anchorNode = anchor
            gestureNode = gesture
        }
        arModelNode?.let { gestureNode?.removeChildNode(it) }
        releaseArticulation()
        val modelNode = createArModelNode(instance)
        gestureNode?.addChildNode(modelNode)
        arModelNode = modelNode
        createArticulation(modelNode)
        applyGestureToModel()
    }

    private fun createArModelNode(instance: ModelInstance): ModelNode {
        // 固定 1:1：保留原始尺寸与模型自身原点（房间模型地面通常在 y=0，可"走进去"）
        return ModelNode(modelInstance = instance, autoAnimate = false)
    }

    private fun applyGestureToModel() {
        gestureNode?.let {
            it.rotation = Rotation(y = gestureYawDeg)
            it.scale = Scale(gestureScale)
        }
    }

    // ---------------- 模型加载（M1，保留） ----------------

    private fun loadBundledDefault() {
        showLoading(true)
        try {
            val instance =
                binding.sceneView.modelLoader.createModelInstance("models/DamagedHelmet.glb")
            currentModelAsset = "models/DamagedHelmet.glb"
            currentModelPath = null
            animationInfo = GlbAnimationTargets.parseAsset(assets, "models/DamagedHelmet.glb")
            replaceModel(instance)
            setStatus("已加载内置示例模型，点击左上角选择本地模型")
        } catch (e: Exception) {
            setStatus("内置模型加载失败：${e.message}")
        } finally {
            showLoading(false)
        }
    }

    private fun loadModel(uri: Uri) {
        // 尝试持久化读取权限（重启后仍可访问）
        try {
            contentResolver.takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (_: Exception) {
        }

        showLoading(true)
        setStatus("正在加载…")
        lifecycleScope.launch {
            try {
                val file = withContext(Dispatchers.IO) {
                    // 每个模型独立目录，加载新模型前清空旧的缓存
                    File(cacheDir, "models").deleteRecursively()
                    val dir = File(cacheDir, "models/current").apply { mkdirs() }
                    copyToCache(uri, dir)
                }
                // .gltf 可能引用外部 .bin/贴图，先解析引用清单
                val refs = if (file.extension.equals("gltf", ignoreCase = true)) {
                    withContext(Dispatchers.IO) { findExternalRefs(file) }
                } else {
                    emptyList()
                }
                if (refs.isEmpty()) {
                    // 只读 JSON/BIN 里的动画信息，放到 IO 线程；解析失败返回空结果不影响加载
                    val animation = withContext(Dispatchers.IO) {
                        GlbAnimationTargets.parseFile(file)
                    }
                    // Filament 调用必须在主线程
                    val instance = binding.sceneView.modelLoader.createModelInstance(file)
                    currentModelPath = file.absolutePath
                    currentModelAsset = null
                    animationInfo = animation
                    replaceModel(instance)
                    setStatus("已加载：${displayName(uri)}")
                } else {
                    // 有外部引用：SAF 单文件选择拿不到同目录资源，引导用户补选
                    pendingGltfFile = file
                    pendingGltfDir = file.parentFile
                    pendingRefs = refs
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle("该 .gltf 引用了外部文件")
                        .setMessage(
                            "模型本体已就绪，还需要以下 ${refs.size} 个外部文件才能完整显示。\n\n" +
                                "请在接下来的多选框中把它们一并选中：\n\n" + refs.joinToString("\n")
                        )
                        .setPositiveButton("选择文件") { _, _ ->
                            pickAuxFiles.launch(arrayOf("*/*"))
                        }
                        .setNegativeButton("取消") { _, _ -> setStatus("已取消加载") }
                        .show()
                }
            } catch (e: Exception) {
                setStatus("")
                Toast.makeText(
                    this@MainActivity,
                    "模型加载失败：${e.message ?: "格式不支持或文件损坏"}",
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                showLoading(false)
            }
        }
    }

    /** 用户补选外部资源后：按原始相对路径拷入模型目录，齐了再加载 */
    private fun onAuxFilesPicked(uris: List<Uri>) {
        val gltfFile = pendingGltfFile
        val dir = pendingGltfDir
        val refs = pendingRefs
        if (gltfFile == null || dir == null) {
            setStatus("状态丢失，请重新选择模型")
            return
        }
        if (uris.isEmpty()) {
            setStatus("未选择外部文件，加载取消")
            return
        }
        showLoading(true)
        setStatus("正在拷贝外部文件…")
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    for (u in uris) {
                        val name = displayName(u)
                        // 按文件名匹配引用项（如 textures/wood.png 对应选中的 wood.png）
                        val target = refs.firstOrNull { it.substringAfterLast('/') == name }
                            ?: continue // 多选进来的无关文件直接忽略
                        val dest = File(dir, target)
                        dest.parentFile?.mkdirs()
                        contentResolver.openInputStream(u)?.use { input ->
                            dest.outputStream().use { output -> input.copyTo(output) }
                        } ?: throw IllegalStateException("无法读取：$name")
                    }
                }
                val missing = refs.filter { !File(dir, it).exists() }
                if (missing.isNotEmpty()) {
                    setStatus("")
                    Toast.makeText(
                        this@MainActivity,
                        "仍缺少 ${missing.size} 个文件，请重新选择模型后补齐：\n" +
                            missing.joinToString("\n"),
                        Toast.LENGTH_LONG
                    ).show()
                } else {
                    val animation = withContext(Dispatchers.IO) {
                        GlbAnimationTargets.parseFile(gltfFile)
                    }
                    val instance = binding.sceneView.modelLoader.createModelInstance(gltfFile)
                    currentModelPath = gltfFile.absolutePath
                    currentModelAsset = null
                    animationInfo = animation
                    replaceModel(instance)
                    setStatus("已加载：${gltfFile.name}（含 ${refs.size} 个外部文件）")
                }
            } catch (e: Exception) {
                setStatus("")
                Toast.makeText(
                    this@MainActivity,
                    "外部文件处理失败：${e.message}",
                    Toast.LENGTH_LONG
                ).show()
            } finally {
                showLoading(false)
            }
        }
    }

    /** 解析 .gltf JSON，提取 buffers/images 中的外部 URI（跳过 data: 内嵌），返回解码后的相对路径 */
    private fun findExternalRefs(gltfFile: File): List<String> {
        val json = JSONObject(gltfFile.readText())
        val refs = mutableListOf<String>()
        fun collect(arrayName: String) {
            val arr = json.optJSONArray(arrayName) ?: return
            for (i in 0 until arr.length()) {
                val u = arr.optJSONObject(i)?.optString("uri").orEmpty()
                if (u.isNotEmpty() && !u.startsWith("data:")) {
                    val decoded = Uri.decode(u)
                    if (decoded.isNotEmpty()) refs += decoded
                }
            }
        }
        collect("buffers")
        collect("images")
        return refs.distinct()
    }

    private fun replaceModel(instance: ModelInstance) {
        lastModelInstance = instance
        releaseArticulation()
        if (arModeActive) {
            // AR 模式：不直接上屏，等点击放置；已放置则原地热替换
            if (arPlaced && anchorNode != null) {
                attachModelToAnchor(instance)
                setStatus("模型已更新：单指旋转 · 双指缩放 · 点击重新放置")
            } else {
                setStatus("模型已就绪，点击平面放置")
            }
            return
        }
        currentNode?.let { binding.sceneView.removeChildNode(it) }
        // 固定 1:1：保留模型原始尺寸，居中于原点。
        // autoAnimate = false：否则 SceneView 会让所有柜门/窗扇无限循环开合。
        val node = ModelNode(
            modelInstance = instance,
            autoAnimate = false,
            centerOrigin = Position(y = 0.0f)
        )
        binding.sceneView.addChildNode(node)
        currentNode = node
        createArticulation(node)
    }

    private fun copyToCache(uri: Uri, dir: File): File {
        val name = displayName(uri).ifBlank { "model.glb" }
        val file = File(dir, name)
        contentResolver.openInputStream(uri)?.use { input ->
            file.outputStream().use { output -> input.copyTo(output) }
        } ?: throw IllegalStateException("无法读取所选文件")
        return file
    }

    private fun displayName(uri: Uri): String {
        val cursor = contentResolver.query(uri, null, null, null, null)
        cursor?.use {
            val idx = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (idx >= 0 && it.moveToFirst()) return it.getString(idx) ?: ""
        }
        return uri.lastPathSegment ?: ""
    }

    // ---------------- 工具 ----------------

    private fun currentDisplayRotation(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.rotation
        }
    }

    private fun showLoading(show: Boolean) {
        binding.loadingView.visibility = if (show) View.VISIBLE else View.GONE
    }

    private fun setStatus(text: String) {
        binding.tvStatus.text = text
    }
}
