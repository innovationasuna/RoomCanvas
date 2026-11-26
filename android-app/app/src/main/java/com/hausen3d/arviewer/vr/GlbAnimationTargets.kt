package com.hausen3d.arviewer.vr

import android.content.res.AssetManager
import android.util.Log
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.sqrt

/**
 * 从 glTF/GLB 里提取「动画索引 → 被驱动节点名」，以及每条动画的「开到底」时间点。
 *
 * 对应网页 walk/app.js 里按 track 里的 nodeName 给动画建索引的做法：
 * 只有知道一条 clip 驱动的是哪个节点，点击拾取到的实体才能回溯到对应的开关。
 *
 * **往返片段**：房间重建导出的柜门/窗扇 clip 常见形态是
 * 「首帧=关、中间=开到底、末帧=关」（如 `Door_Leaf_swing` 4.2 s，中点偏转 90°）。
 * 直接扫到末帧会先开再关，所以这里顺带解析采样器关键帧，找出中点时间，
 * 由 [ArticulationController] 只扫前半段。单向片段（首帧≠末帧）不记录，
 * 控制器退回整段时长。
 *
 * 任何解析失败都返回空结果，由 [ArticulationController] 退回到“动画名去后缀”的兜底策略。
 */
object GlbAnimationTargets {

    /**
     * 解析结果。
     *
     * @property targets 动画索引 → 被驱动节点名
     * @property openTimes 动画索引 → “打开到底”对应的 clip 时间（秒）；仅往返片段有值
     * @property floorY 快照记录的地面高度（米）；旧文件没有该字段时为 null
     */
    data class Result(
        val targets: Map<Int, List<String>> = emptyMap(),
        val openTimes: Map<Int, Float> = emptyMap(),
        val floorY: Float? = null
    )

    private const val TAG = "GlbAnimationTargets"

    /** "glTF" 的小端整数 */
    private const val GLB_MAGIC = 0x46546C67

    /** "JSON" 的小端整数 */
    private const val CHUNK_JSON = 0x4E4F534A

    /** "BIN\0" 的小端整数 */
    private const val CHUNK_BIN = 0x004E4942

    private const val GLB_VERSION = 2

    /** 动画采样器的分量类型：只有 float 才解析关键帧 */
    private const val COMPONENT_FLOAT = 5126

    /** 首末帧“视为相同”的阈值：旋转 1°，位移 2 mm */
    private const val SAME_ROTATION_DEG = 1.0
    private const val SAME_TRANSLATION_M = 0.002

    /** 中点“确实动过”的阈值：旋转 5°，位移 2 cm */
    private const val MOVED_ROTATION_DEG = 5.0
    private const val MOVED_TRANSLATION_M = 0.02

    /**
     * 单个 JSON chunk 上限。
     *
     * 房间模型的 JSON chunk 通常只有几百 KB；设上限是为了不让损坏/伪造的文件
     * 让手机一次性分配巨大数组。超过上限时返回空结果，控制器会退回到
     * “动画名去后缀”的兜底策略，模型本身仍能正常加载。
     */
    private const val MAX_JSON_CHUNK = 8 * 1024 * 1024

    /** 读取本地 .glb 或 .gltf；失败返回空结果。 */
    fun parseFile(file: File): Result = try {
        // 用真实文件长度校验 chunk 头，避免伪造长度触发大块分配
        BufferedInputStream(FileInputStream(file)).use { parse(it, file.length()) }
    } catch (e: Exception) {
        Log.w(TAG, "解析 ${file.name} 的动画目标失败", e)
        Result()
    }

    /** 读取 assets 下的模型；失败返回空结果。 */
    fun parseAsset(assets: AssetManager, assetPath: String): Result = try {
        BufferedInputStream(assets.open(assetPath)).use {
            val length = runCatching {
                assets.openFd(assetPath).use { fd -> fd.length }
            }.getOrNull()?.takeIf { it > 0 }   // UNKNOWN_LENGTH = -1 时当作未知
            parse(it, length)
        }
    } catch (e: Exception) {
        Log.w(TAG, "解析 asset $assetPath 的动画目标失败", e)
        Result()
    }

