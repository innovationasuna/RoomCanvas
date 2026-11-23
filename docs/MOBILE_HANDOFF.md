# 手机打开与 App 导入（阶段 1～3）

## 使用方法

1. 在项目根目录启动或重启网页服务：

   ```bash
   python3 web/scripts/serve.py
   ```

   如果平时使用 `--ssh`、`--viewforge`、`--room-backend` 等参数，继续保留原参数。编辑器默认仍为 `http://127.0.0.1:7880/web/`；手机分享首次生成二维码时才打开 `7881` 端口，打开弹窗或下载 GLB 不会开放局域网端口。

2. 在编辑器完成布置，确认或取消未结束的调整，点击右上角 **在手机中打开**。
3. 选择 **下载房间 GLB**，可以将文件传给 Android 手机，使用 App 的“选择房间模型”手动导入。
4. 选择 **生成二维码**，手机连接同一 Wi-Fi 后扫码。页面可以 **在浏览器中体验**；Android 还可以 **在 Android App 中打开**。
5. 手机网页通过单指旋转、双指缩放查看总览；总览自动隐藏顶面和近侧墙，门窗、踢脚线等随所属墙面隐藏，旋转视角时自动切换。点击“走进房间”后，墙面与顶面恢复显示，使用方向按钮移动、滑动画面转向。“视角复位”回到起点，“退出漫游”回到总览。
6. App 自动下载并校验房间，成功后显示房间名和版本。点击“开始漫游”进入；成功导入后可断网重启并打开上次房间。

Android 路径需要安装本次更新的 **0.2.0** 版本，旧版 App 仅支持文件选择器。“在 Android App 中打开”始终展示在浏览器体验按钮下方；iPhone / iPad 上显示为不可用，并说明应使用浏览器。安卓浏览器使用桌面模式时，App 入口也不会被隐藏。若 App 未打开，入口页仍保留浏览器按钮。

安装包交付位置：`output/android/RoomCanvas-Mobile-0.2.0-debug.apk`。这是本地调试签名版本；如与手机已有安装的签名不同，需使用原签名重新构建后更新，避免因卸载旧 App 丢失本地房间。

## 网络与服务

```bash
# 编辑器只监听本机；首次生成二维码时开启局域网只读端口
python3 web/scripts/serve.py --port 7880 --share-port 7881

# 分享端口占用时换一个
python3 web/scripts/serve.py --share-port 7882

# 仅使用电脑编辑器与文件导出
python3 web/scripts/serve.py --no-mobile-share
```

地址候选只接受 RFC 1918 的三个私有 IPv4 网段，并排除已识别的 utun/tun/tap/WireGuard 等隧道接口；198.18.0.0/15 基准测试网段不会列入候选。二维码优先使用检测到的电脑 Wi-Fi 地址。多网卡、VPN 等情况下，可以在弹窗中选择或手动输入手机可达的 IPv4 地址。手机不能使用电脑的 `127.0.0.1` 地址。访客网络的设备隔离或防火墙也可能阻断同网访问。

关闭电脑服务后，二维码暂不可访问；重启服务后端口仍默认关闭；再次生成一次二维码以开启分享端口后，相同地址和端口上的未过期旧链接可继续使用。手机 App 已下载的版本不受电脑离线影响。当前没有异地托管功能。

手机端口只提供分享页、必要的静态资源及随机分享标识对应的文件；不能访问编辑器写接口、重建代理、房间删除接口或仓库目录。模型保存在 `.roomcanvas/shares/<分享标识>/`，每次发布生成独立目录，写入完成后才公开链接。

## 快照保存与清理

完整快照保存在仓库的 `.roomcanvas/shares/<分享标识>/`，包含 `room.glb` 和 `manifest.json`。默认从服务器写入时间起保留 **7 天**，不使用客户端传入的日期。可用 `python3 web/scripts/serve.py --share-days 14` 改为 14 天（允许 1～365 天）；更改天数也会用于已有快照。

