# 运行说明

本文说明物体重建模块的环境安装、命令行重建和自动抠图。API 服务的部署与接口见 [物体重建](../../docs/OBJECT_RECONSTRUCTION.md)。以下命令都在 `object-reconstruction/` 下执行。

## 本机配置

从 [`configs/local.env.example`](../configs/local.env.example) 复制出 `configs/local.env`（不进仓库），每次使用前显式加载：

| 变量 | 含义 |
| --- | --- |
| `VIEWFORGE_ROOT` | 外部数据根目录，存放环境、权重、照片和结果 |
| `CUDA_VISIBLE_DEVICES` | 授权使用的一张 GPU |
| `VIEWFORGE_GPU_LOCK` | 共享 GPU 锁文件，所有使用这张卡的应用应指向同一路径 |
| `TORCH_CUDA_ARCH_LIST` | CUDA 架构，如 RTX 30 系列为 `8.6` |
| `TZ` | 时区；没有 tzdata 的容器可用 `CST-8` 表示 UTC+8 |

## 安装

1. 在 Linux GPU 服务器上，用 Conda 按 [`environments/default.yml`](../environments/default.yml) 创建环境，安装位置指定为 `$VIEWFORGE_ROOT/envs/mvsam3d`。该文件固定了 Python、CUDA 工具链和系统库；先完成上面的本机配置，再加载环境：

   ```bash
   source configs/local.env
   source scripts/env.sh
   ```

2. 在重建环境中安装 [`requirements.txt`](../requirements.txt)、[`requirements.p3d.txt`](../requirements.p3d.txt) 和 [`requirements.inference.txt`](../requirements.inference.txt) 中的依赖；包索引与 `p3d` / `inference` 依赖分组见 [`pyproject.toml`](../pyproject.toml)。再安装 API 服务依赖 [`configs/api-requirements.txt`](../configs/api-requirements.txt)：

   ```bash
   python -m pip install -r configs/api-requirements.txt
   ```

3. 按运行脚本准备外部代码和权重：`third_party/depth-anything-3/` 放置 DA3 并安装其依赖，`third_party/dinov2/` 放置 DINOv2；`weights/sam3d/` 保存 `pipeline.yaml` 及其引用的配置和权重，`weights/da3-nested-giant-large/` 保存默认 DA3 权重。路径依据见 [`env.sh`](../scripts/env.sh)、[`run.py`](../scripts/run.py) 和 [`run_reconstruction.py`](../scripts/run_reconstruction.py)，DA3 模型名以 [`configs/default.yaml`](../configs/default.yaml) 为准。
4. 按下方[自动抠图](#自动抠图birefnet)步骤运行 [`scripts/setup_birefnet.sh`](../scripts/setup_birefnet.sh)，在独立环境安装 [`configs/birefnet-requirements.txt`](../configs/birefnet-requirements.txt) 并下载固定版本的模型。准备好照片和蒙版后，执行下一节的 `--check` 检查输入、权重路径与 GPU 配置。

## 命令行重建

```bash
source configs/local.env
bash scripts/launch.sh --object stuffed_toy --attempt a02 --check   # 只检查输入和配置
bash scripts/launch.sh --object stuffed_toy --attempt a02
```

- **输入**：`$VIEWFORGE_ROOT/data/inputs/<物体>/images/` 和相邻的 `masks/`。照片支持 `.png` / `.jpg`；蒙版命名为 `1.png` 或 `1_mask.png`，须唯一、与照片尺寸一致、RGBA 且 alpha 非空。`--images 1 3 5 7` 可只选部分照片（文件名不含扩展名）。允许单张照片。
- **配置**：默认 `configs/default.yaml`（seed 42、DA3 504、MV 50 / 25 步、entropy 融合），`--config <yaml>` 替换。`mv` 字段直接传给 `run_weighted_inference`，不支持的参数会直接报错。
- **输出**：每次新建 `runs/<日期>_<物体>_<attempt>/`，不覆盖已有目录；包含 `config.yaml`、`inputs.json`、`result.json`、`da3/`、`reconstruction/`（GLB 网格和 Gaussian PLY）和 `logs/`。
- **补拍**：`scripts/run.py --parent-run <结果>` 在已有结果基础上加入新照片重建；`scripts/import_photos.py` 把新照片导入物体目录。
- **GPU**：作业在 `VIEWFORGE_GPU_LOCK` 下运行，一次使用一张卡。

## 自动抠图（BiRefNet）

首次部署，在与重建环境隔离的独立环境中安装：

```bash
source configs/local.env
bash scripts/setup_birefnet.sh
```

模型版本固定在 `configs/birefnet.json`。环境为 `$VIEWFORGE_ROOT/envs/birefnet`，官方代码与权重在 `$VIEWFORGE_ROOT/weights/birefnet`，推理只从本地加载。服务器无法访问 Hugging Face 时，可在联网机器下载对应 revision 的完整 snapshot 后复制到该目录。

单独准备蒙版：

```bash
source configs/local.env
source scripts/env.sh
python scripts/prepare_masks.py --object stuffed_toy --images 1 3 5 7
```

- **推理**：逐张 1024×1024、FP16，输出的概率图恢复到原图尺寸后按 0.5 二值化。蒙版 `masks/<照片名>.png` 为原图尺寸的 RGBA，RGB 取自原图，alpha 只有 0 / 255，与 `notebook/inference.py::load_mask` 的前景判定兼容。不做 EXIF 旋转、裁剪或连通域筛选。
- **复用**：已有的有效蒙版原样复用，只为缺失的照片生成；全部已有时只做 CPU 检查，不加载模型、不占用 GPU。已有蒙版损坏、重复或尺寸不符时报错，不会覆盖原文件。
- **记录**：每次准备的记录和日志在 `$VIEWFORGE_ROOT/logs/masks/<任务>/`，预览缩略图在 `cache/mask_previews/<任务>/`。

命令行重建不会自动补蒙版，缺少蒙版时直接报错。

## 检查

```bash
source configs/local.env
source scripts/env.sh
python -m unittest discover -s tests -v
```
