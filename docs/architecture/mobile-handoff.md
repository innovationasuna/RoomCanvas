# 手机分享端口、快照与导入协议

编辑器把当前已确认的布置导出为一个自包含 GLB。手机浏览器和 Android App 读取同一份模型与版本。操作步骤见[手机体验与 App 导入](../MOBILE_HANDOFF.md)。

## 启动与网络

在本机仓库根目录运行。已有的重建连接参数（如 `--ssh`、`--viewforge`、`--room-backend`）可继续使用。

```bash
python3 web/scripts/serve.py
```

| 目的 | 启动选项 |
| --- | --- |
| 使用默认端口 | `--port 7880 --share-port 7881`。编辑器默认在本机回环地址，局域网只读端口在首次发布时开启。 |
| 更换已被占用的分享端口 | 如 `--share-port 7882`。重启服务并重新生成二维码。 |
| 仅使用编辑器与文件导出 | `--no-mobile-share` 关闭局域网入口。打开弹窗或下载 GLB 本身也不会创建监听端口。 |
| 改为保留 14 天 | `--share-days 14`。允许 1–365 天，默认 7 天。同样适用于已发布快照。 |

自动推荐地址取自 RFC 1918 的三个私有 IPv4 网段，过滤能识别的 utun、tun、tap、WireGuard 等隧道接口，排除基准测试网段 198.18.0.0/15。macOS 优先尝试 en0，多网卡时可手动选择。

真机需使用手机可达的电脑局域网地址。手机的 `127.0.0.1` 指向手机自身。桌面程序关闭后，同网链接须等电脑重新运行并发布一次才能使用。目前发布端只提供局域网服务。[监听与路由](../../web/scripts/mobile_share.py)

## 保存期限与清理

- 快照位于 `.roomcanvas/shares/<随机标识>/`，包含 `room.glb` 和 `manifest.json`。服务计算 SHA-256，校验 GLB，写完清单后才将临时目录改名并返回链接。每次发布有独立目录。
- 有效期以电脑写入清单的时间为起点。读取已过期的分享会失败。启动时、新发布后及运行期间每小时清理到期目录。关机期间停止清理，下次启动继续。
- 清理只处理名称符合完整随机标识、清单已过期的目录，跳过符号链接和无关文件。多份未过期模型会同时占用磁盘空间。
- 要手动释放空间，先停网页服务，核对要作废的分享标识，只移除对应目录。移除整个 `shares` 会让所有旧链接失效。源房间和 App 离线副本保留。

只读端口提供分享页、必要静态资源、指定标识的模型和清单。桌面编辑、重建代理、房间删除接口及仓库目录不在路由中。

## 快照与渲染

| 内容 | 行为 |
| --- | --- |
| 捕获时机 | 首次下载或发布前同步复制已确认的场景，再异步编码。相同弹窗共享一次捕获的版本。重新打开才捕获最新布置。 |
| 场景过滤 | 保留模型、贴图与确认后的变换。剔除收纳物品、选中高亮、摆放预览、碰撞代理，恢复临时墙体显示和顶面。 |
| 门窗与几何 | 导出静态关闭位置。不携带开合动画。含骨骼的模型会报错。导出的完整 GLB 保留原始贴图分辨率。 |
| 近侧墙 | 新快照带墙体、顶面与附属物的归属信息。缺少元数据时，网页按结构节点名和墙面几何推断。旋转时切换近侧墙，进入漫游后恢复显示。 |
| 光照 | 保存预设、室内灯、调色、环境光和接触暗部设置。无光照元数据的既有分享默认用物理光照。 |
| 阴影 | 网页复用编辑器光照系统。需要遮光的隐藏墙体和顶面继续遮光。透明／透射玻璃不生成不透明的遮挡代理。 |
| 移动端预算 | 日光阴影图为 1024²，局部灯光为 512²，按需更新。接触暗部在交互停下后计算，桌面与手机可有不同的阴影精度。 |

实现见[场景捕获](../../web/editor/mobile-snapshot.mjs)、[手机端可见性](../../web/mobile/room-visibility.mjs)和[手机端光照](../../web/mobile/lighting.mjs)。

## 清单和 App 导入

分享页路径为 `/s/<32位十六进制标识>/`，默认分享源为 `http://<电脑局域网地址>:7881`。同一路径下提供 `manifest.json` 与 `room.glb`。例如，办公室快照的清单包含以下字段。

```json
{
  "schema": 1,
  "id": "<32位分享标识>",
  "name": "办公室",
  "version": "<快照UUID>",
  "createdAt": "<ISO时间>",
  "units": "m",
  "floorY": 0,
  "bounds": {"min": [0, 0, 0], "max": [4, 3, 5]},
  "interaction": "static",
  "model": {
    "url": "/s/<标识>/room.glb",
    "bytes": 123456,
    "sha256": "<完整文件SHA-256>"
  }
}
```

1. 用户点击 App 按钮，打开 `roomcanvas://import?manifest=<经过URL编码的清单地址>`。冷启动和已运行的 App 都可接收。iPhone / iPad 保留浏览器入口。
2. App 检查清单地址、版本、标识和模型路径。HTTP 只接受 RFC 1918 私有 IPv4。模型必须与清单同源且指向同一分享，不跟随重定向。
3. 下载上限为 `512 × 1024 × 1024` 字节。App 先写临时文件，核对大小、SHA-256、GLB 文件头与外部资源引用，再解析模型并记住最后成功的房间。
4. 同一任务重复点击不会并发下载。打开另一分享会取消旧任务。取消或校验失败时清理临时文件，保留上次已导入的房间。下载失败时可重试。

实现见[地址与文件校验](../../android-app/app/src/main/java/com/hausen3d/arviewer/RoomShareImport.kt)和[导入状态与离线房间](../../android-app/app/src/main/java/com/hausen3d/arviewer/VrWalkthroughActivity.kt)。

## 验证与复现

从仓库根目录可验证分享路由、快照、近侧墙、光照和触摸漫游。

```bash
python3 -m unittest discover -s web/scripts -p 'test_mobile_share.py'
python3 -m unittest discover -s web/scripts -p 'test_serve.py'
node --test web/editor/tests/test_mobile_snapshot.mjs web/editor/tests/test_touch_walk.mjs web/editor/tests/test_walk.mjs
node --test web/mobile/tests/test_room_visibility.mjs web/mobile/tests/test_lighting.mjs web/editor/tests/test_wall_visibility.mjs
```

浏览器检查需先准备办公室示例模型并启动网页服务，按实际安装位置提供 Playwright 和 Chrome。

```bash
node web/scripts/check_mobile_handoff.mjs \
  --playwright '<Playwright 模块绝对路径>' \
  --browser '<Chrome 可执行文件绝对路径>'
```

Android 构建使用 JDK 21、Android SDK 35、Build Tools 35.0.1 和 Gradle 8.11.1。SceneView 依赖使用 Java 21 字节码，项目 Java/Kotlin 的目标版本为 17。

Wrapper 镜像无法提供有效压缩包时，可用校验过的官方同版本 Gradle 执行相同任务。

```bash
cd android-app
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

模拟器工具、调试包路径及 `10.0.2.2` 转接方法见 [Android 调试说明](../../android-app/README.md#在本机模拟器上调试)。历史实测和真机待验项见[验收记录](../history/MOBILE_HANDOFF_VALIDATION.md)。
