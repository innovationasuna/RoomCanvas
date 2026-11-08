package com.hausen3d.arviewer.rendering

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class RoomRenderQualityTest {
    private val baselineFields = listOf<(RoomRenderQuality) -> Any>(
        { it.shadowFilter },
        { it.ssaoEnabled },
        { it.resolutionScale },
        { it.sunCascadeCount },
        { it.sunShadowMapSize },
        { it.singleWindowShadowOnly },
        { it.shadowsEnabled },
        { it.arEnabled }
    )

    @Test
    fun everySupportedExperimentChangesExactlyOneVariable() {
        val baseline = RoomRenderQuality.BASELINE
        val experiments = RenderExperiment.values()
            .filter { it.isSupported && it != RenderExperiment.A0 }

        for (experiment in experiments) {
            val changedFields = baselineFields.count { field ->
                field(experiment.quality) != field(baseline)
            }
            assertEquals(experiment.displayName, 1, changedFields)
        }
    }

    @Test
    fun baselineRetainsAcceptedVisualConfiguration() {
        val quality = RoomRenderQuality.BASELINE

        assertEquals(ShadowFilter.PCSS, quality.shadowFilter)
        assertEquals(true, quality.ssaoEnabled)
        assertEquals(1.0f, quality.resolutionScale)
        assertEquals(4, quality.sunCascadeCount)
        assertEquals(1024, quality.sunShadowMapSize)
        assertEquals(false, quality.singleWindowShadowOnly)
        assertEquals(true, quality.shadowsEnabled)
        assertEquals(true, quality.arEnabled)
    }

    @Test
    fun a8CannotRunWithoutShadowProxy() {
        assertFalse(RenderExperiment.A8.isSupported)
        assertEquals(RoomRenderQuality.BASELINE, RenderExperiment.A8.quality)
    }
}