    /**
     * @param totalLength 文件真实长度；未知时为 null（压缩的 asset 无法 openFd）。
     */
    private fun parse(input: BufferedInputStream, totalLength: Long?): Result {
        // 先嗅探前 4 字节决定是二进制 GLB 还是文本 .gltf
        input.mark(16)
        val magic = ByteArray(4)
        if (input.read(magic) != magic.size) return Result()
        input.reset()
        return if (leInt(magic, 0) == GLB_MAGIC) {
            parseGlb(input, totalLength)
        } else {
            // 文本 .gltf 的几何在外部 .bin 里，读不到关键帧，只取动画目标
            Result(targets = parseGltfText(input))
        }
    }

    /** 12 字节文件头 + 8 字节 chunk 头 + JSON chunk 内容（+ 可选的 BIN chunk）。 */
    private fun parseGlb(input: BufferedInputStream, totalLength: Long?): Result {
        val header = ByteArray(12)
        readFully(input, header)
        if (leInt(header, 0) != GLB_MAGIC || leInt(header, 4) != GLB_VERSION) return Result()

        val chunkHeader = ByteArray(8)
        readFully(input, chunkHeader)
        val chunkLength = leInt(chunkHeader, 0)
        val chunkType = leInt(chunkHeader, 4)
        if (chunkType != CHUNK_JSON || chunkLength <= 0 || chunkLength > MAX_JSON_CHUNK) {
            return Result()
        }
        // chunk 不可能比整个文件还大：伪造的长度在这里被挡下
        if (totalLength != null && chunkLength > totalLength) return Result()

        val bytes = ByteArray(chunkLength)
        readFully(input, bytes)
        // JSON chunk 按规范用空格补齐到 4 字节，部分导出器会补 \u0000
        val text = String(bytes, Charsets.UTF_8).trimEnd('\u0000', ' ')
        val json = JSONObject(text)

        val targets = parseJson(json)

        // 读完 JSON chunk 后紧跟 BIN chunk 头，必须把它读掉：
        // 否则流位置比 [Cursor] 逻辑起点少 8 字节，读出的浮点会整体错位。
        val binHeader = ByteArray(8)
        readFully(input, binHeader)
        val binLength = leInt(binHeader, 0)
        val hasBin = leInt(binHeader, 4) == CHUNK_BIN && binLength > 0
        val binStart = 12L + 8L + chunkLength + 8L
        val openTimes = if (hasBin) {
            runCatching { parseOpenTimes(json, input, binStart) }
                .getOrElse {
                    Log.w(TAG, "解析动画关键帧失败，按整段播放", it)
                    emptyMap()
                }
        } else {
            emptyMap()
        }
        val nodes = json.optJSONArray("nodes")
        var floorY: Float? = null
        if (nodes != null) for (i in 0 until nodes.length()) {
            val snapshot = nodes.optJSONObject(i)?.optJSONObject("extras")?.optJSONObject("roomcanvas") ?: continue
            val y = snapshot.optDouble("floorY", Double.NaN)
            if (snapshot.optInt("schema") == 1 && y.isFinite()) floorY = y.toFloat()
        }
        return Result(targets, openTimes, floorY)
    }

    /** .gltf 可能是文本 JSON（也可能内嵌 base64），同样限制读取总量。 */
    private fun parseGltfText(input: InputStream): Map<Int, List<String>> {
        val bytes = readLimited(input, MAX_JSON_CHUNK) ?: return emptyMap()
        return parseJson(JSONObject(String(bytes, Charsets.UTF_8)))
    }

    private fun readLimited(input: InputStream, limit: Int): ByteArray? {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > limit) return null
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    /** animations[i].channels[*].target.node → nodes[node].name */
    private fun parseJson(json: JSONObject): Map<Int, List<String>> {
        val nodes = json.optJSONArray("nodes") ?: return emptyMap()
        val nodeNames = Array(nodes.length()) { index ->
            nodes.optJSONObject(index)?.optString("name").orEmpty()
        }

        val animations = json.optJSONArray("animations") ?: return emptyMap()
        val result = LinkedHashMap<Int, List<String>>()
        for (i in 0 until animations.length()) {
            val channels = animations.optJSONObject(i)?.optJSONArray("channels") ?: continue
            val targets = LinkedHashSet<String>()
            for (c in 0 until channels.length()) {
                val target = channels.optJSONObject(c)?.optJSONObject("target") ?: continue
                // KHR_animation_pointer 等扩展没有 target.node，跳过
                if (!target.has("node")) continue
                val nodeIndex = target.optInt("node", -1)
                val name = nodeNames.getOrNull(nodeIndex).orEmpty()
                if (name.isNotEmpty()) targets += name
            }
            if (targets.isNotEmpty()) result[i] = targets.toList()
        }
        return result
    }

