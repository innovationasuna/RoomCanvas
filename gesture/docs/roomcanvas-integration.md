# RoomCanvas 手势接入

更新：2026-10-20。手势识别只驱动 RoomCanvas 编辑器，物体重建后端不参与摄像头、手势消息或场景操作。

## 推荐入口

在仓库根目录安装网站依赖，再分别启动编辑器和网站：

```bash
sh scripts/gesture.sh install
python3 web/scripts/serve.py --port 7870
```

另一个终端：

```bash
sh scripts/gesture.sh dev
```

打开 [RoomCanvas](http://127.0.0.1:8800/RoomCanvas.html)。这是封面、我的房间、登录、创建和工作台的唯一网站入口；默认办公室编辑器在 `http://127.0.0.1:7870/web/editor/?scene=../../samples/office`。旧地址（包括小写 `roomcanvas.html`）重定向到该入口。摄像头、模式与放置确认集中在左侧，下方是家具和添加素材。

摄像头默认关闭，仅点击“开启摄像头”后申请权限。视频和关键点只在本机 Worker 中处理，不录制、不上传。地址栏 `?layout=<编码后的编辑器 URL>` 可指定其他本机 RoomCanvas 房间。`.env.local` 的 `VITE_ROOMCANVAS_EDITOR_ORIGIN` 可改变默认编辑器地址；另设 `ROOMCANVAS_DATA_ROOT` 可隔离本地验收数据，见 `.env.example`。

iframe 协议为 `roomcanvas-gesture-v1`，双方校验本机 origin、source、会话和递增序号。仅发送镜像指针、捏合状态、模式和操作反馈，不发送视频、原始关键点或深度；能力声明包含独立左手观察、双手缩放、竖拇指确认及工作台控制。

## 独立编辑器

直接打开 `http://127.0.0.1:7870/web/editor/?room=office` 时，编辑器“手势”按钮可启动内置摄像头卡片。识别代码由 `src/embed/index.ts` 打包到 `web/vendor/gesture/`，共用 `src/integration/runtime.ts` 和手势状态机。`web/editor/gesture-camera.mjs` 将帧直接交给 `gesture-bridge.mjs` 的 `GestureInput`。嵌入完整工作台时内置按钮隐藏，避免两处同时占用摄像头。鼠标和手势共用操作入口、承托与碰撞逻辑。

## 操作

- 左手 1 / 2 / 3 / 4 保持约 400ms，选择移动 / 高度 / 双手缩放视角 / 旋转。忙碌时不切换、不排队；恢复后先张掌。数字 3 支持中指、无名指、小指伸直、拇食指合拢。
- 右手捏合拖动物体；松开保留预览，右手竖拇指保持约半秒确认。确认始终对应当前预览，碰撞和落点校验期间不重复触发。家具卡片可捏住拖进房间。
- 左手捏合可独立环绕，与右手操作同时进行；缩放模式下双手捏合控制视角距离，不改变家具尺寸。双手结束后保留捏合的左手从当前视角继续，避免跳变。
- 旋转横移一画面宽度对应 1080°，也可用左栏按钮切模式、微调和确认。
- 释放首帧冻结；丢手不能当作放置确认，恢复后先松手再抓取。关闭摄像头释放流与 Worker。

## 物体与房间

编辑器继续通过 `/viewforge/assets/` 读取重建结果，通过 `/viewforge/objects/` 上传照片、抠图和重建，通过 `/viewforge/dimensions/` 保存实测尺寸。X/Y/Z 尺寸预览、删除单个导入实例、门窗开合与光照保留。摄像头无需物体服务，物体重建也不接收摄像头画面。

网站创建页的“照片生成房间”仍是未接通的房间级功能；不能把已接入的物体重建当作整间房重建。文件导入、重命名、删除和撤销由本地房间 API 提供。

## 检查与构建

在 `gesture/` 运行 `npm run typecheck`、`npm test`、`npm run check:resources`、`npm run build`；内置识别包用 `npx vite build --config vite.embed.config.ts` 生成，并随源码更新。编辑器测试见 `web/README.md`。

自动化与合成输入检查不代替物理摄像头验收；手型准确率、左右方向和长时间性能仍需真人体验。模型版本、资源校验值与许可见 [来源](sources.md)。
