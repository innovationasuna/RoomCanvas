# RoomCanvas · 本地网站与双手工作台

通过普通摄像头在浏览器里布置真实三维房间，也可全程使用鼠标。网站包含封面、我的房间、创建房间、Google 登录、家具库和三维工作台。

唯一网站入口是 **[RoomCanvas.html](http://127.0.0.1:8800/RoomCanvas.html)**。根地址和旧书签自动跳到该页面，保留查询参数和页面位置；源码和构建只保留这一份 HTML。旧独立家具演示及其远程摄像头后端已移除。

## 本地启动

需要 Python 3、Node.js 22.12+ 和 npm。在 RoomCanvas 仓库根目录首次安装依赖：

```sh
sh scripts/gesture.sh install
```

每次使用时开启两个终端，分别在 RoomCanvas 根目录执行并保持运行：

```sh
python3 web/scripts/serve.py --port 7870
```

```sh
sh scripts/gesture.sh dev
```

打开 [RoomCanvas](http://127.0.0.1:8800/RoomCanvas.html)。直接打开房间列表可用 [我的房间](http://127.0.0.1:8800/RoomCanvas.html#rooms)，进入工作台可用 [房间工作台](http://127.0.0.1:8800/RoomCanvas.html#studio)。停止时分别按 `Ctrl+C`，已有服务运行时无需重复启动。

封面向左拉动屏宽的 1/8 后松开进入“我的房间”，短拉回弹，也可点击“左拉开启”。房间网格支持搜索、排序、创建、导入、重命名、删除与撤销。创建页提供照片和文件导入两个入口；照片仅支持选图预览，重建服务尚未接入。

## 双手与鼠标

摄像头默认关闭，只有点击“开启摄像头”才会申请授权。识别在本机 Worker 中运行，不录制或上传画面与完整关键点。工作台左侧是摄像头、摆放工具与确认，下方是房间家具与添加素材，两栏均可收起。

| 操作 | 输入 |
| --- | --- |
| 平面移动 | 左手数字 1 选模式，右手捏合移动 |
| 高度调整 | 左手数字 2 选模式，右手捏合上下移动 |
| 房间缩放 | 左手数字 3 选模式，双手捏合拉开或靠近；不改变家具尺寸 |
| 连续旋转 | 左手数字 4 选模式，右手捏合横移；一画面宽度对应 1080° |
| 环绕视角 | 左手捏合拖动，可与右手操作同时进行 |
| 确认放置 | 右手竖拇指保持约半秒，或点击放置按钮、在场景内按 Enter |
| 暂停与恢复 | 松手保留预览；丢手立即冻结，恢复后先松手再抓取 |

数字保持约 400ms 后切换，操作或校验期间不抢占。数字 3 支持中指、无名指、小指伸直，拇食指合拢的姿势。放置通过承托、墙面安装、碰撞和落下检查后保存并加入撤销。摄像头骨架与视频使用一致的镜像和比例。

鼠标可选择家具、使用左栏工具与微调按钮、滚轮缩放、切换整体/俯视；房间端保留撤销和布局文件导入导出。具体手势与状态保护见 [操作说明](docs/gestures.md)。

## 数据和登录

本地 Node API 保存房间清单、上传资产和会话，数据位于仓库旁的 `.roomcanvas-local/`。房间模型放在 `samples/` 或导入目录，三维编辑器由 `web/` 提供。清理入口和旧演示不会改变现有房间数据。

Google 登录使用官方按钮和服务端 ID Token 验证，需要自行配置 Web Client ID 和允许的 JavaScript 来源；本轮真实账户登录尚待验证。导入格式和登录设置见 [登录与房间管理](docs/google-login.md)。

另开本地验收环境时，可在忽略的 `.env.local` 中指定 `VITE_ROOMCANVAS_EDITOR_ORIGIN` 和 `ROOMCANVAS_DATA_ROOT`，并用 `npm run dev -- --port <端口>` 启动网站。两个变量分别控制编辑器地址（含 `/room` 代理）和房间/会话目录；默认值不变。使用独立数据目录和不同的本机主机名，可避免与日常预览共用房间、会话和浏览器布局。

工作台“添加素材”保留远端的多照片物体重建、蒙版确认、进度和实测尺寸流程；X/Y/Z 坐标轴可选，导入实例可单独删除，源重建结果保留。它需要物体 API，连接方式见根目录 [物体说明](../docs/OBJECT_RECONSTRUCTION.md)。门窗与柜门开合、光照和近侧遮挡透明也保留在三维编辑器中。

## 验证与构建

以下命令在 `gesture/` 中执行：

```sh
npm test
npm run typecheck
npm run check:resources
npm run build
npm run preview
```

构建只生成 `dist/RoomCanvas.html` 及所需资源。`dist/` 可以删除，执行构建即可重新生成；生产预览需要先构建，开发模式不依赖它。开发与预览默认共用 8800 端口，不能同时占用该端口。

更改识别运行时后，在 `gesture/` 运行 `npx vite build --config vite.embed.config.ts`，同步 `web/vendor/gesture/` 中的内置识别包；构建保留该目录的来源说明。该包用于直接打开的独立编辑器，完整工作台的摄像头由网站左栏统一管理。

识别模型或 WASM 缺失时运行 `npm run prepare:vision`（需要网络）。来源、版本、许可和校验值见 [资源说明](docs/sources.md) 与 `public/vision/manifest.json`。真实摄像头准确率、长时间性能和 Safari 兼容性需要真人设备验证，自动化检查不代替真人验收。

## 模块

- `src/integration/`：网站页面、封面与等待动画、房间管理、登录和三维编辑器通信。
- `src/camera/`、`src/tracking/`、`src/gestures/`：摄像头、Worker 推理和手势状态机。
- `src/ui/`、`src/shared/`：骨架反馈、共享类型、配置和滤波。
- `server/`：本地房间 API、导入校验和 Google 身份验证。
- `public/`：识别模型、WASM 和首页图片。
- `tests/`、`scripts/`：回归测试、启动与资源检查。

房间端的渲染、鼠标操作和物理校验位于 `../web/editor/`。`layout=` 参数或“连接与帮助”可指定其他本机 RoomCanvas 编辑器；通信统一使用 `roomcanvas-gesture-v1`，见 [接入说明](docs/roomcanvas-integration.md)。

[架构](docs/architecture.md) · [来源与许可](docs/sources.md) · [开发日志](LOG.md)

本模块遵循根目录 [Apache License 2.0](../LICENSE)，依赖和模型分别遵循各自许可。旧版演示计划与验收记录仅作为历史保留，不代表当前功能。
