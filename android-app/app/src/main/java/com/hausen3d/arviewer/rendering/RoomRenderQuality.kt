package com.hausen3d.arviewer.rendering

/**
 * 当前产品画质：
 * - 不使用日光（太阳）与实时阴影；
 * - 保留顶灯/窗灯、SSAO、IBL；
 * - 可配置 SSAO 与内部分辨率。
 */
data class RoomRenderQuality(
    val ssaoEnabled: Boolean = true,
    val resolutionScale: Float = 1.0f
) {
    companion object {
        val BASELINE = RoomRenderQuality()
    }
}
