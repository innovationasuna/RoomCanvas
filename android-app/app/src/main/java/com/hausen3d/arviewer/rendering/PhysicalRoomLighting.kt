package com.hausen3d.arviewer.rendering

import android.util.Log
import com.google.android.filament.Box
import com.google.android.filament.Colors
import com.google.android.filament.EntityManager
import com.google.android.filament.LightManager
import com.google.android.filament.View
import io.github.sceneview.SceneView
import io.github.sceneview.environment.Environment
import io.github.sceneview.node.ModelNode

/**
 * RoomCanvas 物理配方的实时移动端版本：IBL + 顶灯 + 窗户入光。
 * 不使用日光与实时阴影；接触暗部由 SSAO 提供。
 */
class PhysicalRoomLighting(private val sceneView: SceneView) {
    companion object {
        const val ENVIRONMENT_INTENSITY = 5.00f
        private const val TAG = "PhysicalRoomLighting"
    }

    private val lightEntities = mutableListOf<Int>()
    // Keep the actual scene bindings: SceneView.environment can be stale after
    // assigning indirectLight or skybox directly. The loaders own these objects.
    private val originalMainLight = sceneView.mainLightNode
    private val originalIndirectLight = sceneView.indirectLight
    private val originalEnvironmentIntensity = originalIndirectLight?.intensity
    private val originalSkybox = sceneView.skybox
    private val originalAperture = sceneView.cameraNode.aperture
    private val originalShutterSpeed = sceneView.cameraNode.shutterSpeed
    private val originalSensitivity = sceneView.cameraNode.sensitivity
    private var roomEnvironment: Environment? = Environment(
        indirectLight = originalIndirectLight,
        skybox = originalSkybox,
        sphericalHarmonics = null
    )
    private var localLightPlan = emptyList<RoomLightSpec>()
    private var authoredLightCount = 0

    var quality = RoomRenderQuality.BASELINE
        private set

    var debugLightSummary = "lights=0"
        private set

    init {
        applyQuality(RoomRenderQuality.BASELINE)
    }

    /** A missing or failed HDR keeps the original illumination until usable. */
    fun setEnvironment(environment: Environment?) {
        if (roomEnvironment === environment) return
        roomEnvironment = environment
        applyLighting()
    }

    fun applyQuality(value: RoomRenderQuality) {
        quality = value
        sceneView.view.apply {
            // 产品不使用实时阴影：全局关闭，材质与灯光均不参与阴影 pass。
            setShadowingEnabled(false)
            toneMapping = View.ToneMapping.ACES
            setAmbientOcclusion(View.AmbientOcclusion.SSAO)
            ambientOcclusionOptions = ambientOcclusionOptions.apply {
                enabled = value.ssaoEnabled
                radius = 0.35f
                intensity = 0.65f
                resolution = 0.5f
                quality = View.QualityLevel.MEDIUM
                lowPassFilter = View.QualityLevel.MEDIUM
                upsampling = View.QualityLevel.MEDIUM
            }
            dynamicResolutionOptions = dynamicResolutionOptions.apply {
                enabled = value.resolutionScale < 0.999f
                minScale = value.resolutionScale
                maxScale = value.resolutionScale
                homogeneousScaling = true
                quality = if (enabled) View.QualityLevel.LOW else View.QualityLevel.MEDIUM
            }
        }
    }

    fun applyTo(modelNode: ModelNode) {
        modelNode.isShadowCaster = false
        modelNode.isShadowReceiver = false

        // glTF 自带灯具时优先使用，不再叠加自动灯光。
        authoredLightCount = modelNode.lightNodes.size
        localLightPlan = if (authoredLightCount > 0) {
            modelNode.lightNodes.forEach { it.isShadowCaster = false }
            emptyList()
        } else {
            val parts = collectNamedBounds(modelNode)
            val room = RoomLightLayout.shellBounds(parts, modelNode.boundingBox.toRoomBounds())
            RoomLightLayout.plan(room, parts)
        }
        applyLighting()
    }

    private fun applyLighting() {
        clearLights()
        val environment = roomEnvironment
        val indirectLight = environment?.indirectLight
        if (indirectLight == null || (localLightPlan.isEmpty() && authoredLightCount == 0)) {
            originalEnvironmentIntensity?.let { originalIndirectLight?.intensity = it }
            sceneView.indirectLight = originalIndirectLight
            sceneView.skybox = originalSkybox
            sceneView.mainLightNode = originalMainLight
            sceneView.cameraNode.setExposure(originalAperture, originalShutterSpeed, originalSensitivity)
            val reason = if (indirectLight == null) "environment-unavailable" else "unrecognized-room"
            debugLightSummary = "lights=$authoredLightCount ceiling=0 window=0 " +
                "gltfLights=${authoredLightCount > 0} fallback=$reason"
            Log.i(TAG, "房间照明：保留原有照明，$debugLightSummary")
            return
        }

        // Switch exposure, environment and local lights together; a failed HDR
        // or unrecognized room must not be left with only the dim physical IBL.
        sceneView.mainLightNode = null
        sceneView.cameraNode.setExposure(0.7f, 1.0f / 125.0f, 100.0f)
        indirectLight.intensity = ENVIRONMENT_INTENSITY
        sceneView.indirectLight = indirectLight
        sceneView.skybox = environment.skybox
        val localLights = localLightPlan
        localLights.forEach(::createLocalLight)
        debugLightSummary = "lights=${lightEntities.size + authoredLightCount} " +
            "ceiling=${localLights.count { it.kind == RoomLightKind.CEILING }} " +
            "window=${localLights.count { it.kind == RoomLightKind.WINDOW }} " +
            "gltfLights=${authoredLightCount > 0}"
        Log.i(
            TAG,
            "物理光影：局部灯 ${localLights.size} 盏，$debugLightSummary，" +
                "ACES + SSAO=${quality.ssaoEnabled}"
        )
    }

