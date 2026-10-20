# 物体重建（ViewForge）

更新：2026-10-20。ViewForge 只负责单独物体的照片管理、抠图、重建、补拍建议、模型预览和实测尺寸标定。房间展示、家具摆放、碰撞、承托、布局保存和手势操作统一由 RoomCanvas 编辑器负责。

照片到模型的逐步处理、算法、补拍闭环、尺寸计算及代码入口，见 [物体重建流程梳理](OBJECT_RECONSTRUCTION_PIPELINE.md)。

## 使用入口

在仓库根目录运行 `python3 web/scripts/serve.py`，打开 <http://127.0.0.1:7880/web/>，选择房间。

- 仓库 → **添加物体**：上传 3–40 张照片 → 抠图确认 → 重建 → 输入一条实测边长 → 放进房间。
- **导入物体**：读取已有重建和标定，按真实尺寸摆放。导入物体暂不随布局保存。
- 编辑器的**手势**开关直接开启本机识别，不需要物体重建服务；只有添加、导入物体需要连接 ViewForge。
- ViewForge 首页（经隧道为 <http://127.0.0.1:7865/>）保留独立物体重建、历史结果、补拍、GLB / Gaussian 预览和尺寸标定。它不再提供房间布局页。

## 启动物体后端

按 `object-reconstruction/configs/local.env.example` 配置被 Git 忽略的 `local.env`，填运行目录、授权 GPU 和共享 GPU 锁，然后执行：

```bash
cd object-reconstruction
source configs/local.env
source scripts/env.sh
python scripts/web.py --host <后端监听地址> --port 7862
```

本机经 SSH 隧道访问：

```bash
ssh -N -L 127.0.0.1:7865:<后端监听地址>:7862 <SSH主机别名>
```

`serve.py --viewforge <地址>` 可修改后端地址。两个重建模块继续使用各自的 Python 环境。环境、权重、照片和历史结果保留在 `VIEWFORGE_ROOT` 指向的外部目录，不进 Git；不再需要旧房间资产或 `VIEWFORGE_ROOMS_ROOT`。

## 接口

接口挂在 `scripts/web.py` 启动的同一个服务上。

| 接口 | 用途 |
| --- | --- |
| `POST /viewforge/objects/create` | 命名并上传 3–40 张 JPEG/PNG，保存原图和转正副本 |
| `POST /viewforge/objects/masks` | BiRefNet 抠图，返回任务号 |
| `POST /viewforge/objects/reconstruct` | 校验照片、蒙版与预览一致，再运行 DA3 + MV-SAM3D + COVER |
| `GET /viewforge/objects/jobs/<任务号>` | 查询排队、阶段、完成结果或错误 |
| `GET /viewforge/objects/previews/<批次>/<照片>.png` | 蒙版预览 |
| `GET /viewforge/assets/catalog` | 已重建物体目录（`runs`） |
| `GET /viewforge/assets/<结果>` | 完整模型尺寸基准、显示变换和已保存标定 |
| `GET /viewforge/assets/<结果>/result.glb`、`preview.glb` | 完整模型、可选轻量模型 |
| `GET /viewforge/dimensions/<结果>` | 读取标定 |
| `POST /viewforge/dimensions/<结果>` | 保存或清除单轴实测标定，支持 mm/cm/m |
| `GET /viewforge/dimensions/<结果>/model.glb` | 导出米制模型 |

物体接口实现分别在 `objects.py`、`assets.py`、`dimensions.py`。旧 `/viewforge/layouts/catalog` 和 `/viewforge/layouts/assets/<结果>[/result.glb|preview.glb]` 仅兼容物体读取；旧房间读取、布局页、validate、save 和布局快照读取接口已移除。前端优先读取新资产接口；旧后端或本机代理返回 404 时，兼容旧物体读取路径，目录、尺寸和模型使用同一套地址。仓库的“添加物体”始终显示，连接失败会提示重试。

标定从完整原始模型计算，不修改原模型。用户标定坐标 X / Y / Z 分别对应内部 +X / -Z / +Y；RoomCanvas 应用显示变换、底部居中及米制缩放。已有标定、重建结果和照片均可继续使用。

GPU 仍使用 `VIEWFORGE_GPU_LOCK` 排队，一次使用配置的一张卡。任务记录在服务内存里，服务重启后任务号失效；落盘结果仍可从物体目录读取。补拍续建目前仍在物体重建首页操作。

## 手势与场景

识别在 `gesture/`，内置入口在 `web/editor/gesture-camera.mjs`。可选的独立识别页为 `gesture/roomcanvas.html`（Vite 8800），默认嵌入 7880 的 RoomCanvas 编辑器，协议为 `roomcanvas-gesture-v1`；不依赖 ViewForge 后端。用法见 [RoomCanvas 手势接入](../gesture/docs/roomcanvas-integration.md)。

## 来源和迁移

源码来源为 ViewForge `a93d457` 和手势工程 `32082a3`，最终经 PR #5 squash 合入 RoomCanvas。来源、许可证与历史记录保留，见 [历史说明](../object-reconstruction/docs/HISTORY_INTEGRATION.md)。2026-10-18 的部署验证记录属于旧布局版本；2026-10-20 起以本文职责和接口为准。升级需同步后端源码及构建产物并重启物体服务；本地修改不会自动更新服务器。