启动服务、生成新分享以及服务运行期间每小时会清理过期快照。清理只处理分享目录中的完整随机标识目录，保留未过期快照和无关文件。过期链接不能再读取模型，需重新生成；已经下载到 App 的房间不受影响。电脑服务关闭期间不运行清理，下次启动会继续清理。

需要立即释放空间时，先停止网页服务，再删除 `.roomcanvas/shares/` 中不需要的分享标识目录；删除整个 `shares` 目录会使所有已有分享链接失效，但不删除源房间或 App 中已下载的副本。清理周期内仍可能存在多份大型快照，请留意磁盘空间。

## 快照内容与边界

- 导出单个自包含 GLB，保留原房间、新增物品、模型贴图及已确认的位置、高度、旋转、尺寸。
- 已收纳物品不进入导出场景；编辑器临时隐藏的墙、天花板恢复显示，选中高亮、摆放预览及导入碰撞代理不进入文件。
- 网页总览的近侧墙隐藏只影响显示，GLB 仍保留完整墙面、顶面和原始贴图。新快照携带墙面及附属部件的归属信息；已有分享通过结构节点名称和墙面几何兼容，无需重新生成二维码。
- 手机网页复用编辑器的光照系统。新快照保存光照预设、室内灯开关、调色及环境光/接触暗部设置；不含这些参数的旧分享默认使用“物理光照”。隐藏的墙面和顶面仍参与遮光，玻璃不会变成不透光的阴影遮挡物。
- 手机网页保留原始贴图分辨率，日光阴影图为 1024、局部灯光阴影图为 512，按需更新；接触暗部在停止交互后计算。阴影精细度与桌面端存在差别，不代表模型贴图被缩小。
- 快照在打包开始前固定；打包期间及之后的编辑不会修改该文件。弹窗重新打开时使用最新布置；同一次弹窗中的下载与二维码使用同一个快照版本。
- 首期导出的是静态布置：门窗等开合部件按关闭状态输出，暂不携带编辑器的开合交互动画。两端均能查看和漫游；光照效果可能因渲染器而不同。
- 单份分享上限 512 MB。暂不导出带骨骼的模型，遇到这类模型会明确报错。

## 网页与 App 协议

分享页：`http://<电脑IP>:7881/s/<随机32位标识>/`

清单：`/s/<标识>/manifest.json`

```json
{
  "schema": 1,
  "id": "<32位分享标识>",
  "name": "办公室",
  "version": "<快照UUID>",
  "createdAt": "<ISO时间>",
  "units": "m",
  "floorY": 0,
  "interaction": "static",
  "model": {
    "url": "/s/<标识>/room.glb",
    "bytes": 123456,
    "sha256": "<完整文件SHA-256>"
  }
}
```

App 入口：`roomcanvas://import?manifest=<经过URL编码的清单地址>`。冷启动和已运行状态均接收此入口。同一任务重复点击不会并发下载；打开另一分享会取消旧任务，旧结果不能覆盖新选择。

App 校验地址、大小、SHA-256、GLB 文件头和外部资源引用；完整校验及模型解析成功后才记住新房间。中断、取消、校验失败时清理临时文件，保留上次已导入房间，并提供重试。局域网 HTTP 仅接受私有 IPv4 地址；模型地址必须和清单同源并匹配分享标识，不跟随重定向。

## 验证与复现

