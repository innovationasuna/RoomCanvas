package com.hausen3d.arviewer.ar

import dev.romainguy.kotlin.math.Float4
import dev.romainguy.kotlin.math.Mat4

/**
 * AR Engine 位姿/投影矩阵（列主序 float[16]，OpenGL 约定）→ kotlin-math Mat4。
 *
 * Mat4 的 x/y/z/w 分别对应矩阵的四列，因此按列填入即可，无需转置。
 */
internal fun FloatArray.toMat4(): Mat4 = Mat4(
    Float4(this[0], this[1], this[2], this[3]),
    Float4(this[4], this[5], this[6], this[7]),
    Float4(this[8], this[9], this[10], this[11]),
    Float4(this[12], this[13], this[14], this[15])
)
