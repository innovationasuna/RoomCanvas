# RoomCanvas 手势接入

更新：2026-10-20。手势识别只驱动 RoomCanvas 编辑器，物体重建后端不参与摄像头、手势消息或场景操作。

## 推荐入口

在仓库根目录执行 `python3 web/scripts/serve.py`，打开 <http://127.0.0.1:7880/web/> 并选择房间，点击编辑器的“手势”按钮。摄像头默认关闭，视频和关键点只在本机浏览器 Worker 中处理，不录制、不上传。

识别代码由 `src/embed/index.ts` 打包到 `web/vendor/gesture/`，复用 `src/integration/runtime.ts` 和手势状态机。`web/editor/gesture-camera.mjs` 将帧直接交给 `gesture-bridge.mjs` 的 `GestureInput`。鼠标和手势共用编辑器的操作入口、承托与碰撞逻辑。

## 可选的独立识别页

在仓库根目录运行：

```bash
sh scripts/gesture.sh install
sh scripts/gesture.sh dev
```

打开 <http://127.0.0.1:8800/roomcanvas.html>。默认嵌入 <http://127.0.0.1:7880/web/editor/?room=room3>，地址栏或 `?layout=<编码后的编辑器 URL>` 可指定其他 RoomCanvas 房间。这个页面只显示摄像头和控制反馈，房间仍由 RoomCanvas 渲染，不需要 ViewForge 隧道。Vite 同时保留原独立识别演示 `index.html` 作为开发夹具。

iframe 协议为 `roomcanvas-gesture-v1`，双方校验本机 origin、source、会话和递增序号。仅发送镜像指针、捏合状态、模式和操作反馈，不发送视频、原始关键点或深度。已移除原 ViewForge 手势页及其场景接收端。

## 操作

- 左手 1 / 2 / 3 保持约 400ms，选择移动 / 旋转 / 观察。忙碌时不切换、不排队；恢复后先张掌。
- 右手两指捏合拖动物体；松开保留预览，轻捏确认放置。仓库卡片可捏住拖进房间。
- 观察模式两指捏合环绕、三指合拢平移；动作开始时锁定，松手后再换动作。
- 释放首帧冻结；丢手不能当作放置确认，恢复后先松手再抓取。关闭摄像头释放流与 Worker。

## 检查与构建

在 `gesture/` 运行 `npm run typecheck`、`npm test`、`npm run check:resources`、`npm run build`；内置识别包用 `npx vite build --config vite.embed.config.ts` 生成，并随源码更新。编辑器测试见 `web/README.md`。

自动化与合成输入检查不代替物理摄像头验收；手型准确率、左右方向和长时间性能仍需真人体验。模型版本、资源校验值与许可见 [来源](sources.md)。
