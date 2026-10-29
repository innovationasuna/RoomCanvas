# 手势识别

RoomCanvas 的手势模块：用普通摄像头在浏览器里识别双手，右手捏合控制物品，左手捏合环绕视角，两手可同时操作。基于 **TypeScript、Three.js、MediaPipe Hand Landmarker 和 Vite**，不需要深度相机。默认在本机浏览器中识别；独立演示也支持用户主动开启的局域网远程识别。

本模块提供两部分：RoomCanvas 编辑器内置的识别运行时（打包到 `web/vendor/gesture/`），以及一个自带起居室场景的独立演示，用于开发和调参。

[快速开始](#快速开始) · [手势操作](#手势操作) · [RoomCanvas 接入](#roomcanvas-接入) · [参数调整](#参数调整) · [文档](#文档)

## 独立演示的功能

- 自制约 6 × 5 米起居室，以及沙发、茶几和椅子 GLB 资产。
- 家具贴地移动、15°吸附旋转、高度调整、房间边界约束与撤销。
- 右手物体控制与左手视角环绕并行；天蓝色 / 浅绿色指尖、连线和中点反馈。
- 左手张掌打开菜单，握拳关闭，右手捏合选择；支持暂停、场景切换和确认复位。
- 独立 XYZ 场景与 20 个不同深度的定位目标，显示深度与地面投影。
- 松手首帧冻结控制、追踪失效冻结与松手重抓保护；鼠标备用输入。
- 模型、WASM 与场景资源随工程提供，完成依赖安装后可在 localhost 离线运行。

## 快速开始

### 环境

- Node.js **22.12+** 与 npm（可使用 Node.js 24 LTS）。
- 支持 WebGL2、摄像头和 Web Worker 的浏览器；主要测试环境为 Apple Silicon Mac + Chrome。
- 摄像头只在点击开启按钮并授权后使用；鼠标模式不需要摄像头。

在拉取后的 RoomCanvas 仓库根目录进入 `gesture/`，再安装并启动：

```sh
npm ci
npm run dev
```

打开 **[http://localhost:8800](http://localhost:8800)**，先用鼠标熟悉场景，再点击“开启摄像头”。使用本机浏览器识别模式即可，不需要启动 Python 后端。终端按 `Ctrl+C` 停止服务。

依赖安装后也可以执行 `./scripts/run.sh dev`，脚本不会自动安装依赖。

### 构建与检查

```sh
npm test
npm run typecheck
npm run check:resources
npm run build
npm run preview
```

开发与预览服务共用 8800 端口，请先停止已有服务。构建结果位于 `dist/`。

模型与 WASM 缺失时执行 `npm run prepare:vision`（需要网络）；自制 GLB 可用 `npm run assets` 重建。资源来源与 SHA-256 见 [来源清单](docs/sources.md) 和 [资源 manifest](public/vision/manifest.json)。

## 手势操作

独立演示固定右手操作物体、左手控制视角，操作表和状态转换见 [手势说明](docs/gestures.md)；RoomCanvas 编辑器使用[双手布置规则](docs/roomcanvas-integration.md#操作)。

### 鼠标操作

- 左键拖动执行当前模式；上方工具栏切换模式。
- XYZ 移动模式滚轮调整深度；XYZ 缩放模式滚轮调整大小；其他模式滚轮调整相机距离。
- `Esc` 关闭菜单并中断操作。鼠标拖动期间暂停手势变换，结束后需松手重抓。

## RoomCanvas 接入

正式使用请打开 RoomCanvas 编辑器的“手势”开关。识别与场景操作均在本机浏览器完成，不依赖物体重建后端。

调试独立识别页可在仓库根目录执行 `sh scripts/gesture.sh dev`，打开 <http://127.0.0.1:8800/roomcanvas.html>，默认连接 7880 的 RoomCanvas 编辑器。左手 1/2/3/4 切移动、抬高、场景缩放、旋转；左手捏合环绕，右手捏合操作家具，竖拇指约 0.5 秒确认。数字 3 支持拇食指成圈、其余三指伸出的手型。实现、协议和构建说明见 [RoomCanvas 接入](docs/roomcanvas-integration.md)。

## 参数调整

参数默认值与含义见 [`src/shared/config.ts`](src/shared/config.ts)，调整方法见 [调整松手手感](docs/gestures.md#调整松手手感)。开发服务会自动更新，生产模式需要重新构建；建议每次只改一个参数，再检查误抓、释放和遮挡恢复表现。

## 架构

```text
摄像头 → tracking 关键点 → gestures 手势事件 → controls 控制命令 → Three.js 场景
                                     ↓                        ↑
                                   UI 反馈                 鼠标输入
```

```text
src/
├── app/           生命周期、推理调度与菜单协调
├── camera/        摄像头选择、开启与释放
├── tracking/      本地 Worker 推理与可选远程适配
├── gestures/      特征、捏合、张掌、握拳与身份保护
├── controls/      映射、约束、控制会话与撤销
├── scene/         渲染、家具与 XYZ 定位场景
├── ui/            工具栏、菜单、摄像头预览与标记
├── shared/        类型、配置与滤波
└── styles/        页面布局
public/            本地模型、WASM 和 GLB 资源
backend/           可选的局域网 Python 推理服务
scripts/           资源准备、校验与本机启动
tests/            合成关键点和模块协作测试
docs/             架构、操作、接入与来源说明
```

## 隐私与远程识别

默认在浏览器 CPU Worker 中识别、WebGL2 渲染，不录制、不保存、不上传摄像头画面或关键点。

独立演示另有可选的远程识别模式：把摄像头帧发送到用户指定的局域网后端（如一台 Mac mini），由 Python MediaPipe 推理，浏览器继续处理手势和渲染。只有选择远程模式并点击发送画面按钮后才传输，不调用第三方云服务，各客户端的布局互相独立。安装、HTTPS 证书与启动步骤见 [远程识别后端](docs/remote-backend.md)。

依赖目录、构建产物、运行输出、虚拟环境、测试证书与私钥不纳入 Git。

## 使用提示

- 深度由掌部在画面中的大小估计，手掌正对摄像头时最稳定。
- 推荐使用 Chrome；开启摄像头后稍等片刻，追踪稳定后再操作。
- 独立演示用于调参，碰撞和支撑检查在 RoomCanvas 编辑器中进行。
- 撤销恢复物体变换，复位同时恢复布局和视角。

## 文档

| 文档 | 内容 |
| --- | --- |
| [RoomCanvas 接入](docs/roomcanvas-integration.md) | 编辑器内的双手操作、协议与构建 |
| [模块架构](docs/architecture.md) | 职责、数据流与并行控制 |
| [手势说明](docs/gestures.md) | 独立演示的操作、状态转换和参数 |
| [远程识别后端](docs/remote-backend.md) | 可选的局域网推理服务 |
| [来源与许可](docs/sources.md) | 依赖、模型与资产来源 |

## 反馈与许可

反馈问题时请注明设备、浏览器、识别模式、复现步骤与预期结果。若涉及摄像头，请优先描述手势与状态，无需上传个人画面。

手势模块的代码和自制资产随 RoomCanvas 以 [Apache License 2.0](../LICENSE) 发布；依赖和模型分别遵循各自的许可，详见 [来源与许可](docs/sources.md)。
