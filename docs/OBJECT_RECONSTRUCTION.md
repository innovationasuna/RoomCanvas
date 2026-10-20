# 物体重建（ViewForge）

更新：2026-10-20。RoomCanvas 是唯一正式界面，负责照片重建流程、模型与坐标轴预览、实测尺寸输入、房间摆放和手势。`object-reconstruction/` 提供无界面的物体重建 API，保留 BiRefNet、DA3 / MV-SAM3D、COVER 及尺寸计算。

## 使用入口

按 [快速开始](../README.md#快速开始) 启动 7870 编辑器与 8800 网站，打开 [RoomCanvas](http://127.0.0.1:8800/RoomCanvas.html)，从“我的房间”进入工作台。只使用独立编辑器时，可直接打开 [办公室编辑器](http://127.0.0.1:7870/web/editor/?room=office)。

- 工作台底栏“添加素材” → **添加物体**：上传 3–40 张照片 → 抠图确认 → 重建 → 输入一条实测边长 → 放进房间。独立编辑器中入口位于仓库。
- **导入物体**：读取已有重建和标定，按真实尺寸摆放。导入物体暂不随布局保存。
- 完整工作台左栏的“开启摄像头”和独立编辑器的“手势”开关均使用本机识别，不需要物体重建服务；只有添加、导入物体需要连接 ViewForge。
- 原 ViewForge 的 Gradio 页面、Babylon 查看器、房间布局和手势接入页已弃用，代码与原有构建资源保留在 [`legacy/`](../object-reconstruction/legacy/README.md)。正式服务不挂载这些界面，7865 隧道只访问 API；`GET /health` 可检查服务。

## 启动物体后端

按 `object-reconstruction/configs/local.env.example` 配置被 Git 忽略的 `local.env`，填运行目录、授权 GPU 和共享 GPU 锁，然后执行：

```bash
cd object-reconstruction
source configs/local.env
source scripts/env.sh
python -m pip install -r configs/api-requirements.txt  # 首次安装纯 API 依赖
python scripts/web.py --host <后端监听地址> --port 7862
```

本机经 SSH 隧道访问：

```bash
ssh -N -L 127.0.0.1:7865:<后端监听地址>:7862 <SSH主机别名>
```

`serve.py --viewforge <地址>` 可修改后端地址。两个重建模块继续使用各自的 Python 环境。环境、权重、照片和历史结果保留在 `VIEWFORGE_ROOT` 指向的外部目录，不进 Git；不再需要旧房间资产或 `VIEWFORGE_ROOMS_ROOT`。

## 接口

入口仍为 `scripts/web.py`，现通过 Starlette / Uvicorn 直接启动，不导入 Gradio、归档 UI 或旧查看器。已有监听地址、SSH 隧道、数据目录和 GPU 锁继续使用。

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
| `GET /viewforge/assets/<结果>/result.ply`、`preview.json` | 原始 Gaussian 与补拍元数据（保留结果能力） |
| `GET /viewforge/dimensions/<结果>` | 读取标定 |
| `POST /viewforge/dimensions/<结果>` | 保存或清除单轴实测标定，支持 mm/cm/m |
| `GET /viewforge/dimensions/<结果>/model.glb` | 导出米制模型 |

物体接口实现分别在 `objects.py`、`assets.py`、`dimensions.py`。旧 `/viewforge/layouts/catalog` 和 `/viewforge/layouts/assets/<结果>[/result.glb|preview.glb]` 仅兼容物体读取；旧房间读取、布局页、validate、save 和布局快照读取接口已移除。前端优先读取新资产接口；旧后端或本机代理返回 404 时，兼容旧物体读取路径，目录、尺寸和模型使用同一套地址。仓库的“添加物体”始终显示，连接失败会提示重试。

标定从完整原始模型计算，不修改原模型。用户标定坐标 X / Y / Z 分别对应内部 +X / -Z / +Y；RoomCanvas 应用显示变换、底部居中及米制缩放。已有标定、重建结果和照片均可继续使用。历史补拍 manifest 的旧界面 URL 在 API 返回时适配为受限资产 URL，不改写历史文件；不会暴露任意服务器文件路径。

GPU 仍使用 `VIEWFORGE_GPU_LOCK` 排队，一次使用配置的一张卡。任务记录在服务内存里，服务重启后任务号失效；落盘结果仍可从物体目录读取。COVER 和补拍续建算法、历史数据继续保留；补拍可通过 `scripts/run.py --parent-run <结果>` 及 `scripts/import_photos.py` 使用。RoomCanvas 暂未接入补拍续建界面，旧 Gradio 页面只作归档参考。

## 手势与场景

识别在 `gesture/`，完整网站入口为 `gesture/RoomCanvas.html`（Vite 8800），默认嵌入 7870 的 RoomCanvas 编辑器，协议为 `roomcanvas-gesture-v1`。导入房间的同源 iframe 和 `/viewforge/` 物体接口经 Vite 代理到编辑器服务；编辑器再按白名单转发到物体 API。直接打开编辑器时，`web/editor/gesture-camera.mjs` 提供内置摄像头入口。四种数字模式、双手缩放与竖拇指确认均在本机运行，不依赖 ViewForge 后端。用法见 [RoomCanvas 手势接入](../gesture/docs/roomcanvas-integration.md)。

## 来源和迁移

源码来源为 ViewForge `a93d457` 和手势工程 `32082a3`，最终经 PR #5 squash 合入 RoomCanvas。来源、许可证与历史记录保留，见 [历史说明](../object-reconstruction/docs/HISTORY_INTEGRATION.md)。2026-10-18 的部署验证记录属于旧布局版本；2026-10-20 起以本文职责和接口为准。升级需安装 API 依赖、同步正式后端源码并重启物体服务；不再需要构建或发布旧查看器。此次代码提交与推送不包含服务器部署。
