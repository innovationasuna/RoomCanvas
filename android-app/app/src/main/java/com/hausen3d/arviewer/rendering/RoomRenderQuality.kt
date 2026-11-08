package com.hausen3d.arviewer.rendering

enum class ShadowFilter {
    PCSS,
    DPCF,
    PCF
}

data class RoomRenderQuality(
    val shadowFilter: ShadowFilter = ShadowFilter.PCSS,
    val ssaoEnabled: Boolean = true,
    val resolutionScale: Float = 1.0f,
    val sunCascadeCount: Int = 4,
    val sunShadowMapSize: Int = 1024,
    val singleWindowShadowOnly: Boolean = false,
    val shadowsEnabled: Boolean = true,
    val arEnabled: Boolean = true
) {
    fun summary(): String =
        "shadow=$shadowFilter ssao=$ssaoEnabled resolution=$resolutionScale " +
            "cascades=$sunCascadeCount sunMap=$sunShadowMapSize " +
            "singleWindowShadow=$singleWindowShadowOnly shadows=$shadowsEnabled ar=$arEnabled"

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
    A1_DPCF(
        "A1 · 仅 PCSS → DPCF",
        RoomRenderQuality.BASELINE.copy(shadowFilter = ShadowFilter.DPCF)
    ),
    A1_PCF(
        "A1 · 仅 PCSS → PCF",
        RoomRenderQuality.BASELINE.copy(shadowFilter = ShadowFilter.PCF)
    ),
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
    A4_CASCADE2(
        "A4 · 仅日光 cascade 4 → 2",
        RoomRenderQuality.BASELINE.copy(sunCascadeCount = 2)
    ),
    A4_MAP512(
        "A4 · 仅日光阴影图 1024 → 512",
        RoomRenderQuality.BASELINE.copy(sunShadowMapSize = 512)
    ),
    A5(
        "A5 · 仅保留一个投影窗灯",
        RoomRenderQuality.BASELINE.copy(singleWindowShadowOnly = true)
    ),
    A6(
        "A6 · 仅关闭全部实时阴影（诊断）",
        RoomRenderQuality.BASELINE.copy(shadowsEnabled = false)
    ),
    A7(
        "A7 · 仅暂停 AR（按键轨迹）",
        RoomRenderQuality.BASELINE.copy(arEnabled = false)
    ),
    A8(
        "A8 · 低模阴影代理（尚无代理资产）",
        RoomRenderQuality.BASELINE,
        isSupported = false
    )
}
