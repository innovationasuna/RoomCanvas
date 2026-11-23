package com.hausen3d.arviewer

import org.junit.Assert.*
import org.junit.Test
import java.net.URLEncoder
import java.net.URI
import java.net.ServerSocket
import java.net.InetAddress
import java.net.SocketException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.concurrent.thread
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

class RoomShareImportTest {
    private val path = "/s/0123456789abcdef0123456789abcdef/manifest.json"
    private fun link(url: String) = "roomcanvas://import?manifest=" + URLEncoder.encode(url, "UTF-8")

    @Test fun acceptsPrivateWifiAndHttpsUrls() {
        for (host in listOf("192.168.1.8", "10.0.0.3", "172.16.2.4")) {
            assertEquals(host, RoomShareImport.manifestUrl(link("http://$host:7881$path")).host)
        }
        assertEquals("https", RoomShareImport.manifestUrl(link("https://room.example$path")).scheme)
    }

    @Test fun rejectsLoopbackExternalHttpCredentialsAndWrongPaths() {
        for (url in listOf("http://127.0.0.1$path", "http://8.8.8.8$path", "http://localhost$path", "file://$path",
            "https://user:password@room.example$path", "https://room.example/private", "https://room.example$path?override=1")) {
            assertThrows(IllegalArgumentException::class.java) { RoomShareImport.manifestUrl(link(url)) }
        }
    }

    @Test fun rejectsAmbiguousOrOtherApplicationLinks() {
        val valid = link("http://192.168.1.8:7881$path")
        for (url in listOf(valid.replace("roomcanvas://", "https://"), valid + "&manifest=other", "roomcanvas://import", valid.replace("//import", "//else"))) {
            assertThrows(IllegalArgumentException::class.java) { RoomShareImport.manifestUrl(url) }
        }
    }

    private fun model(): ByteArray {
        val json = """{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}]}"""
        val padded = json.padEnd((json.length + 3) / 4 * 4).toByteArray()
        return ByteBuffer.allocate(20 + padded.size + 12).order(ByteOrder.LITTLE_ENDIAN)
            .putInt(0x46546c67).putInt(2).putInt(20 + padded.size + 12)
            .putInt(padded.size).putInt(0x4e4f534a).put(padded)
            .putInt(4).putInt(0x004e4942).putInt(0).array()
    }

    @Test fun validatesDownloadAndCleansFailedOrCancelledFiles() = runBlocking {
        val directory = Files.createTempDirectory("room-import-test").toFile()
        val previous = java.io.File(directory, "previous.glb").apply { writeText("keep me") }
        val bytes = model()
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val id = "0123456789abcdef0123456789abcdef"
        val checksum = AtomicReference(digest)
        val server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        // java.net exists in the Android compile classpath; JDK-specific HttpServer does not.
        val worker = thread(isDaemon = true) {
            while (!server.isClosed) try {
                server.accept().use { socket ->
                    val input = socket.getInputStream().bufferedReader()
                    val request = input.readLine()
                    while (!input.readLine().isNullOrEmpty()) { /* consume HTTP headers */ }
                    val body = if (request.contains("manifest.json")) {
                        JSONObject().put("schema", 1).put("id", id).put("name", "测试房间")
                            .put("version", "12345678-1234-1234-1234-123456789abc")
                            .put("model", JSONObject().put("url", "/s/$id/room.glb").put("bytes", bytes.size).put("sha256", checksum.get()))
                            .toString().toByteArray()
                    } else bytes
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(body); flush()
                    }
                }
            } catch (e: SocketException) { if (!server.isClosed) throw e }
        }
        val uri = URI("http://127.0.0.1:${server.localPort}/s/$id/manifest.json")
        try {
            val target = java.io.File(directory, "new.glb")
            val result = RoomShareImport.download(uri, target) {}
            assertArrayEquals(bytes, result.file.readBytes()); assertEquals("测试房间", result.name)
            checksum.set("0".repeat(64))
            val failed = java.io.File(directory, "failed.glb")
            try { RoomShareImport.download(uri, failed) {}; fail("hash mismatch must fail") } catch (_: IllegalArgumentException) {}
            assertFalse(failed.exists()); assertFalse(java.io.File(failed.path + ".part").exists())
            checksum.set(digest)
            val cancelled = java.io.File(directory, "cancelled.glb")
            try { RoomShareImport.download(uri, cancelled) { if (it.startsWith("正在下载")) throw CancellationException() }; fail("cancel must fail") } catch (_: CancellationException) {}
            assertFalse(cancelled.exists()); assertFalse(java.io.File(cancelled.path + ".part").exists())
            assertEquals("keep me", previous.readText())
        } finally { server.close(); worker.join(1000); directory.deleteRecursively() }
    }
}
