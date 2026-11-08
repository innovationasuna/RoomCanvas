package com.hausen3d.arviewer.ar

import dev.romainguy.kotlin.math.Mat4

internal class ArPoseFrameCache {
    private var pose: Mat4? = null
    var timestampNs = 0L
        private set

    fun isNew(snapshot: ArPoseSnapshot): Boolean =
        pose == null || snapshot.timestampNs != timestampNs

    fun get(snapshot: ArPoseSnapshot): Mat4 {
        pose?.let {
            if (snapshot.timestampNs == timestampNs) return it
        }
        return snapshot.viewToWorld.toMat4().also {
            pose = it
            timestampNs = snapshot.timestampNs
        }
    }

    fun reset() {
        pose = null
        timestampNs = 0L
    }
}
