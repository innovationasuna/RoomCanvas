# RoomCanvas

用手机（LiDAR + RoomPlan）扫描房间，重建成真实尺寸、带纹理的三维房间，然后在网页上查看、移动家具。

| 目录 | 内容 |
|---|---|
| [`reconstruction/`](reconstruction/) | 房间重建：[LiteReality-Agent](https://github.com/LiteReality/LiteReality-Agent) 官方代码，所有 Agent 改用 Codex（GPT-6 Astra）。产出 `Room.glb` 和 `room_layout.json` |
| [`web/`](web/) | 网页：在房间里选中家具，移动、旋转、换墙、收进仓库，带碰撞和支撑检测，可撤销、可保存 |
| [`samples/`](samples/) | 两个示例房间：`room3`（卧室扫描）、`office`（LiteReality 官方样例） |
| [`object-reconstruction/`](object-reconstruction/) | ViewForge：多视角物体重建、尺寸标定、Babylon 房间布局及手势接收端 |
| [`gesture/`](gesture/) | 浏览器摄像头、MediaPipe 手势识别和 ViewForge 接入页；保留原独立演示 |

ViewForge 与手势源码已连同完整提交历史导入。本次统一代码目录，保留原有各模块的使用方式；房间与物体重建环境、模型权重和运行数据分别配置。目录、历史及启动说明见 [ViewForge 整合说明](docs/VIEWFORGE_INTEGRATION.md)。

## 打开网页

```bash
python3 -m http.server 7870 --bind 127.0.0.1    # 在仓库根目录
```

浏览器打开 <http://127.0.0.1:7870/web/>，选一个示例房间。不需要安装任何东西。开发和测试见 [web/README.md](web/README.md)。

## 重建一个房间（3090 服务器）

```bash
PY=/workspace/geyinuo/RoomCanvas/runtime/litereality-env/bin/python
$PY reconstruction/server/run_room.py <扫描输入> <新的运行目录> --check   # 只检查配置，不占卡
$PY reconstruction/server/run_room.py <扫描输入> <新的运行目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

`run_room.py` 自动挑一张空闲 GPU 并加锁，确认加载的是本仓库的代码，把配置记进运行目录（不记密钥）。运行环境、模型权重和 `.env` 在服务器的 `ROOMCANVAS_HOME`（默认 `/workspace/geyinuo/RoomCanvas`）。重建完成后，把 `room_preview/` 里的房间接到网页上：

```bash
python3 web/scripts/room_objects.py <room_preview 目录>   # 生成网页用的物体清单 room_objects.json
```

## 物体重建与手势

ViewForge 手势入口在本机运行：在本仓库根目录执行 `sh scripts/gesture.sh install`、`sh scripts/gesture.sh dev`，打开 <http://127.0.0.1:8800/viewforge.html>，保持 ViewForge 的 SSH 隧道可用。该页面的手势识别和 Babylon 场景渲染仍在浏览器内执行；服务器提供模型、进行物体重建、碰撞校验和保存。RoomCanvas 原编辑器仍按上文方式打开。

## 对 LiteReality-Agent 改了什么

基线是官方 `28ffe1f4`（2026-10-03），即本仓库的第一个提交，原样放在 `reconstruction/`。之后的改动：

- **所有 Agent 改用 Codex。** 默认 provider 从 claude 改为 codex（`models.env`、`settings.py`、`agent/providers/base.py`）。Codex 会话支持附图（`providers/codex.py`）；新增 `agent/providers/vision.py`，在建模路线分类、椅子分组、程序化完整性检查、布局 Agent 四处看图。provider 设回 claude 时，仍走官方原来的代码。
- **3090 运行脚本**：新增 `reconstruction/server/`，不改官方文件。
- **CI**：`.github/workflows/ci.yml` 先用 gitleaks 扫描全部历史里的密钥，再跑官方测试和网页测试。

逐行改动看提交 2。

## 示例房间和隐私

**仓库是私有的。`samples/room3` 是私人卧室**：`Room.glb` 里有从实拍照片得来的贴图。只在这个仓库里给协作者用，不要转发；仓库如果要公开，必须先从历史里删掉它。原始扫描、照片、含相机轨迹的 `room_layout.json` 都不进仓库。

`office` 是 LiteReality 官方 office_room 扫描的重建结果。两个房间的 `room_objects.json` 可以用 `web/scripts/room_objects.py` 从服务器上的 `room_layout.json` 重新生成，手写的家具名会保留。

## 许可

[Apache License 2.0](LICENSE)，署名见 [NOTICE](NOTICE)。用到 LiteReality-Agent 的研究请引用 [reconstruction/citation.bib](reconstruction/citation.bib)。Three.js（`web/vendor/`）为 MIT 许可。

导入的 ViewForge/MV-SAM3D 及其依赖保留各自许可，见 [`object-reconstruction/LICENSE`](object-reconstruction/LICENSE)；手势工程的代码、模型和依赖许可见 [`gesture/README.md`](gesture/README.md) 与 [`gesture/docs/sources.md`](gesture/docs/sources.md)，不由根目录的 Apache 许可重新授权。
