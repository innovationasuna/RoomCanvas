# 来源、版本与许可

核查日期：2026-10-20。依赖解析固定在 package-lock.json，不使用 @latest 或 CDN。

| 内容 | 版本/来源 | 许可 |
| --- | --- | --- |
| MediaPipe Tasks Vision / WASM | 1.1.0；https://www.npmjs.com/package/@mediapipe/tasks-vision | Apache-2.0 |
| Hand Landmarker 模型 | float16/1，官方 storage.googleapis.com/mediapipe-models | 官方模型卡标明 Apache-2.0 |
| TypeScript | 5.9.3；https://github.com/microsoft/TypeScript | Apache-2.0 |
| Vite | 8.3.4；https://github.com/vitejs/vite | MIT |
| Vitest | 5.0.3；https://github.com/vitest-dev/vitest | MIT |
| @types/node | 24.10.1；DefinitelyTyped | MIT |
| One Euro Filter | 本工程独立实现；算法：Casiez, Roussel, Vogel, CHI 2012 | 实现属于本工程，未复制第三方源码 |
| 界面、图标 | 本工程 SVG / CSS 原创设计 | 本工程自制资产，未另行对外授权 |

模型 URL：https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

官方任务说明：https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/index

官方模型卡（第 2 页 LICENSED UNDER）：https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf

算法与作者实现：https://gery.casiez.net/1euro/

模型与每个 WASM/JS 的来源、字节数和 SHA-256 在 public/vision/manifest.json；执行 `./scripts/run.sh resources` 校验。房间编辑器与房间模型的来源和许可分别见 `web/README.md` 与根目录 README；独立演示的模型、生成脚本及 Three.js npm 依赖已移除。

没有引入第三方仓库、第三方云推理、遥测、字体或纹理。当前摄像头识别仅在浏览器本机运行。正式对外分发前应随发行物保留依赖许可及第三方声明；本工程目前为 private 本地原型。

旧工程调研只引用：总目录内的 `手势控制3D模型/research/modular-selection-2026-10-09.md`（不随本仓库分发）。未复制旧工程代码和 node_modules。

## 2026-10-20 · 移除旧演示依赖

旧演示的 Three.js npm 包、四个自制 GLB、可选 Mac mini 推理后端及 Python 锁文件已移除。当前模块只保留浏览器本地识别和网站依赖；历史实现记录见 LOG.md。房间编辑器自带的 Three.js 和相关许可继续保留在 `web/vendor/`。

## 2026-10-19 · 本地网站视觉资产

`public/images/home-interior.jpg` 来自本次设计中已确认的 `roomcanvas-home-hero.jpg` 生成式室内示意图，版本 `home-preview-20261019`，255847 字节，SHA-256：`f7e10f6f0bd26c3c79592ac8cdd51ff5ff735442380940527f3c0fdc08be9efb`。它是本项目生成式视觉资产，不是第三方摄影，也不表示真实扫描房间；未引入第三方字体、图库或新运行依赖。资源记录同步写入 `public/vision/manifest.json`。

## 2026-10-19 · 本地房间导入与 Google 登录

- `google-auth-library` 11.3.1，Google 官方 Node.js 身份验证库，Apache-2.0；来源：https://github.com/googleapis/google-auth-library-nodejs 。只在本地 Node API 校验 ID Token，不进入前端包。
- `fflate` 0.8.3，MIT；来源：https://github.com/101arrowz/fflate 。用于读取房间 ZIP 和封装两文件导入。
- 两项依赖及新增传递依赖的精确版本、npm 来源、许可和 SHA-512 完整性值写入 `public/vision/manifest.json` 的 `siteDependencies`，与 `package-lock.json` 对照校验。
- Google Identity Services 使用官方 `https://accounts.google.com/gsi/client`；Google 要求直接加载在线 SDK，不做本地镜像或伪造固定散列。页面仅在访问登录页时加载该脚本。
- 房间卡片与创建入口为本工程 SVG / CSS 原创示意图，不代表精确模型截图。卧室导入测试复用已有 `samples/room3`，未引入新模型。
