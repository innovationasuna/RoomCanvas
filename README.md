# RoomCanvas

用手机（LiDAR + RoomPlan）扫描房间，重建成真实尺寸、带纹理的三维房间，然后在网页上查看、移动家具。

| 目录 | 内容 |
|---|---|
| [`reconstruction/`](reconstruction/) | 房间重建：[LiteReality-Agent](https://github.com/LiteReality/LiteReality-Agent) 官方代码，所有 Agent 改用 Codex（GPT-6 Astra）。产出 `Room.glb` 和 `room_layout.json` |
| [`web/`](web/) | 网页：在房间里选中家具，移动、旋转、换墙、收进仓库，带碰撞和支撑检测，可撤销、可保存 |
| [`samples/`](samples/) | 两个示例房间：`room3`（卧室扫描）、`office`（LiteReality 官方样例） |
| [`object-reconstruction/`](object-reconstruction/) | ViewForge：多视角物体重建、尺寸标定、Babylon 房间布局及手势接收端 |
| [`gesture/`](gesture/) | 浏览器摄像头、MediaPipe 手势识别和 ViewForge 接入页；保留原独立演示 |

ViewForge 与手势源码已整合到本仓库，主线通过 squash 提交记录整合结果。各模块保留原有功能；房间与物体重建环境、模型权重和运行数据分别配置。目录、历史及启动说明见 [ViewForge 整合说明](docs/VIEWFORGE_INTEGRATION.md)。

## 打开网页

```bash
python3 web/scripts/serve.py --port 7870    # 在仓库根目录
```

浏览器打开 <http://127.0.0.1:7870/web/>，选一个示例房间。不需要安装任何东西。开发和测试见 [web/README.md](web/README.md)。

用摄像头手势布置房间：手势页（`gesture/`）嵌入这个编辑器，左手 1/2/3 切移动/旋转/观察，右手捏合抓取。编辑器里“导入物体”可把 ViewForge 重建的物体按实测尺寸放进房间（需要到 ViewForge 服务器的 SSH 隧道，`serve.py` 把读请求转过去）。

```bash
sh scripts/gesture.sh install && sh scripts/gesture.sh dev    # 手势页，端口 8800
```

Chrome 打开 <http://127.0.0.1:8800/viewforge.html?layout=http%3A%2F%2F127.0.0.1%3A7870%2Fweb%2Feditor%2F%3Fscene%3D..%2F..%2Fsamples%2Froom3>（`layout=` 后面是编辑器地址，换房间改 `scene`）。

## 重建一个房间（3090 服务器）

```bash
PY=/workspace/geyinuo/RoomCanvas/runtime/litereality-env/bin/python
$PY reconstruction/server/run_room.py <扫描输入> <新的运行目录> --check   # 只检查配置，不占卡
$PY reconstruction/server/run_room.py <扫描输入> <新的运行目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

`run_room.py` 自动挑一张空闲 GPU 并加锁；author 视觉验收后的返工默认只做 1 轮（官方默认 2 轮，`--repair-rounds 0` 只验收不返工）；确认加载的是本仓库的代码，把配置记进运行目录（不记密钥）。运行环境、模型权重和 `.env` 在服务器的 `ROOMCANVAS_HOME`（默认 `/workspace/geyinuo/RoomCanvas`）。重建完成后，把 `room_preview/` 里的房间接到网页上：

```bash
python3 web/scripts/room_objects.py <room_preview 目录>   # 生成网页用的物体清单 room_objects.json
```

### 小物件：舍弃、程序化或 TRELLIS（author 之后的一步）

author 阶段的小物件（书、拖鞋、袋子、枕头……）都是 Blender 基本形状拼的。这一步读 author 产出的 `Room.blend`，不重跑 author：

```bash
$PY reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录> --check
$PY reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录>
```

1. 挑候选：author 加的、能拿起来挪动的东西；不含房间结构、门窗、重建出来的家具、插座开关灯等固定设施、挂在墙上或天花板上的东西、能放东西的家具。没有尺寸阈值。叠在一起的（一摞书）合成一件。
2. 找照片：按相机投影挑能看到它的帧，Grounding DINO 在投影附近确认，优先清晰的，裁图转正；再从同一相机渲染当前模型，和照片并排。
3. Astra 逐件三选一（每件只问一次）：**舍弃**（太小、看不清、不重要，或怎么建都不会像）、**程序化**（当前模型已经像，保留）、**TRELLIS**（软的、有褶皱的、形状复杂且照片清楚的）。实验里观察到的规律作为参考写进提示词，不是硬规则。
4. TRELLIS 的：证据图 → gpt-image-2 参考图 → TRELLIS → 去掉碎片，按原物件的位置、高度和朝向（俯视最小外接矩形）放回原处，基本保持新模型自身比例，正面朝向拍得最清楚的相机。某件 TRELLIS 显存不够时单独隔离、改用 512 分辨率再试；仍失败的保留原模型，重跑同一命令会补做。生成后修正材质：布、纸、塑料等的金属度归零（TRELLIS 会给布包猜出 0.4 的金属度）；单一主色的物件，如果贴图色相和参考图差 8° 以上，就整体转回去（TRELLIS 曾把品红色的包固定生成成正红，换种子也一样）。多种颜色的东西（一摞书）不转。
5. 同一相机渲染“照片 | 原模型 | 重建”三联图放进 `overview.jpg`，供人检查；不再让 Astra 二次检查。

结果在 `<新目录>/room_preview/`（`Room.blend`、`Room.glb`、`room_layout.json`，重建的物件标 `"rebuilt": "trellis"`），每件的照片、渲染对比、Astra 的回答和费用在 `items.json`、`summary.md`、`overview.jpg`。中断后重跑同一命令会接着做。重建的物件在网页里单独可移动，放在家具上的会随家具移动。

## 物体重建与手势

ViewForge 后端和手势前端都从本仓库启动。服务器在 `object-reconstruction/configs/local.env` 配好外部运行目录和授权 GPU 后，运行：

```bash
cd object-reconstruction
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 127.0.0.1 --port 7862
```

本机打开两个终端。第一个用 SSH 端口转发访问后端，将 `<SSH主机别名>` 换成自己的配置；转发目标须与后端实际监听地址一致（已有可用隧道时跳过）：

```bash
ssh -N -L 127.0.0.1:7865:127.0.0.1:7862 <SSH主机别名>
```

另一个终端在仓库根目录启动手势页：

```bash
sh scripts/gesture.sh install  # 首次安装或锁文件更新后执行
sh scripts/gesture.sh dev
```

使用 ViewForge 原布局时，打开 <http://127.0.0.1:8800/viewforge.html>，点击“开启摄像头”并授权。手势识别和 Babylon 场景渲染在本机浏览器执行；服务器提供模型、执行物体重建、碰撞校验和保存。后端首页为 <http://127.0.0.1:7865/>，布局入口为 <http://127.0.0.1:7865/viewforge/layouts/viewer>。环境、资源和端口配置见 [运行说明](docs/VIEWFORGE_INTEGRATION.md)。RoomCanvas 编辑器及 room3 的手势入口见上文“打开网页”；该编辑器在本机浏览器中检查碰撞和支撑，导入 ViewForge 物体时才需连接服务器。

## 对 LiteReality-Agent 改了什么

基线是官方 `28ffe1f4`（2026-10-03），即本仓库的第一个提交，原样放在 `reconstruction/`。之后的改动：

- **所有 Agent 改用 Codex。** 默认 provider 从 claude 改为 codex（`models.env`、`settings.py`、`agent/providers/base.py`）。Codex 会话支持附图（`providers/codex.py`）；新增 `agent/providers/vision.py`，在建模路线分类、椅子分组、程序化完整性检查、布局 Agent 四处看图。provider 设回 claude 时，仍走官方原来的代码。
- **3090 运行脚本**：新增 `reconstruction/server/`，不改官方文件。
- **小物件这一步**：新增 `pipeline/realism_authoring/small_objects/`（只加新文件，复用官方的证据图、参考图、TRELLIS 启动器和看图问答），不改官方文件。
- **CI**：`.github/workflows/ci.yml` 先用 gitleaks 扫描全部历史里的密钥，再跑官方测试和网页测试。

逐行改动看提交 2。

## 示例房间和隐私

**仓库是私有的。`samples/room3` 是私人卧室**：`Room.glb` 里有从实拍照片得来的贴图。只在这个仓库里给协作者用，不要转发；仓库如果要公开，必须先从历史里删掉它。原始扫描、照片、含相机轨迹的 `room_layout.json` 都不进仓库。

`office` 是 LiteReality 官方 office_room 扫描的重建结果。两个房间的 `room_objects.json` 可以用 `web/scripts/room_objects.py` 从服务器上的 `room_layout.json` 重新生成，手写的家具名会保留。

## 许可

[Apache License 2.0](LICENSE)，署名见 [NOTICE](NOTICE)。用到 LiteReality-Agent 的研究请引用 [reconstruction/citation.bib](reconstruction/citation.bib)。Three.js（`web/vendor/`）为 MIT 许可。

导入的 ViewForge/MV-SAM3D 及其依赖保留各自许可，见 [`object-reconstruction/LICENSE`](object-reconstruction/LICENSE)；手势工程的代码、模型和依赖许可见 [`gesture/README.md`](gesture/README.md) 与 [`gesture/docs/sources.md`](gesture/docs/sources.md)，不由根目录的 Apache 许可重新授权。
