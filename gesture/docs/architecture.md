# 架构与本机运行

## 入口与职责

网站唯一 HTML 源文件是 `RoomCanvas.html`。Vite 开发和预览服务将根地址、旧 `index.html`、`viewforge.html` 和 `furniture-demo.html` 书签重定向至该页面，不再维护重复 HTML。查询参数与页面 hash 保留。

| 模块 | 职责 |
| --- | --- |
| integration/site、room-library、account | 页面切换、房间管理和登录界面 |
| integration/cover-pull、scene-loading | 封面拖动、回弹和加载动画的连续收尾 |
| camera、tracking | 用户触发摄像头授权、串行 Worker 推理和资源释放 |
| gestures | 特征、捏合迟滞、身份保护、数字选择和竖拇指确认 |
| integration/runtime、main、protocol | 识别调度、状态反馈和与房间 iframe 的受限通信 |
| ui/hand-feedback、shared | 镜像骨架绘制、类型、配置和滤波 |
| server | 房间清单、资产导入、会话和 Google 身份验证 |
| ../web/editor | 三维渲染、家具选择、变换、承托/碰撞/落下检查、保存与撤销 |

旧独立家具演示的 App、Controller、Three.js 场景、远程识别后端及专用资源已移除。网站内的 Three.js 房间仍由 `web/editor/` 和 `web/vendor/` 提供。

## 数据流与交互

`摄像头 → Worker 关键点 → 手势状态机 → 本地 postMessage → 房间编辑器`。鼠标与手势在房间端共用摆放和确认流程。

右手操作家具、左手捏合环绕，可同时进行。数字 1/2/3/4 分别选择移动、高度、双手缩放和旋转；双手缩放优先于单手操作，结束后保持捏合的左手以当前视角重建基准。旋转横移一画面宽度对应 1080°，缩放只改变相机。

松手保持预览，竖拇指、按钮或 Enter 明确确认后，房间端执行承托、墙面安装、碰撞和落下检查，通过才保存与记录撤销。丢手、歧义或陈旧帧不会触发放置；恢复后先松手再抓取。

## 坐标与资源

视频源不翻转，视频预览和骨架分别做一次水平镜像，并使用一致的尺寸与宽高比。右手暖琥珀、左手青玉；指尖张开超出显示阈值后隐藏指尖强调，完整骨架仍保留。

每次只允许一个在途 ImageBitmap，完成后关闭；超时帧丢弃，持续中断立即冻结。页面隐藏时停止推理调度；停止摄像头、换房间和退出时释放视频流、Worker 与待处理请求。不开启远程摄像头传输。

## 服务和持久化

Vite 默认绑定 `127.0.0.1:8800`，Python 房间服务默认绑定 `127.0.0.1:7870`。本地 API 在开发和生产预览模式都可用；仅复制静态构建文件不能替代房间与登录 API。

房间清单、导入资产和会话位于仓库旁 `.roomcanvas-local/`，布局按房间实例隔离。房间 API 校验归属、Origin 和 CSRF；Google 登录由官方 GIS 提供按钮，由 Node API 校验 ID Token。

识别模型、WASM 与首页图片本地提供。只有进入登录页才加载 Google 官方 SDK。编辑器统一使用 `roomcanvas-gesture-v1`，协议详情见 [接入说明](roomcanvas-integration.md)。物体重建通过编辑器的 `/viewforge/assets/`、`/viewforge/objects/` 和 `/viewforge/dimensions/` 接口完成，不参与摄像头识别。
