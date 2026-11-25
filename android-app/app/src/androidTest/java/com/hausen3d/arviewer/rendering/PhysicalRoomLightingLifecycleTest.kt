package com.hausen3d.arviewer.rendering

import android.Manifest
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.filament.EntityManager
import com.hausen3d.arviewer.R
import com.hausen3d.arviewer.VrWalkthroughActivity
import io.github.sceneview.SceneView
import io.github.sceneview.node.ModelNode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicReference

/** Runs against Filament JNI on an ARM device/emulator; no mocked native managers. */
@RunWith(AndroidJUnit4::class)
class PhysicalRoomLightingLifecycleTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test
    fun releaseWithoutLoadingAModelIsSafe() = withLighting { scene, lighting ->
        onMain {
            val existingLights = scene.lightEntities()
            lighting.release()
            lighting.release()
            assertTrue(scene.engine.isValid)
            assertEquals(existingLights, scene.lightEntities())
            existingLights.forEach { assertTrue(EntityManager.get().isAlive(it)) }
        }
    }

    @Test
    fun replacingAModelDestroysItsOldLightComponentsAndEntityIds() = withLighting { scene, lighting ->
        onMain {
            val first = addRoom(scene)
            lighting.applyTo(first)
            val oldLights = scene.lightEntities()
            assertEquals(1, oldLights.size)

            scene.removeChildNode(first)
            scene.modelLoader.destroyModel(first.model)
            lighting.applyTo(addRoom(scene, ceilingCount = 2))

            assertReleased(scene, oldLights)
            oldLights.forEach { assertFalse(scene.scene.hasEntity(it)) }
            assertEquals(2, scene.lightEntities().size)
        }
    }

    @Test
    fun releaseDestroysOwnedComponentsAndIdsAndCanBeRepeated() = withLighting { scene, lighting ->
        onMain {
            lighting.applyTo(addRoom(scene))
            val lights = scene.lightEntities()
            assertEquals(1, lights.size)
            assertTrue(EntityManager.get().isAlive(lights.single()))

            lighting.release()
            lighting.release()

            assertReleased(scene, lights)
            assertEquals(0, scene.scene.lightCount)
        }
    }

    @Test
    fun releaseAfterTheEngineIsDestroyedStillReleasesEntityIds() = withLighting { scene, lighting ->
        val lights = onMain {
            lighting.applyTo(addRoom(scene))
            scene.lightEntities().also {
                assertEquals(1, it.size)
                scene.destroy()
            }
        }
        // SceneView may defer Engine.destroy() until its backend becomes idle.
        await("SceneView did not destroy its engine") { onMain { !scene.engine.isValid } }
        onMain {
            assertTrue("Engine destruction alone must not hide the leaked ID", EntityManager.get().isAlive(lights.single()))
            lighting.release()
            lighting.release()
            lights.forEach { assertFalse(EntityManager.get().isAlive(it)) }
        }
    }

    @Test
    fun releaseDoesNotAccessADestroyedSceneWhenItsSharedEngineIsAlive() =
        withLighting(sharedEngine = true) { scene, lighting ->
            onMain {
                lighting.applyTo(addRoom(scene))
                val lights = scene.lightEntities()
                assertEquals(1, lights.size)
                scene.destroy()
                assertTrue(scene.engine.isValid)

                lighting.release()
                lighting.release()

                assertReleased(scene, lights)
            }
        }

    @Test
    fun switchingToGltfLightsReleasesOnlyTheAutomaticallyCreatedLights() = withLighting { scene, lighting ->
        onMain {
            lighting.applyTo(addRoom(scene))
            val automaticLights = scene.lightEntities()
            assertEquals(1, automaticLights.size)
            val model = addRoom(scene, gltfLight = true)
            val modelLights = model.lightNodes.map { it.entity }.toSet()
            assertEquals(1, modelLights.size)

            lighting.applyTo(model)
            lighting.release()
            lighting.release()

            assertReleased(scene, automaticLights)
            assertEquals(modelLights, scene.lightEntities())
            modelLights.forEach {
                assertTrue(EntityManager.get().isAlive(it))
                assertTrue(scene.engine.lightManager.hasComponent(it))
            }
        }
    }

    @Test
    fun closingTheActivityBeforeLoadingDoesNotInitializeRoomLighting() = withActivity(loadRoom = false) { scenario ->
        lateinit var scene: SceneView
        lateinit var lightingDelegate: Lazy<*>
        scenario.onActivity {
            scene = it.findViewById(R.id.sceneView)
            lightingDelegate = VrWalkthroughActivity::class.java.getDeclaredField("roomLightingDelegate")
                .apply { isAccessible = true }.get(it) as Lazy<*>
            assertTrue(scene.childNodes.isEmpty())
            assertFalse(lightingDelegate.isInitialized())
        }
        val originalMainLight = onMain { scene.mainLightNode }
        assertNotNull(originalMainLight)

        scenario.close()

        // The fallback now preserves the default light even if lighting is initialized.
        assertFalse(lightingDelegate.isInitialized())
        assertSame(originalMainLight, onMain { scene.mainLightNode })
    }

    @Test
    fun closingTheActivityReleasesTheLightsCreatedDuringItsRealModelLoad() = withActivity(loadRoom = true) { scenario ->
        var lightIds = emptySet<Int>()
        await("Activity did not load the room and create its local light") {
            scenario.onActivity {
                val scene = it.findViewById<SceneView>(R.id.sceneView)
                if (scene.childNodes.filterIsInstance<ModelNode>().isNotEmpty()) {
                    lightIds = scene.lightEntities()
                }
            }
            lightIds.size == 1
        }
        onMain { lightIds.forEach { assertTrue(EntityManager.get().isAlive(it)) } }

        scenario.close()

        onMain { lightIds.forEach { assertFalse("Activity leaked local light $it", EntityManager.get().isAlive(it)) } }
    }

    private fun withLighting(
        sharedEngine: Boolean = false,
        block: (SceneView, PhysicalRoomLighting) -> Unit
    ) {
        val owner = if (sharedEngine) onMain { SceneView(context) } else null
        val scene = onMain { SceneView(context, sharedEngine = owner?.engine) }
        val lighting = onMain { PhysicalRoomLighting(scene) }
        try {
            block(scene, lighting)
        } finally {
            onMain {
                lighting.release()
                scene.destroy()
                owner?.destroy()
            }
            await("Filament engine remained alive after test cleanup") { onMain { !scene.engine.isValid } }
        }
    }

    private fun withActivity(loadRoom: Boolean, block: (ActivityScenario<VrWalkthroughActivity>) -> Unit) {
        // A permission dialog would pause ActivityScenario before it reaches RESUMED.
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.CAMERA)
        val prefs = context.getSharedPreferences("vr_walkthrough", Context.MODE_PRIVATE)
        val oldPath = prefs.getString("last_model_path", null)
        val oldName = prefs.getString("last_model_name", null)
        val file = File.createTempFile("lighting-lifecycle-", ".glb", context.cacheDir)
        try {
            assertTrue(prefs.edit().remove("last_model_path").remove("last_model_name").commit())
            val intent = Intent(context, VrWalkthroughActivity::class.java)
            if (loadRoom) {
                file.writeBytes(roomGlb())
                intent.putExtra(VrWalkthroughActivity.EXTRA_MODEL_PATH, file.absolutePath)
            }
            val scenario = ActivityScenario.launch<VrWalkthroughActivity>(intent)
            lateinit var scene: SceneView
            try {
                scenario.onActivity { scene = it.findViewById(R.id.sceneView) }
                block(scenario)
            } finally {
                scenario.close()
                await("Activity's Filament engine remained alive after exit") { onMain { !scene.engine.isValid } }
            }
        } finally {
            prefs.edit().putString("last_model_path", oldPath).putString("last_model_name", oldName).commit()
            file.delete()
        }
    }

    private fun addRoom(scene: SceneView, ceilingCount: Int = 1, gltfLight: Boolean = false): ModelNode {
        val bytes = roomGlb(ceilingCount, gltfLight)
        val buffer = ByteBuffer.allocateDirect(bytes.size).apply { put(bytes); flip() }
        return ModelNode(scene.modelLoader.createModelInstance(buffer), autoAnimate = false).also(scene::addChildNode)
    }

    private fun SceneView.lightEntities(): Set<Int> =
        scene.entities.filter { engine.lightManager.hasComponent(it) }.toSet()

    private fun assertReleased(scene: SceneView, entities: Set<Int>) {
        entities.forEach {
            assertFalse("Entity ID $it is still alive", EntityManager.get().isAlive(it))
            assertFalse("Light component $it is still alive", scene.engine.lightManager.hasComponent(it))
        }
    }

    private fun await(message: String, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 20_000
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

    /** A self-contained triangle per ceiling, with an optional KHR_lights_punctual light. */
    private fun roomGlb(ceilingCount: Int = 1, gltfLight: Boolean = false): ByteArray {
        val nodes = (0 until ceilingCount).map {
            """{"name":"Ceiling$it","mesh":0,"translation":[$it,2,0]}"""
        }.toMutableList()
        if (gltfLight) nodes += """{"name":"ModelLight","extensions":{"KHR_lights_punctual":{"light":0}}}"""
        val lightExtension = if (gltfLight) """,
            "extensionsUsed":["KHR_lights_punctual"],
            "extensions":{"KHR_lights_punctual":{"lights":[{"type":"point","intensity":10}]}}
        """ else ""
        val json = """{
            "asset":{"version":"2.0"},"scene":0,
            "scenes":[{"nodes":[${nodes.indices.joinToString()}]}],
            "nodes":[${nodes.joinToString()}],
            "meshes":[{"primitives":[{"attributes":{"POSITION":0,"NORMAL":1}}]}],
            "buffers":[{"byteLength":72}],
            "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":36},{"buffer":0,"byteOffset":36,"byteLength":36}],
            "accessors":[
                {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[-1,0,-1],"max":[1,0,1]},
                {"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"}
            ]$lightExtension
        }""".toByteArray(Charsets.UTF_8)
        val padding = (4 - json.size % 4) % 4
        val totalSize = 12 + 8 + json.size + padding + 8 + 72
        return ByteBuffer.allocate(totalSize).order(ByteOrder.LITTLE_ENDIAN).apply {
            putInt(0x46546C67); putInt(2); putInt(totalSize)
            putInt(json.size + padding); putInt(0x4E4F534A); put(json)
            repeat(padding) { put(0x20.toByte()) }
            putInt(72); putInt(0x004E4942)
            floatArrayOf(-1f, 0f, -1f, 1f, 0f, -1f, 0f, 0f, 1f).forEach { putFloat(it) }
            repeat(3) { putFloat(0f); putFloat(1f); putFloat(0f) }
        }.array()
    }
}
