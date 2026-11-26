package com.hausen3d.arviewer.rendering

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoomRenderQualityTest {
    private val baselineFields = listOf<(RoomRenderQuality) -> Any>(
        { it.ssaoEnabled },
        { it.resolutionScale },
        { it.arEnabled }
    )

    @Test
    fun everySupportedExperimentChangesExactlyOneVariable() {
        val baseline = RoomRenderQuality.BASELINE
        val experiments = RenderExperiment.values()
            .filter { it.isSupported && it.quality != baseline }

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

        assertTrue(quality.ssaoEnabled)
        assertEquals(1.0f, quality.resolutionScale)
        assertTrue(quality.arEnabled)
    }

    @Test
    fun remainingExperimentsAreSupported() {
        for (experiment in RenderExperiment.values()) {
            assertTrue(experiment.name, experiment.isSupported)
        }
    }
}
