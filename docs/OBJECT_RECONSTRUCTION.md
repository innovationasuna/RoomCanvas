# 物体重建（ViewForge）

`object-reconstruction/` 是 RoomCanvas 的物体重建服务：把几张照片重建成带纹理的三维模型，并按一条实测边长标定到真实尺寸。它是无界面的 API 服务（Starlette / Uvicorn），前端是网页编辑器里的“添加物品”和“导入物品”。

```text
照片 → BiRefNet 抠图 → DA3 深度 + MV-SAM3D 多视角重建 → COVER 补拍建议 → 实测尺寸标定 → 放进房间
```

## 在编辑器中使用

在仓库根目录运行 `python3 web/scripts/serve.py`，打开 <http://127.0.0.1:7880/web/>，选择房间。

- **添加物品**（仓库里的第一张卡片）：上传 1–40 张照片 → 确认抠图 → 重建 → 输入一条实测边长 → 放进房间。结果页显示补拍建议（橙色箭头），可以“补拍”：添加照片，在原结果基础上重建。
- **导入物品**：读取已有的重建结果和标定，按真实尺寸摆放；选中已有结果也可以补拍。

编辑器的“手势”在本机运行，不需要物体重建服务。界面操作的细节见 [网页编辑器](../web/README.md#物品导入与添加)。

## 部署

服务运行在有 GPU 的 Linux 服务器上。按 `object-reconstruction/configs/local.env.example` 创建 `configs/local.env`（不进仓库），填写数据根目录 `VIEWFORGE_ROOT`、授权使用的 GPU 和共享 GPU 锁，然后启动：

```bash
cd object-reconstruction
source configs/local.env
source scripts/env.sh
python -m pip install -r configs/api-requirements.txt   # 首次安装 API 依赖
python scripts/web.py --host <监听地址> --port 7862
```

本机通过 SSH 隧道连接，`serve.py` 默认把请求转发到 `127.0.0.1:7865`（可用 `--viewforge <地址>` 修改）：

```bash
ssh -N -L 127.0.0.1:7865:<监听地址>:7862 <SSH 主机>
```

`GET /health` 用于检查服务状态。重建环境、BiRefNet 环境、权重的安装和命令行用法见 [运行说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md)。

### 数据目录

源码在仓库中，运行环境、权重、照片和结果都在 `VIEWFORGE_ROOT` 指向的外部目录：

```text
$VIEWFORGE_ROOT/
├── data/inputs/     原始照片、蒙版与导入记录
├── weights/         BiRefNet、SAM3D、DA3 和 DINO 权重
├── envs/            独立的 Python 环境（mvsam3d、birefnet）
├── third_party/     固定版本的外部依赖源码
├── runs/            重建结果
├── logs/
└── cache/
```

`scripts/env.sh` 按自身位置选择当前 checkout 的源码，环境、权重和数据从 `VIEWFORGE_ROOT` 读取。

## 接口

入口是 `scripts/web.py`，物体相关接口分别实现于 `scripts/objects.py`、`assets.py`、`dimensions.py`。

| 接口 | 用途 |
| --- | --- |
| `POST /viewforge/objects/create` | 命名并上传 1–40 张 JPEG / PNG，保存原图和转正后的副本 |
| `POST /viewforge/objects/capture` | 补拍：表单 `run`（已完成的结果）+ 新照片，存入该结果对应的物体并记录父结果，返回原照片 `kept` 和全部 `images` |
| `POST /viewforge/objects/masks` | BiRefNet 抠图，返回任务号 |
| `POST /viewforge/objects/reconstruct` | 校验照片、蒙版与预览一致后运行 DA3 + MV-SAM3D + COVER；带 `parent` 时在原结果基础上重建 |
| `GET /viewforge/objects/jobs/<任务号>` | 查询排队、阶段、结果或错误 |
| `GET /viewforge/objects/previews/<批次>/<照片>.png` | 蒙版预览 |
| `GET /viewforge/assets/catalog` | 已重建物体的目录 |
| `GET /viewforge/assets/<结果>` | 尺寸基准、显示变换和已保存的标定 |
| `GET /viewforge/assets/<结果>/result.glb`、`preview.glb` | 完整模型、轻量模型 |
| `GET /viewforge/assets/<结果>/result.ply`、`preview.json` | 原始 Gaussian、补拍建议 |
| `GET /viewforge/dimensions/<结果>` | 读取标定 |
| `POST /viewforge/dimensions/<结果>` | 保存或清除单轴实测标定，支持 mm / cm / m |
| `GET /viewforge/dimensions/<结果>/model.glb` | 导出米制模型 |

`/viewforge/layouts/catalog` 和 `/viewforge/layouts/assets/<结果>[/result.glb|preview.glb]` 作为兼容地址保留，只用于读取物体；编辑器优先使用 `/viewforge/assets/`，遇到 404 时回退到兼容地址。接口只返回受限的资产地址，不暴露服务器上的任意文件路径。

### 标定与坐标

标定基于完整的原始模型计算，不修改模型本身。用户看到的 X / Y / Z（宽、深、高）分别对应模型内部的 +X / −Z / +Y；编辑器负责应用显示变换、底部居中和米制缩放。

### 任务与 GPU

抠图和重建通过 `VIEWFORGE_GPU_LOCK` 排队，一次使用配置中的一张卡；已有抠图的照片直接复用，不需要等待 GPU。任务状态保存在服务内存中，服务重启后任务号失效，但已完成的结果仍可从物体目录读取。

### 补拍

补拍走 `capture` + `reconstruct`（带 `parent`）：新照片按上传顺序命名为 `capture_<时间>_001…`，原照片的抠图直接复用，只给新照片运行 BiRefNet，重建生成一个新结果，原结果不变。补拍方向由 COVER 计算，算法和命令行见 [COVER 补拍引导](../object-reconstruction/docs/COVER.md)。命令行也可以用 `scripts/run.py --parent-run <结果>` 和 `scripts/import_photos.py` 完成同样的流程。

## 引用

多视角重建基于 [MV-SAM3D](https://arxiv.org/abs/2603.11633)，抠图使用 BiRefNet，补拍方向使用 COVER 指标，完整引用见 [README](../README.md#引用与致谢) 和 [`object-reconstruction/README.md`](../object-reconstruction/README.md#引用)。
