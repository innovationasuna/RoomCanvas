package com.hausen3d.arviewer.rendering

/**
 * 当前产品画质：
 * - 不使用日光（太阳）与实时阴影；
 * - 保留顶灯/窗灯、SSAO、IBL；
 * - 只保留 SSAO、内部分辨率与 AR 三个诊断项。
 */
data class RoomRenderQuality(
    val ssaoEnabled: Boolean = true,
    val resolutionScale: Float = 1.0f,
    val arEnabled: Boolean = true
) {
    fun summary(): String =
        "ssao=$ssaoEnabled resolution=$resolutionScale ar=$arEnabled"

    companion object {
        val BASELINE = RoomRenderQuality()
    }
}

enum class RenderExperiment(
    val displayName: String,
    val quality: RoomRenderQuality,
    val isSupported: Boolean = true
) {
    A0("A0 · 当前视觉基准", RoomRenderQuality.BASELINE),
    A2(
        "A2 · 仅关闭 SSAO",
        RoomRenderQuality.BASELINE.copy(ssaoEnabled = false)
    ),
    A3_090(
        "A3 · 仅内部比例 0.90",
        RoomRenderQuality.BASELINE.copy(resolutionScale = 0.90f)
    ),
    A3_075(
        "A3 · 仅内部比例 0.75（诊断）",
        RoomRenderQuality.BASELINE.copy(resolutionScale = 0.75f)
    ),
    A7(
        "A7 · 仅暂停 AR（按键轨迹）",
        RoomRenderQuality.BASELINE.copy(arEnabled = false)
    )
}
