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
 * RoomCanvas 物理配方的实时移动端版本：IBL + 顶灯 + 窗户入光。
 * 不使用日光与实时阴影；接触暗部由 SSAO 提供。
 */
class PhysicalRoomLighting(private val sceneView: SceneView) {
    companion object {
        const val ENVIRONMENT_INTENSITY = 5.00f
        private const val TAG = "PhysicalRoomLighting"
    }

    private val lightEntities = mutableListOf<Int>()

    var quality = RoomRenderQuality.BASELINE
        private set

    var debugLightSummary = "lights=0"
        private set

    init {
        // 不使用 SceneView 默认主光；房间照明由局部灯 + IBL 提供。
        sceneView.mainLightNode = null
        sceneView.cameraNode.setExposure(0.7f, 1.0f / 125.0f, 100.0f)
        applyQuality(RoomRenderQuality.BASELINE)
    }

    fun applyQuality(value: RoomRenderQuality) {
        quality = value
        sceneView.view.apply {
            // 产品不使用实时阴影：全局关闭，材质与灯光均不参与阴影 pass。
            setShadowingEnabled(false)
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
        modelNode.isShadowCaster = false
        modelNode.isShadowReceiver = false

        // glTF 自带灯具时优先使用，不再叠加自动灯光。
        if (modelNode.lightNodes.isNotEmpty()) {
            modelNode.lightNodes.forEach { it.isShadowCaster = false }
            debugLightSummary = "lights=${modelNode.lightNodes.size} gltfLights=true"
            Log.i(TAG, "物理光影：使用模型自带的 ${modelNode.lightNodes.size} 盏灯（无实时阴影）")
            return
        }

        val parts = collectNamedBounds(modelNode)
        val room = RoomLightLayout.shellBounds(parts, modelNode.boundingBox.toRoomBounds())
        val localLights = RoomLightLayout.plan(room, parts)
        localLights.forEach(::createLocalLight)
        debugLightSummary = "lights=${lightEntities.size} " +
            "ceiling=${localLights.count { it.kind == RoomLightKind.CEILING }} " +
            "window=${localLights.count { it.kind == RoomLightKind.WINDOW }} gltfLights=false"
        Log.i(
            TAG,
            "物理光影：局部灯 ${localLights.size} 盏，$debugLightSummary，" +
                "SSAO=${quality.ssaoEnabled}"
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

    /** Release our entity IDs even if SceneView has already destroyed its engine. */
    fun release() {
        // SceneView also destroys itself through its lifecycle observer and window detach.
        // Its Scene may already be gone when Activity.onDestroy reaches us.
        val engine = sceneView.engine
        lightEntities.forEach { entity ->
            if (engine.isValid) {
                engine.lightManager.destroy(entity)
            }
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
