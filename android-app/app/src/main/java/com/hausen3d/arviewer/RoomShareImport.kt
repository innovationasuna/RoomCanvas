package com.hausen3d.arviewer

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import java.io.File
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/** The LAN protocol is an immutable manifest plus one self-contained GLB. No redirects or credentials. */
object RoomShareImport {
    const val MAX_BYTES = 512L * 1024 * 1024
    data class Result(val file: File, val name: String, val version: String)

    fun manifestUrl(link: String): URI {
        val uri = URI(link)
        require(uri.scheme == "roomcanvas" && uri.host == "import" && uri.path.orEmpty().isEmpty()) { "无效的手机导入链接" }
        val pairs = uri.rawQuery.orEmpty().split('&').map { it.split('=', limit = 2) }
        val values = pairs.filter { it[0] == "manifest" && it.size == 2 }
        require(values.size == 1) { "缺少房间分享地址" }
        val target = URI(java.net.URLDecoder.decode(values.single()[1], "UTF-8"))
        require(target.userInfo == null && target.fragment == null && target.query == null) { "分享地址无效" }
        require(target.path.matches(Regex("/s/[a-f0-9]{32}/manifest\\.json"))) { "分享路径无效" }
        require(target.scheme == "https" || target.scheme == "http" && privateIpv4(target.host.orEmpty())) {
            "同网导入需要电脑的 Wi-Fi 地址，异地地址须使用 HTTPS"
        }
        require(!target.host.isNullOrBlank() && (target.port == -1 || target.port in 1..65535)) { "分享地址无效" }
        return target
    }

    private fun privateIpv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4 || parts.any { !it.matches(Regex("[0-9]{1,3}")) || it.toInt() !in 0..255 }) return false
        val p = parts.map { it.toInt() }
        return p[0] == 10 || p[0] == 192 && p[1] == 168 || p[0] == 172 && p[1] in 16..31
    }

    private fun connect(uri: URI): HttpURLConnection {
        val c = uri.toURL().openConnection() as HttpURLConnection
        c.connectTimeout = 10000
        c.readTimeout = 15000
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept-Encoding", "identity")
        try {
            require(c.responseCode == 200) {
                if (c.responseCode == 404) "分享不存在或已失效，请在电脑上重新生成" else "电脑服务返回 ${c.responseCode}，请重试"
            }
            return c
        } catch (e: Exception) { c.disconnect(); throw e }
    }

    suspend fun download(manifestUri: URI, destination: File, progress: (String) -> Unit): Result {
        val temporary = File(destination.path + ".part")
        try {
            progress("正在读取房间信息…")
            val connection = connect(manifestUri)
            val text = try {
                connection.inputStream.use { input ->
                    val bytes = ByteArrayOutputStream()
                    val buffer = ByteArray(4096)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count == -1) break
                        require(bytes.size() + count <= 65536) { "分享信息过大" }
                        bytes.write(buffer, 0, count)
                    }
                    bytes.toString("UTF-8")
                }
            } finally { connection.disconnect() }
            currentCoroutineContext().ensureActive()
            val manifest = JSONObject(text)
            val id = manifestUri.path.split('/')[2]
            require(manifest.getInt("schema") == 1 && manifest.getString("id") == id) { "分享信息不匹配" }
            val name = manifest.getString("name").take(200)
            val version = manifest.getString("version")
            require(version.matches(Regex("[a-f0-9-]{36}"))) { "房间版本无效" }
            val model = manifest.getJSONObject("model")
            require(model.getString("url") == "/s/$id/room.glb") { "房间文件地址无效" }
            val size = model.getLong("bytes")
            require(size in 20..MAX_BYTES) { "房间文件大小无效或超过 512 MB" }
            val expectedHash = model.getString("sha256")
            require(expectedHash.matches(Regex("[a-f0-9]{64}"))) { "缺少文件校验信息" }
            destination.parentFile?.mkdirs()
            require((destination.parentFile?.usableSpace ?: 0) > size + 16 * 1024 * 1024) { "手机存储空间不足，请清理后重试" }
            val digest = MessageDigest.getInstance("SHA-256")
            val download = connect(manifestUri.resolve(model.getString("url")))
            var received = 0L
            var reported = -1
            try {
                download.inputStream.use { input -> temporary.outputStream().use { output ->
                    val buffer = ByteArray(128 * 1024)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val n = input.read(buffer)
                        if (n == -1) break
                        received += n
                        require(received <= size) { "下载内容与房间信息不一致" }
                        output.write(buffer, 0, n); digest.update(buffer, 0, n)
                        val percent = (received * 100 / size).toInt()
                        if (percent != reported) {reported = percent; progress("正在下载 $name · $percent%")}
                    }
                } }
            } finally { download.disconnect() }
            require(received == size) { "下载中断，请重试" }
            require(digest.digest().joinToString("") { "%02x".format(it) } == expectedHash) { "房间校验失败，请重新下载" }
            progress("正在检查房间文件…")
            temporary.inputStream().use { input ->
                val header = ByteArray(20)
                require(input.read(header) == header.size) { "房间文件不完整" }
                val b = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
                require(b.int == 0x46546c67 && b.int == 2 && b.int.toLong() == size) { "房间不是有效的 GLB 模型" }
                val jsonLength = b.int
                require(b.int == 0x4e4f534a && jsonLength in 2..16 * 1024 * 1024 && jsonLength.toLong() <= size - 20) { "房间数据无效" }
                val bytes = ByteArray(jsonLength)
                java.io.DataInputStream(input).readFully(bytes)
                val doc = JSONObject(String(bytes, Charsets.UTF_8))
                for (key in listOf("buffers", "images")) {
                    val resources = doc.optJSONArray(key) ?: continue
                    for (i in 0 until resources.length()) {
                        val resource = resources.getJSONObject(i)
                        require(!resource.has("uri") || resource.getString("uri").startsWith("data:")) { "房间引用外部资源，请从电脑重新导出完整快照" }
                    }
                }
            }
            currentCoroutineContext().ensureActive()
            require(temporary.renameTo(destination)) { "房间文件保存失败" }
            return Result(destination, name, version)
        } finally { temporary.delete() }
    }
}