    // ---------------- 往返片段识别 ----------------

    /**
     * 找出「首帧=末帧、中点不同」的往返片段，返回其中点时间。
     *
     * 只读采样器的首/中/末三个关键帧，按文件偏移升序读取（流不能回退），
     * BIN chunk 的数据起始偏移由调用方给出。
     */
    private fun parseOpenTimes(json: JSONObject, input: InputStream, binStart: Long): Map<Int, Float> {
        val animations = json.optJSONArray("animations") ?: return emptyMap()
        val accessors = json.optJSONArray("accessors") ?: return emptyMap()
        val views = json.optJSONArray("bufferViews") ?: return emptyMap()
        val buffers = json.optJSONArray("buffers") ?: return emptyMap()
        // 外部 .bin 的模型读不到关键帧；GLB 只有一个内嵌 buffer
        if (buffers.length() != 1) return emptyMap()
        if (buffers.optJSONObject(0)?.has("uri") == true) return emptyMap()

        /** 一条动画采样器的读取位置。 */
        class Track(
            val animation: Int,
            val outOffset: Long,
            val outStride: Int,
            val outElement: Int,
            val outCount: Int,
            val inOffset: Long,
            val inStride: Int
        )

        val tracks = ArrayList<Track>()
        for (i in 0 until animations.length()) {
            val animation = animations.optJSONObject(i) ?: continue
            val channels = animation.optJSONArray("channels") ?: continue
            if (channels.length() == 0) continue
            val samplerIndex = channels.optJSONObject(0)?.optInt("sampler", -1) ?: -1
            val sampler = animation.optJSONArray("samplers")?.optJSONObject(samplerIndex) ?: continue
            val output = accessors.optJSONObject(sampler.optInt("output", -1)) ?: continue
            val time = accessors.optJSONObject(sampler.optInt("input", -1)) ?: continue
            if (output.optInt("componentType") != COMPONENT_FLOAT) continue
            if (time.optInt("componentType") != COMPONENT_FLOAT) continue

            val outputView = views.optJSONObject(output.optInt("bufferView", -1)) ?: continue
            val timeView = views.optJSONObject(time.optInt("bufferView", -1)) ?: continue
            if (outputView.optInt("buffer", 0) != 0 || timeView.optInt("buffer", 0) != 0) continue

            val element = componentsOf(output.optString("type")) ?: continue
            if (element != 3 && element != 4) continue      // 只看平移/旋转
            if (componentsOf(time.optString("type")) != 1) continue

            val count = output.optInt("count", 0)
            if (count < 3 || time.optInt("count", 0) != count) continue

            tracks += Track(
                animation = i,
                outOffset = outputView.optInt("byteOffset", 0).toLong() + output.optInt("byteOffset", 0),
                outStride = outputView.optInt("byteStride", 0).takeIf { it > 0 } ?: (element * 4),
                outElement = element,
                outCount = count,
                inOffset = timeView.optInt("byteOffset", 0).toLong() + time.optInt("byteOffset", 0),
                inStride = timeView.optInt("byteStride", 0).takeIf { it > 0 } ?: 4
            )
        }
        if (tracks.isEmpty()) return emptyMap()

        // 把每条 track 需要的四段字节摊平
        val reads = ArrayList<Read>()
        tracks.forEachIndexed { trackIndex, track ->
            val last = track.outCount - 1
            val middle = track.outCount / 2
            val elementBytes = track.outElement * 4
            reads += Read(trackIndex, FIRST, track.outOffset, elementBytes)
            reads += Read(
                trackIndex, MIDDLE,
                track.outOffset + middle.toLong() * track.outStride, elementBytes
            )
            reads += Read(
                trackIndex, LAST,
                track.outOffset + last.toLong() * track.outStride, elementBytes
            )
            reads += Read(trackIndex, TIME, track.inOffset + middle.toLong() * track.inStride, 4)
        }
        reads.sortBy { it.offset }

        // 同一 bufferView 里 time 数组和 rotation 数组紧挨着，读取区间会重叠；
        // 而流只能向前，所以先把重叠区间合并，每个区间整段读一次再切片。
        val spans = ArrayList<LongArray>()   // [start, end)
        for (read in reads) {
            val end = read.offset + read.length
            val lastSpan = spans.lastOrNull()
            if (lastSpan != null && read.offset <= lastSpan[1]) {
                if (end > lastSpan[1]) lastSpan[1] = end
            } else {
                spans += longArrayOf(read.offset, end)
            }
        }

        val cursor = Cursor(input, binStart)
        val values = HashMap<Int, FloatArray>()
        var next = 0
        for (span in spans) {
            val start = span[0]
            val block = cursor.readSpan(start, (span[1] - start).toInt()) ?: return emptyMap()
            while (next < reads.size && reads[next].offset < span[1]) {
                val read = reads[next]
                val from = (read.offset - start).toInt()
                values[read.trackIndex * 10 + read.kind] =
                    FloatArray(read.length / 4) { floatAt(block, from + it * 4) }
                next++
            }
        }

        val result = LinkedHashMap<Int, Float>()
        tracks.forEachIndexed { trackIndex, track ->
            val first = values[trackIndex * 10 + FIRST] ?: return@forEachIndexed
            val middle = values[trackIndex * 10 + MIDDLE] ?: return@forEachIndexed
            val last = values[trackIndex * 10 + LAST] ?: return@forEachIndexed
            val time = values[trackIndex * 10 + TIME]?.firstOrNull() ?: return@forEachIndexed

            val sameEnds = difference(first, last) <= if (track.outElement == 4) {
                SAME_ROTATION_DEG
            } else {
                SAME_TRANSLATION_M
            }
            val movedMiddle = difference(first, middle) >= if (track.outElement == 4) {
                MOVED_ROTATION_DEG
            } else {
                MOVED_TRANSLATION_M
            }
            if (sameEnds && movedMiddle && time > 0f) {
                result[track.animation] = time
            }
        }
        return result
    }