    fun clearLights() {
        lightEntities.forEach { entity ->
            sceneView.scene.removeEntity(entity)
            sceneView.engine.lightManager.destroy(entity)
            EntityManager.get().destroy(entity)
        }
        lightEntities.clear()
    }

    private fun createLocalLight(spec: RoomLightSpec) {
        val color = Colors.illuminantD(spec.temperatureKelvin)
        val builder = LightManager.Builder(
            if (spec.direction != null) {
                LightManager.Type.FOCUSED_SPOT
            } else {
                LightManager.Type.POINT
            }
        )
            .position(spec.position.x, spec.position.y, spec.position.z)
            .color(color[0], color[1], color[2])
            .intensity(spec.watts, LightManager.EFFICIENCY_LED)
            .falloff(spec.falloff)
            .castShadows(false)

        spec.direction?.let {
            builder.direction(it.x, it.y, it.z)
            val (innerDegrees, outerDegrees) = if (spec.kind == RoomLightKind.CEILING) {
                60.0 to 85.0
            } else {
                45.0 to 85.0
            }
            builder.spotLightCone(
                Math.toRadians(innerDegrees).toFloat(),
                Math.toRadians(outerDegrees).toFloat()
            )
        }
        val entity = EntityManager.get().create()
        builder.build(sceneView.engine, entity)
        sceneView.scene.addEntity(entity)
        lightEntities += entity
    }

    private fun collectNamedBounds(modelNode: ModelNode): List<NamedRoomBounds> {
        val asset = modelNode.model
        val renderableManager = sceneView.engine.renderableManager
        val transformManager = sceneView.engine.transformManager
        val names = asset.entities.associateWith { asset.getName(it).orEmpty() }
        fun ancestors(entity: Int): List<String> {
            val path = mutableListOf<String>()
            var parent = transformManager.getParent(transformManager.getInstance(entity))
            while (parent in names) {
                names[parent]?.takeIf { it.isNotEmpty() }?.let(path::add)
                if (!transformManager.hasComponent(parent)) break
                parent = transformManager.getParent(transformManager.getInstance(parent))
            }
            return path.asReversed()
        }
        return asset.renderableEntities.toList().mapNotNull { entity ->
            val name = asset.getName(entity).orEmpty()
            if (!transformManager.hasComponent(entity)) return@mapNotNull null
            val renderable = renderableManager.getInstance(entity)
            val box = renderableManager.getAxisAlignedBoundingBox(renderable, Box())
            val transform = transformManager.getWorldTransform(
                transformManager.getInstance(entity),
                FloatArray(16)
            )
            NamedRoomBounds(name, box.transform(transform), ancestors(entity))
        }
    }

    private fun Box.toRoomBounds(): RoomBounds {
        val c = center
        val h = halfExtent
        return RoomBounds(
            min = Vec3(c[0] - h[0], c[1] - h[1], c[2] - h[2]),
            max = Vec3(c[0] + h[0], c[1] + h[1], c[2] + h[2])
        )
    }

    private fun Box.transform(matrix: FloatArray): RoomBounds {
        val local = toRoomBounds()
        var minX = Float.POSITIVE_INFINITY
        var minY = Float.POSITIVE_INFINITY
        var minZ = Float.POSITIVE_INFINITY
        var maxX = Float.NEGATIVE_INFINITY
        var maxY = Float.NEGATIVE_INFINITY
        var maxZ = Float.NEGATIVE_INFINITY
        for (corner in 0 until 8) {
            val x = if (corner and 1 == 0) local.min.x else local.max.x
            val y = if (corner and 2 == 0) local.min.y else local.max.y
            val z = if (corner and 4 == 0) local.min.z else local.max.z
            val worldX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
            val worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
            val worldZ = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
            minX = minOf(minX, worldX)
            minY = minOf(minY, worldY)
            minZ = minOf(minZ, worldZ)
            maxX = maxOf(maxX, worldX)
            maxY = maxOf(maxY, worldY)
            maxZ = maxOf(maxZ, worldZ)
        }
        return RoomBounds(Vec3(minX, minY, minZ), Vec3(maxX, maxY, maxZ))
    }
}
