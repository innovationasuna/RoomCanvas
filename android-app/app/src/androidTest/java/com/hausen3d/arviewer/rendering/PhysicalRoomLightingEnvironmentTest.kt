package com.hausen3d.arviewer.rendering

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.filament.EntityManager
import com.google.android.filament.IndirectLight
import com.google.android.filament.LightManager
import com.google.android.filament.Skybox
import com.hausen3d.arviewer.R
import com.hausen3d.arviewer.VrWalkthroughActivity
import io.github.sceneview.SceneView
import io.github.sceneview.environment.Environment
import io.github.sceneview.node.LightNode
import io.github.sceneview.node.ModelNode
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.sqrt

/** Actual SceneView, glTF loading and Filament JNI; no mocked lighting state. */
@RunWith(AndroidJUnit4::class)
class PhysicalRoomLightingEnvironmentTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test
    fun constructionAndEnvironmentWithoutAModelKeepActualDefaults() = withRig { rig ->
        rig.assertDefaults()
        // Direct bindings deliberately differ from SceneView.environment.
        assertNotSame(rig.defaults.indirectLight, rig.scene.environment.indirectLight)
        assertNotSame(rig.defaults.skybox, rig.scene.environment.skybox)

        rig.lighting.setEnvironment(rig.environment())

        rig.assertDefaults()
        assertEquals(setOf(rig.defaults.mainLight!!.entity), rig.scene.lightEntities())
    }

    @Test
    fun emptyPlanRestoresOriginalReferencesIntensityAndExposureAfterPhysicalLighting() = withRig { rig ->
        // The direct caller still uses its actual original IBL when none was supplied.
        rig.lighting.applyTo(addModel(rig.scene, ordinaryRoom()))
        assertSame(rig.defaults.indirectLight, rig.scene.indirectLight)
        assertEquals(5f, rig.scene.indirectLight!!.intensity, 0f)
        assertPhysicalExposure(rig.scene)
        val automaticLights = rig.scene.lightEntities()
        assertEquals(1, automaticLights.size)

        val unknown = addModel(rig.scene, ordinaryRoom(recognized = false))
        rig.lighting.applyTo(unknown)

        rig.assertDefaults()
        assertReleased(rig.scene, automaticLights)
        assertEquals(setOf(rig.defaults.mainLight!!.entity), rig.scene.lightEntities())

        val hdr = rig.environment()
        rig.lighting.setEnvironment(hdr)
        rig.assertDefaults() // An HDR alone must not darken an unrecognized model.
        rig.lighting.applyTo(addModel(rig.scene, ordinaryRoom()))
        assertPhysical(rig.scene, hdr)
        rig.lighting.applyTo(unknown)
        rig.assertDefaults()
    }

    @Test
    fun missingOrIncompleteEnvironmentRestoresDefaultsAndCanRecover() = withRig { rig ->
        val hdr = rig.environment()
        rig.lighting.setEnvironment(hdr)
        rig.lighting.applyTo(addModel(rig.scene, ordinaryRoom()))
        assertPhysical(rig.scene, hdr)
        val firstLights = rig.scene.lightEntities()

        rig.lighting.setEnvironment(null)

        rig.assertDefaults()
        assertReleased(rig.scene, firstLights)
        rig.lighting.setEnvironment(hdr)
        assertPhysical(rig.scene, hdr)
        assertEquals(1, rig.scene.lightEntities().size)

        // An Environment object without an IBL is still a failed environment.
        rig.lighting.setEnvironment(Environment(indirectLight = null, skybox = hdr.skybox))
        rig.assertDefaults()
        rig.lighting.setEnvironment(hdr)
        assertPhysical(rig.scene, hdr)
        assertEquals(1, rig.scene.lightEntities().size)
    }

    @Test
    fun modelAndHdrArrivalOrdersProduceTheSameNativeLighting() {
        val modelFirst = withRig { rig ->
            rig.lighting.setEnvironment(null)
            rig.lighting.applyTo(addModel(rig.scene, ordinaryRoom()))
            rig.assertDefaults()
            val hdr = rig.environment()
            rig.lighting.setEnvironment(hdr)
            assertPhysical(rig.scene, hdr)
            rig.scene.nativeLights()
        }
        val environmentFirst = withRig { rig ->
            val hdr = rig.environment()
            rig.lighting.setEnvironment(hdr)
            rig.assertDefaults()
            rig.lighting.applyTo(addModel(rig.scene, ordinaryRoom()))
            assertPhysical(rig.scene, hdr)
            rig.scene.nativeLights()
        }
        for (lights in listOf(modelFirst, environmentFirst)) {
            assertEquals(1, lights.size)
            val ceiling = lights.single()
            assertEquals(LightManager.Type.FOCUSED_SPOT, ceiling.type)
            assertVector(floatArrayOf(0f, 2.65f, 0f), ceiling.position)
            assertVector(floatArrayOf(0f, -1f, 0f), ceiling.direction)
            assertTrue(ceiling.intensity > 0f)
        }
        assertEquals(modelFirst, environmentFirst)
    }

    @Test
    fun gltfLightsKeepTheirIdentityAndIntensityAcrossEnvironmentChanges() = withRig { rig ->
        val hdr = rig.environment()
        rig.lighting.setEnvironment(hdr)
        rig.lighting.applyTo(addModel(rig.scene, ordinaryRoom()))
        val automaticLights = rig.scene.lightEntities()
        val model = addModel(rig.scene, ordinaryRoom(gltfLight = true))
        val authored = model.lightNodes.map { it.entity }.toSet()
        assertEquals(1, authored.size)
        val manager = rig.scene.engine.lightManager
        val intensity = manager.getIntensity(manager.getInstance(authored.single()))

        rig.lighting.applyTo(model)

        assertReleased(rig.scene, automaticLights)
        assertPhysical(rig.scene, hdr)
        assertEquals(authored, rig.scene.lightEntities())
        assertEquals(intensity, manager.getIntensity(manager.getInstance(authored.single())), 0f)

        rig.lighting.setEnvironment(null)
        rig.assertDefaults()
        assertEquals(authored + rig.defaults.mainLight!!.entity, rig.scene.lightEntities())
        assertTrue(EntityManager.get().isAlive(authored.single()))
        assertTrue(manager.hasComponent(authored.single()))
        assertEquals(intensity, manager.getIntensity(manager.getInstance(authored.single())), 0f)

        val replacement = rig.environment()
        rig.lighting.setEnvironment(replacement)
        assertPhysical(rig.scene, replacement)
        assertEquals(authored, rig.scene.lightEntities())
        assertEquals(intensity, manager.getIntensity(manager.getInstance(authored.single())), 0f)
    }

    @Test
    fun transformedWindowDescendantsShareOneLightAndIgnoreIndependentCurtainsAndBackdrop() = withRig { rig ->
        val hdr = rig.environment()
        rig.lighting.setEnvironment(hdr)
        rig.lighting.applyTo(addModel(rig.scene, hierarchicalRoom()))
        assertPhysical(rig.scene, hdr)
        val lights = rig.scene.nativeLights()
        assertEquals("One ceiling and one grouped Window0 light", 2, lights.size)
        val ceiling = lights.single { abs(it.direction[0]) < 1e-5f && abs(it.direction[2]) < 1e-5f }
        val window = lights.single { it !== ceiling }
        assertVector(floatArrayOf(10f, 3.65f, 20f), ceiling.position)
        assertVector(floatArrayOf(0f, -1f, 0f), ceiling.direction)

        // Root translation/yaw maps the two window children to center (10,2.5,24).
        // Floor/wall/ceiling shell center is (9.975,*,20), excluding the huge helpers.
        val dx = -0.025f
        val dz = -4f
        val horizontalLength = sqrt(dx * dx + dz * dz)
        val x = dx / horizontalLength
        val z = dz / horizontalLength
        assertVector(floatArrayOf(10f + x * 0.08f, 2.5f, 24f + z * 0.08f), window.position)
        val directionLength = sqrt(1.01f)
        assertVector(floatArrayOf(x / directionLength, -0.10f / directionLength, z / directionLength), window.direction)
    }

    @Test
    fun activityCompletingHdrWithoutAModelDoesNotInitializeLightingOrChangeDefaults() {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.CAMERA)
        val prefs = context.getSharedPreferences("vr_walkthrough", Context.MODE_PRIVATE)
        val oldPath = prefs.getString("last_model_path", null)
        val oldName = prefs.getString("last_model_name", null)
        try {
            assertTrue(prefs.edit().remove("last_model_path").remove("last_model_name").commit())
            val scenario = ActivityScenario.launch<VrWalkthroughActivity>(Intent(context, VrWalkthroughActivity::class.java))
            lateinit var scene: SceneView
            lateinit var defaults: Defaults
            // Observe existing private completion state, without adding production test hooks.
            val environmentField = VrWalkthroughActivity::class.java.getDeclaredField("roomEnvironment").apply { isAccessible = true }
            val lightingField = VrWalkthroughActivity::class.java.declaredFields.first {
                it.name == "roomLighting\$delegate" || it.name == "roomLightingDelegate"
            }.apply { isAccessible = true }
            try {
                scenario.onActivity {
                    scene = it.findViewById(R.id.sceneView)
                    defaults = Defaults.capture(scene)
                    assertTrue(scene.childNodes.filterIsInstance<ModelNode>().isEmpty())
                    assertFalse((lightingField.get(it) as Lazy<*>).isInitialized())
                }
                await("Bundled HDR did not finish loading") {
                    var loaded = false
                    scenario.onActivity {
                        loaded = (environmentField.get(it) as Environment?)?.indirectLight != null
                    }
                    loaded
                }
                scenario.onActivity {
                    defaults.assertRestored(scene)
                    assertFalse((lightingField.get(it) as Lazy<*>).isInitialized())
                }
            } finally {
                scenario.close()
                await("Activity engine remained alive") { onMain { !scene.engine.isValid } }
            }
        } finally {
            prefs.edit().putString("last_model_path", oldPath).putString("last_model_name", oldName).commit()
        }
    }

    private data class Defaults(
        val mainLight: LightNode?,
        val indirectLight: IndirectLight?,
        val intensity: Float?,
        val skybox: Skybox?,
        val aperture: Float,
        val shutterSpeed: Float,
        val sensitivity: Float
    ) {
        fun assertRestored(scene: SceneView) {
            assertSame(mainLight, scene.mainLightNode)
            assertSame(indirectLight, scene.indirectLight)
            intensity?.let { assertEquals(it, scene.indirectLight!!.intensity, 0f) }
            assertSame(skybox, scene.skybox)
            assertEquals(aperture, scene.cameraNode.aperture, 0f)
            assertEquals(shutterSpeed, scene.cameraNode.shutterSpeed, 0f)
            assertEquals(sensitivity, scene.cameraNode.sensitivity, 0f)
        }

        companion object {
            fun capture(scene: SceneView) = Defaults(scene.mainLightNode, scene.indirectLight,
                scene.indirectLight?.intensity, scene.skybox, scene.cameraNode.aperture,
                scene.cameraNode.shutterSpeed, scene.cameraNode.sensitivity)
        }
    }

    private inner class Rig(val scene: SceneView) {
        val ownedIndirectLights = mutableListOf<IndirectLight>()
        val ownedSkyboxes = mutableListOf<Skybox>()
        val defaults: Defaults
        val lighting: PhysicalRoomLighting

        init {
            val actual = environment()
            actual.indirectLight!!.intensity = 321.5f
            scene.indirectLight = actual.indirectLight
            scene.skybox = actual.skybox
            scene.cameraNode.setExposure(4.5f, 1f / 80f, 320f)
            assertNotNull(scene.mainLightNode)
            defaults = Defaults.capture(scene)
            lighting = PhysicalRoomLighting(scene)
        }

        fun environment(): Environment {
            val sh = FloatArray(27).also { it[0] = 0.2f; it[1] = 0.3f; it[2] = 0.4f }
            val ibl = IndirectLight.Builder().irradiance(3, sh).intensity(750f).build(scene.engine)
            val sky = Skybox.Builder().color(0.1f, 0.2f, 0.3f, 1f).build(scene.engine)
            ownedIndirectLights += ibl
            ownedSkyboxes += sky
            return Environment(indirectLight = ibl, skybox = sky)
        }

        fun assertDefaults() = defaults.assertRestored(scene)
    }

    private fun <T> withRig(block: (Rig) -> T): T {
        val rig = onMain { Rig(SceneView(context)) }
        try {
            return onMain { block(rig) }
        } finally {
            onMain {
                rig.lighting.clearLights()
                rig.scene.indirectLight = null
                rig.scene.skybox = null
                rig.ownedIndirectLights.forEach { rig.scene.engine.destroyIndirectLight(it) }
                rig.ownedSkyboxes.forEach { rig.scene.engine.destroySkybox(it) }
                rig.scene.destroy()
            }
            await("Filament engine remained alive after cleanup") { onMain { !rig.scene.engine.isValid } }
        }
    }

    private data class NativeLight(
        val type: LightManager.Type, val position: List<Float>, val direction: List<Float>,
        val color: List<Float>, val intensity: Float
    )

    private fun SceneView.lightEntities(): Set<Int> =
        scene.entities.filter { engine.lightManager.hasComponent(it) }.toSet()

    private fun SceneView.nativeLights(): List<NativeLight> {
        val manager = engine.lightManager
        return lightEntities().map { entity ->
            val instance = manager.getInstance(entity)
            NativeLight(manager.getType(instance), manager.getPosition(instance, FloatArray(3)).toList(),
                manager.getDirection(instance, FloatArray(3)).toList(), manager.getColor(instance, FloatArray(3)).toList(),
                manager.getIntensity(instance))
        }
    }

    private fun assertPhysical(scene: SceneView, environment: Environment) {
        assertNull(scene.mainLightNode)
        assertSame(environment.indirectLight, scene.indirectLight)
        assertSame(environment.skybox, scene.skybox)
        assertEquals(5f, scene.indirectLight!!.intensity, 0f)
        assertPhysicalExposure(scene)
    }

    private fun assertPhysicalExposure(scene: SceneView) {
        assertEquals(0.7f, scene.cameraNode.aperture, 0f)
        assertEquals(1f / 125f, scene.cameraNode.shutterSpeed, 0f)
        assertEquals(100f, scene.cameraNode.sensitivity, 0f)
    }

    private fun assertReleased(scene: SceneView, ids: Set<Int>) {
        ids.forEach {
            assertFalse(EntityManager.get().isAlive(it))
            assertFalse(scene.engine.lightManager.hasComponent(it))
        }
    }

    private fun assertVector(expected: FloatArray, actual: List<Float>) {
        assertEquals(expected.size, actual.size)
        expected.indices.forEach { assertEquals("axis " + it, expected[it], actual[it], 0.001f) }
    }

    private fun await(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 30_000
        do {
            if (condition()) return
            SystemClock.sleep(50)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError(message)
    }

    private fun <T> onMain(block: () -> T): T {
        val result = AtomicReference<Result<T>>()
        instrumentation.runOnMainSync { result.set(runCatching(block)) }
        return result.get().getOrThrow()
    }

    private fun addModel(scene: SceneView, bytes: ByteArray): ModelNode {
        val buffer = ByteBuffer.allocateDirect(bytes.size).apply { put(bytes); flip() }
        return ModelNode(scene.modelLoader.createModelInstance(buffer), autoAnimate = false).also(scene::addChildNode)
    }

    private fun ordinaryRoom(recognized: Boolean = true, gltfLight: Boolean = false): ByteArray {
        val nodes = mutableListOf(node(if (recognized) "Ceiling0" else "UnrecognizedMesh", mesh = true,
            translation = floatArrayOf(0f, 3f, 0f), scale = floatArrayOf(2f, 0.1f, 2f)))
        if (gltfLight) nodes += node("AuthoredLight", translation = floatArrayOf(0f, 2f, 1f)).apply {
            put("extensions", JSONObject().put("KHR_lights_punctual", JSONObject().put("light", 0)))
        }
        return glb(nodes, nodes.indices.toList(), gltfLight)
    }

    private fun hierarchicalRoom(): ByteArray {
        val q = sqrt(0.5f)
        val nodes = listOf(
            node("RoomRoot", translation = floatArrayOf(10f, 1f, 20f), children = listOf(1, 2, 3, 4, 7, 8)).apply {
                put("rotation", JSONArray(listOf(0f, q, 0f, q)))
            },
            node("Floor0", mesh = true, translation = floatArrayOf(0f, -0.05f, 0f), scale = floatArrayOf(8f, 0.1f, 6f)),
            node("Wall0", mesh = true, translation = floatArrayOf(0f, 1.5f, -3f), scale = floatArrayOf(8f, 3f, 0.1f)),
            node("Ceiling0", mesh = true, translation = floatArrayOf(0f, 3f, 0f), scale = floatArrayOf(8f, 0.1f, 6f)),
            node("Window0", translation = floatArrayOf(-4f, 1.5f, 0f), children = listOf(5, 6)),
            node("frame_left", mesh = true, translation = floatArrayOf(0f, 0f, -0.4f), scale = floatArrayOf(0.1f, 1f, 0.6f)),
            // An unnamed child must still inherit Window0 and contribute its half of the bounds.
            node(null, mesh = true, translation = floatArrayOf(0f, 0f, 0.4f), scale = floatArrayOf(0.1f, 1f, 0.6f)),
            node("WindowDrape0", mesh = true, translation = floatArrayOf(25f, 1.5f, 0f), scale = floatArrayOf(10f, 3f, 10f)),
            node("WindowExteriorBackdrop", mesh = true, translation = floatArrayOf(0f, 1.5f, 25f), scale = floatArrayOf(10f, 3f, 10f))
        )
        return glb(nodes, listOf(0))
    }

    private fun node(
        name: String?, mesh: Boolean = false, translation: FloatArray? = null,
        scale: FloatArray? = null, children: List<Int>? = null
    ) = JSONObject().apply {
        name?.let { put("name", it) }
        if (mesh) put("mesh", 0)
        translation?.let { put("translation", JSONArray(it.toList())) }
        scale?.let { put("scale", JSONArray(it.toList())) }
        children?.let { put("children", JSONArray(it)) }
    }

    /** A small self-contained cube GLB; hierarchy and authored lights are real glTF data. */
    private fun glb(nodes: List<JSONObject>, roots: List<Int>, gltfLight: Boolean = false): ByteArray {
        val document = JSONObject().apply {
            put("asset", JSONObject().put("version", "2.0"))
            put("scene", 0)
            put("scenes", JSONArray().put(JSONObject().put("nodes", JSONArray(roots))))
            put("nodes", JSONArray(nodes))
            put("meshes", JSONArray().put(JSONObject().put("primitives", JSONArray().put(JSONObject()
                .put("attributes", JSONObject().put("POSITION", 0).put("NORMAL", 1)).put("indices", 2)))))
            put("buffers", JSONArray().put(JSONObject().put("byteLength", 264)))
            put("bufferViews", JSONArray()
                .put(JSONObject().put("buffer", 0).put("byteOffset", 0).put("byteLength", 96))
                .put(JSONObject().put("buffer", 0).put("byteOffset", 96).put("byteLength", 96))
                .put(JSONObject().put("buffer", 0).put("byteOffset", 192).put("byteLength", 72)))
            put("accessors", JSONArray()
                .put(JSONObject().put("bufferView", 0).put("componentType", 5126).put("count", 8).put("type", "VEC3")
                    .put("min", JSONArray(listOf(-0.5, -0.5, -0.5))).put("max", JSONArray(listOf(0.5, 0.5, 0.5))))
                .put(JSONObject().put("bufferView", 1).put("componentType", 5126).put("count", 8).put("type", "VEC3"))
                .put(JSONObject().put("bufferView", 2).put("componentType", 5123).put("count", 36).put("type", "SCALAR")))
            if (gltfLight) {
                put("extensionsUsed", JSONArray(listOf("KHR_lights_punctual")))
                put("extensions", JSONObject().put("KHR_lights_punctual", JSONObject().put("lights",
                    JSONArray().put(JSONObject().put("type", "point").put("intensity", 10)
                        .put("color", JSONArray(listOf(0.2, 0.6, 1.0)))))))
            }
        }
        val json = document.toString().toByteArray(Charsets.UTF_8)
        val padding = (4 - json.size % 4) % 4
        val total = 12 + 8 + json.size + padding + 8 + 264
        return ByteBuffer.allocate(total).order(ByteOrder.LITTLE_ENDIAN).apply {
            putInt(0x46546C67); putInt(2); putInt(total)
            putInt(json.size + padding); putInt(0x4E4F534A); put(json)
            repeat(padding) { put(0x20.toByte()) }
            putInt(264); putInt(0x004E4942)
            for (z in listOf(-0.5f, 0.5f)) for (y in listOf(-0.5f, 0.5f)) for (x in listOf(-0.5f, 0.5f)) {
                putFloat(x); putFloat(y); putFloat(z)
            }
            repeat(8) { putFloat(0f); putFloat(1f); putFloat(0f) }
            intArrayOf(0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6,
                0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7,
                0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5).forEach { putShort(it.toShort()) }
        }.array()
    }
}
