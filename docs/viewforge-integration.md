# ViewForge 手势接入

更新：2026-10-13。入口只启动浏览器摄像头、Worker 和手势识别，不启动原 Three.js 演示场景。3D 渲染、承托、碰撞校验由嵌入的 ViewForge Babylon.js 布局页处理。

## 启动与操作

```bash
npm ci
npm run dev
```

打开 http://127.0.0.1:8800/viewforge.html，保持已有 ViewForge SSH 隧道 127.0.0.1:7865 可用。默认布局地址使用服务器 `/workspace/geyinuo/ViewForge/code/scripts/assets/room-layout.html`；环境变化时在页面修改地址再连接。也可通过 `?layout=<编码后的布局 URL>` 配置。

在嵌入布局页确认房间尺寸、加入已标定物体。点击开启摄像头并授权，再选移动或旋转，先松手再捏合。右手中点指向物体，捏合抓取；移动沿地面/承托面，旋转左右拖动。开始释放即冻结，确认释放后检查碰撞，通过才应用，失败恢复原位。可点击取消或 Esc；鼠标继续可用。

摄像头默认关闭，本机 Worker 识别，不录制或上传。关闭时释放视频流和 Worker。首版只允许本机 loopback 地址，未接入远程识别模式。

## 代码与边界

- `src/integration/runtime.ts` 复用 CameraSource、Tracker 和 GestureEngine；原 App 和演示 Controller 不变。
- `src/integration/main.ts` 提供摄像头、模式和反馈，以及 iframe 握手和发布器。
- `src/integration/protocol.ts` 输出最小右手状态和校验布局反馈，协议 `viewforge-gesture-v1`。
- 输出不含原始关键点、视频帧、世界位置、左手或菜单指令。features.ts 已镜像指针，禁止二次翻转。
- `frame` 只带右手 u/v、pinching/started/ended/releasing、interrupted/ambiguous。u/v 映射目标场景画布，不含布局侧栏。sampleTime 使用 performance.timeOrigin + 输入帧 timestamp。
- `hello/mode/stop` 和 `state` 完成连接、view/move/rotate 模式及明确取消/反馈；双方校验 origin、source、会话和序号。
- 追踪缺失冻结，长中断恢复原位，不能作为提交。松手已提交后丢手保留校验；明确取消、关闭摄像头可取消尚未返回的结果。恢复后松手重抓。
- 接入页旋转由 ViewForge 连续映射，一画面宽度 π 弧度，不套用原演示的 15°吸附。左手视角、菜单、高度、缩放和 XYZ 深度暂未接入。

Vite 同时构建 `index.html` 与 `viewforge.html`，原演示入口继续保留。生产预览可用 `npm run build` 后 `npm run preview`，访问同一路径。

## 当前验证

类型检查、55 项前端测试、资源校验与构建通过。Chrome 使用合成摄像头和关键点，验证真实识别状态机到 ViewForge 候选预览、自由旋转、松手校验、拒绝回退、丢手取消、全量替换及鼠标操作，未出现页面异常。验证布局 API 使用内存夹具，没有保存服务器测试布局；测试没有使用真人摄像头。

另用真实 MediaPipe Worker/WASM/模型处理 Chrome 合成摄像头帧，确认识别资源可以初始化、真实服务三个房间正常加载、摄像头默认关闭且停止后释放。没有使用物理摄像头，没有保存服务器布局。

真实摄像头指向、左右手标签、旋转方向/增益、释放手感及长时间性能仍待用户体验。详细场景实现及记录在 ViewForge `code/docs/GESTURE_INTEGRATION.md`。配套分支为本仓库 `codex/viewforge-integration` 与 ViewForge `codex/gesture-integration`，首版实现已本地提交为 `ee685b6`，尚未推送；ViewForge 按用户要求暂不提交。

## 下一阶段

已规划左手 1/2/3 分别选择移动、旋转、仅观察；观察模式下右手捏合调整相机，平移和环绕都需要，切换手势待后续约定。新功能尚未实现，详见 [下一阶段计划](viewforge-next-plan.md)。
