package com.hausen3d.arviewer.rendering

import android.util.Log
import com.google.android.filament.Box
import com.google.android.filament.Colors
import com.google.android.filament.EntityManager
import com.google.android.filament.LightManager
import com.google.android.filament.View
import io.github.sceneview.SceneView
import io.github.sceneview.node.ModelNode

/**
 * RoomCanvas physical 配方的实时移动端版本：IBL + 日光 + 顶灯 + 窗户入光。
 * Blender 的 Nishita/面积光/路径追踪在这里分别由 HDR IBL、聚光/点光与 PCSS 近似。
 */
class PhysicalRoomLighting(private val sceneView: SceneView) {
    companion object {
        const val ENVIRONMENT_INTENSITY = 0.25f
        private const val TAG = "PhysicalRoomLighting"
        private const val SUN_INTENSITY_LUX = 2500f
        private const val SUN_TEMPERATURE_K = 6500f
        private const val LOCAL_SHADOW_MAP_SIZE = 512
    }

    private val lightEntities = mutableListOf<Int>()

    var quality = RoomRenderQuality.BASELINE
        private set

    var debugLightSummary = "lights=0 shadowRequests=0"
        private set

    init {
        // 禁用 SceneView 默认的 100000 lux 主光，避免材质被照成一片白色。
        sceneView.mainLightNode = null
        sceneView.cameraNode.setExposure(0.7f, 1.0f / 125.0f, 100.0f)
        applyQuality(RoomRenderQuality.BASELINE)
    }

    fun applyQuality(value: RoomRenderQuality) {
        quality = value
        sceneView.view.apply {
            setShadowingEnabled(value.shadowsEnabled)
            setShadowType(
                when (value.shadowFilter) {
                    ShadowFilter.PCSS -> View.ShadowType.PCSS
                    ShadowFilter.DPCF -> View.ShadowType.DPCF
                    ShadowFilter.PCF -> View.ShadowType.PCF
                }
            )
            softShadowOptions = View.SoftShadowOptions().apply {
                penumbraScale = 1.0f
                penumbraRatioScale = 1.0f
            }
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
        clearLights()
        modelNode.isShadowCaster = true
        modelNode.isShadowReceiver = true

        // 与参考实现一致：glTF 已包含灯具时优先使用，不再叠加自动灯光。
        if (modelNode.lightNodes.isNotEmpty()) {
            val lightManager = sceneView.engine.lightManager
            var retainedWindowShadow = false
            modelNode.lightNodes.forEach { light ->
                val instance = lightManager.getInstance(light.entity)
                val type = if (instance != 0) lightManager.getType(instance) else null
                val isSpot = type == LightManager.Type.SPOT || type == LightManager.Type.FOCUSED_SPOT
                val castShadows = if (quality.singleWindowShadowOnly) {
                    isSpot && !retainedWindowShadow
                } else {
                    true
                }
                if (castShadows && isSpot) retainedWindowShadow = true
                light.isShadowCaster = castShadows
            }
            debugLightSummary = "lights=${modelNode.lightNodes.size} " +
                "shadowRequests=${modelNode.lightNodes.count { it.isShadowCaster }} gltfLights=true"
            Log.i(TAG, "物理光影：使用模型自带的 ${modelNode.lightNodes.size} 盏灯")
            return
        }

        val parts = collectNamedBounds(modelNode)
        val room = RoomLightLayout.shellBounds(parts, modelNode.boundingBox.toRoomBounds())
        createSun()
        val localLights = RoomLightLayout.plan(room, parts)
        var retainedWindowShadow = false
        var shadowRequests = 1
        localLights.forEach { spec ->
            val castShadows = if (quality.singleWindowShadowOnly) {
                spec.kind == RoomLightKind.WINDOW && !retainedWindowShadow
            } else {
                true
            }
            if (castShadows && spec.kind == RoomLightKind.WINDOW) retainedWindowShadow = true
            if (castShadows) shadowRequests++
            createLocalLight(spec, castShadows)
        }
        debugLightSummary = "lights=${lightEntities.size} shadowRequests=$shadowRequests " +
            "ceiling=${localLights.count { it.kind == RoomLightKind.CEILING }} " +
            "window=${localLights.count { it.kind == RoomLightKind.WINDOW }} gltfLights=false"
        Log.i(
            TAG,
            "物理光影：日光 2500 lux，局部灯 ${localLights.size} 盏，" +
                "$debugLightSummary，ACES + ${quality.shadowFilter} + SSAO=${quality.ssaoEnabled}"
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

    private fun createSun() {
        val direction = RoomLightLayout.sunDirection()
        val color = Colors.illuminantD(SUN_TEMPERATURE_K)
        val shadow = LightManager.ShadowOptions().apply {
            mapSize = quality.sunShadowMapSize
            shadowCascades = quality.sunCascadeCount
            stable = true
        }
        val entity = EntityManager.get().create()
        LightManager.Builder(LightManager.Type.SUN)
            .direction(direction.x, direction.y, direction.z)
            .color(color[0], color[1], color[2])
            .intensity(SUN_INTENSITY_LUX)
            .sunAngularRadius(Math.toRadians(1.5).toFloat())
            .castShadows(true)
            .shadowOptions(shadow)
            .build(sceneView.engine, entity)
        sceneView.scene.addEntity(entity)
        lightEntities += entity
    }

    private fun createLocalLight(spec: RoomLightSpec, castShadows: Boolean) {
        val color = Colors.illuminantD(spec.temperatureKelvin)
        val shadow = LightManager.ShadowOptions().apply {
            mapSize = LOCAL_SHADOW_MAP_SIZE
            shadowFar = spec.falloff
            shadowBulbRadius = spec.bulbRadius
        }
        val builder = LightManager.Builder(
            if (spec.kind == RoomLightKind.WINDOW) {
                LightManager.Type.FOCUSED_SPOT
            } else {
                LightManager.Type.POINT
            }
        )
            .position(spec.position.x, spec.position.y, spec.position.z)
            .color(color[0], color[1], color[2])
            .intensity(spec.watts, LightManager.EFFICIENCY_LED)
            .falloff(spec.falloff)
            .castShadows(castShadows)
            .shadowOptions(shadow)

        spec.direction?.let {
            builder.direction(it.x, it.y, it.z)
            builder.spotLightCone(Math.toRadians(45.0).toFloat(), Math.toRadians(85.0).toFloat())
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
        return asset.renderableEntities.toList().mapNotNull { entity ->
            val name = asset.getName(entity).orEmpty()
            if (name.isEmpty() || !transformManager.hasComponent(entity)) return@mapNotNull null
            val renderable = renderableManager.getInstance(entity)
            val box = renderableManager.getAxisAlignedBoundingBox(renderable, Box())
            val transform = transformManager.getWorldTransform(
                transformManager.getInstance(entity),
                FloatArray(16)
            )
            NamedRoomBounds(name, box.transform(transform))
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