```bash
python3 -m unittest discover -s web/scripts -p 'test_mobile_share.py'
python3 -m unittest discover -s web/scripts -p 'test_serve.py'
node --test web/editor/tests/test_mobile_snapshot.mjs web/editor/tests/test_touch_walk.mjs web/editor/tests/test_walk.mjs
node --test web/mobile/tests/test_room_visibility.mjs web/mobile/tests/test_lighting.mjs web/editor/tests/test_wall_visibility.mjs

# 先启动网页服务；Playwright 与 Chrome 路径按本机填写
node web/scripts/check_mobile_handoff.mjs \
  --playwright /path/to/node_modules/playwright \
  --browser '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

cd android-app
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Android 编译使用 JDK 21（现有 SceneView 依赖为 Java 21 字节码）、Android SDK 35、Build Tools 35.0.1、Gradle 8.11.1。源码目标仍为 Java/Kotlin 17。原 Gradle 镜像若返回无效压缩包，可使用校验过的官方 Gradle 8.11.1 执行相同任务。

本机已验证：办公室实际模型导出并重新加载，15 件可见物品的节点位置保持一致；无外部模型/贴图引用；导出不改变编辑器布局；手机尺寸页面加载、漫游入口、视角复位、加载失败后重试、App 未打开时的浏览器回退以及 320/390/768 像素与横屏布局。合成场景测试另外覆盖新增物品变换、收纳、原材质、天花板、不可见碰撞代理和开合部件复位。

### 本地 Android 模拟器（2026-11-23）

本机已安装官方 Android Emulator 37.3.10 和 Android 14（API 34）ARM64 系统镜像，设备名为 `RoomCanvas_API_34`，配置为 2 GB 内存、2 核、720 × 1280 屏幕，使用 Mac 硬件虚拟化与 GPU。SDK 位于 `~/Library/Android/sdk`，虚拟设备数据位于 `~/.android/avd/`。

双击 [启动模拟器](../scripts/start_android_emulator.command)，或在项目根目录运行：

```bash
./scripts/start_android_emulator.command
```

脚本启动专用虚拟设备，安装 `output/android/RoomCanvas-Mobile-0.2.0-debug.apk` 并打开 App；已有房间会保留。首次启动出现 AR Engine 提示时选择 **仅用方向键**，然后点击 **开始漫游**。鼠标按住方向按钮移动，拖动右半屏转向；右上角菜单可回到起点或结束漫游。关闭模拟器窗口即可结束启动任务。运行日志位于 `~/Library/Logs/RoomCanvas/emulator.log`。

测试新的分享时，保持网页服务运行，在模拟器 Chrome 中将分享链接的电脑 IP 替换为 `10.0.2.2`，保留 `7881` 端口及 `/s/<分享标识>/` 路径，再点击 **在 Android App 中打开**。`10.0.2.2` 是模拟器连接 Mac 的地址；真实手机继续使用电脑的局域网 IP。

本次使用本地 0.2.0 APK 与办公室快照 `2b938758`（41,920,296 字节）完成以下检查：

| 检查 | 结果 |
| --- | --- |
| APK 安装与启动 | 通过，确认版本名 0.2.0、版本号 2、ARM64 |
| 浏览器按钮唤起 App | 通过，冷启动与 App 已运行时均能导入 |
| 文件完整性与模型加载 | 通过，App 本地 GLB 的 SHA-256 与清单一致；墙面、家具和贴图正常显示 |
| 方向键移动与滑动转向 | 通过，实际视点位置和朝向发生变化 |
| 回到起点与结束漫游 | 通过，复位后回到原视角；退出后保留房间 |
| 断网重启 | 通过，关闭 Wi-Fi 与移动数据、确认无网络路由后，强制停止并重新打开 App，仍能加载房间并进入漫游；测试后已恢复网络 |
| 运行异常 | 本次测试日志未发现崩溃或 ANR |

截图和版本记录位于 [模拟器测试结果](../output/android/emulator-test/)。本次验证的是原生 APK 的实际运行，未修改 App 渲染代码或模型贴图分辨率。华为 AR Engine 的真实走动定位、真实手机性能和 iPhone Safari 表现仍需对应真机验证。

真机验收待完成：当前未连接 Android 手机；浏览器设备模拟和 Android 模拟器都不能替代 Android/iPhone 真机。仍需在实际 Wi-Fi 中确认扫码连通，并复核导入、离线重开与渲染表现。结果与勾选状态见 [计划表](MOBILE_HANDOFF_PLAN.md)。
