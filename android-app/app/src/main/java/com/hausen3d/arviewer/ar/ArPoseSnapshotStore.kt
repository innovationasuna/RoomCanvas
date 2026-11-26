package com.hausen3d.arviewer.ar

/** 可复用快照；只能在 [ArPoseSnapshotStore.read] 或 `update` 回调期间访问，禁止保留引用。 */
class ArPoseSnapshot internal constructor(
    /** 相机在世界坐标系中的位姿矩阵（列主序 4x4，OpenGL 约定） */
    val viewToWorld: FloatArray,
    isTracking: Boolean,
    /** ARFrame 时间戳，用于主线程去重并计算两个真实 AR 帧之间的时间 */
    timestampNs: Long
) {
    var isTracking: Boolean = isTracking
        internal set

    var timestampNs: Long = timestampNs
        internal set
}

internal class ArPoseSnapshotStore {
    @PublishedApi
    internal val mutex = Any()

    @PublishedApi
    internal val snapshot = ArPoseSnapshot(FloatArray(16), false, 0L)

    /** 回调不得保留可复用快照或其矩阵的引用。 */
    inline fun <T> read(block: (ArPoseSnapshot) -> T): T = synchronized(mutex) {
        block(snapshot)
    }

    inline fun update(block: (ArPoseSnapshot) -> Unit) = synchronized(mutex) {
        block(snapshot)
    }
}
