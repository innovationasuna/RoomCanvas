# web/vendor/gesture

编辑器“手势”开关用的识别代码：摄像头、MediaPipe 手部追踪（在 Worker 里跑）、捏合 / 左手数字 / 右手竖拇指确认 / 观察手势识别与骨架绘制，以及手势协议的帧格式。不画场景，场景由编辑器自己画。

- 来源：`gesture/src/embed/index.ts`（与独立识别页共用运行时）。`gesture/src/embed/tracker.ts` 代替原来的 `tracking/tracker.ts`，区别只是 MediaPipe 文件的地址由页面传入（`setVisionBase`），原来写死在站点根目录 `/vision/`。
- 构建：在 `gesture/` 目录 `npm ci` 后运行 `npx vite build --config vite.embed.config.ts`，输出到这里（`gesture-runtime.js`、`gesture-worker.js`）。改了 `gesture/src` 里被打包的代码（`camera`、`tracking/worker.ts`、`gestures`、`integration/runtime.ts`、`integration/protocol.ts`、`ui/hand-feedback.ts`）就重新构建，和源码一起提交。
- MediaPipe 的 wasm 和模型不在仓库里复制：`web/vendor/vision` 是指向 `gesture/public/vision/` 的软链接，编辑器读 `../vendor/vision/`；`web/scripts/publish.py` 复制 `vendor/` 时顺着软链接把它们一起带上（约 45 MB）。
- 许可：`gesture-worker.js` 内含 `@mediapipe/tasks-vision` 1.1.0（Apache-2.0）；手势代码本身的许可和来源见 [`gesture/README.md`](../../../gesture/README.md)、[`gesture/docs/sources.md`](../../../gesture/docs/sources.md)。