    /** 四元数返回两次旋转的夹角（度），三分量返回欧氏距离。 */
    private fun difference(a: FloatArray, b: FloatArray): Double {
        if (a.size == 4 && b.size == 4) {
            val dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]).toDouble()
            return Math.toDegrees(2.0 * acos(abs(dot).coerceAtMost(1.0)))
        }
        var sum = 0.0
        for (i in 0 until minOf(a.size, b.size)) {
            val d = (a[i] - b[i]).toDouble()
            sum += d * d
        }
        return sqrt(sum)
    }

    private fun componentsOf(type: String): Int? = when (type) {
        "SCALAR" -> 1
        "VEC2" -> 2
        "VEC3" -> 3
        "VEC4" -> 4
        else -> null
    }

    private const val FIRST = 0
    private const val MIDDLE = 1
    private const val LAST = 2
    private const val TIME = 3

    private class Read(val trackIndex: Int, val kind: Int, val offset: Long, val length: Int)

    /**
     * 只允许向前移动的流式游标。
     *
     * @param base BIN chunk 数据在文件中的起始偏移；[readSpan] 的 offset 是 BIN 内的相对偏移
     *             （accessor.byteOffset + bufferView.byteOffset），必须加上 base 才是文件位置。
     */
    private class Cursor(private val input: InputStream, private val base: Long) {
        private var position = base

        fun readSpan(offset: Long, length: Int): ByteArray? {
            val target = base + offset
            if (target < position) return null
            var remaining = target - position
            while (remaining > 0) {
                val skipped = input.skip(remaining)
                if (skipped > 0) {
                    remaining -= skipped
                    position += skipped
                } else {
                    if (input.read() < 0) return null
                    position += 1
                    remaining -= 1
                }
            }
            val bytes = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = input.read(bytes, read, length - read)
                if (n < 0) return null
                read += n
            }
            position += length
            return bytes
        }
    }

    private fun floatAt(bytes: ByteArray, offset: Int): Float {
        val bits = (bytes[offset].toInt() and 0xFF) or
            ((bytes[offset + 1].toInt() and 0xFF) shl 8) or
            ((bytes[offset + 2].toInt() and 0xFF) shl 16) or
            ((bytes[offset + 3].toInt() and 0xFF) shl 24)
        return Float.fromBits(bits)
    }

    private fun readFully(input: InputStream, buffer: ByteArray) {
        var offset = 0
        while (offset < buffer.size) {
            val read = input.read(buffer, offset, buffer.size - offset)
            if (read < 0) throw EOFException("GLB 数据不完整")
            offset += read
        }
    }

    private fun leInt(bytes: ByteArray, offset: Int): Int =
        (bytes[offset].toInt() and 0xFF) or
            ((bytes[offset + 1].toInt() and 0xFF) shl 8) or
            ((bytes[offset + 2].toInt() and 0xFF) shl 16) or
            ((bytes[offset + 3].toInt() and 0xFF) shl 24)
}
