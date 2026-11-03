# 运行说明

本文说明物体重建模块的环境安装、命令行重建和自动抠图。API 服务的部署与接口见 [物体重建](../../docs/OBJECT_RECONSTRUCTION.md)。以下操作都在 Linux GPU 服务器的 Bash 中完成，本机编辑器不需要这些环境。

## 服务器配置

先按 [首次部署](../../docs/OBJECT_RECONSTRUCTION.md#首次部署) 运行安装入口。脚本从 [`configs/local.env.example`](../configs/local.env.example) 生成缺失的 `configs/local.env`（不进仓库）；编辑以下变量，已有配置保留。每次运行服务或重建前都要显式加载。

| 变量 | 含义 |
| --- | --- |
| `VIEWFORGE_ROOT` | 外部数据根目录的绝对路径，需可写，存放环境、权重、照片和结果 |
| `CUDA_VISIBLE_DEVICES` | 授权使用的一张 GPU |
| `VIEWFORGE_GPU_LOCK` | 共享 GPU 锁文件的绝对路径，父目录需可写；所有使用这张卡的应用应指向同一路径 |
| `TORCH_CUDA_ARCH_LIST` | CUDA 架构，如 RTX 30 系列为 `8.6` |
| `TZ` | 时区；没有 tzdata 的容器可用 `CST-8` 表示 UTC+8 |

## 安装

统一入口是 [`scripts/setup.sh`](../scripts/setup.sh)。准备条件见 [首次部署](../../docs/OBJECT_RECONSTRUCTION.md#首次部署)；**服务器上**，在 `RoomCanvas/object-reconstruction/` 执行：

```bash
# 无 local.env 时可先 export VIEWFORGE_ROOT='<外部运行目录的绝对路径>'
export HF_TOKEN='<已获 SAM 3D 访问权限的 Hugging Face 令牌>'   # 或 export MODEL_SOURCE=modelscope
bash scripts/setup.sh --dry-run
bash scripts/setup.sh
```

已有 `configs/local.env` 时读取其中的 `VIEWFORGE_ROOT`；终端也设置了不同值时停止，并给出使用配置目录的确切重跑命令。默认目录为 `$ROOMCANVAS_HOME/runtime/object-reconstruction`，`ROOMCANVAS_HOME` 默认是仓库根目录。其他 GPU、锁和编译变量需显式 export，不会随根目录一起导入。

脚本完成这些步骤，路径均相对 `$VIEWFORGE_ROOT`：

| 步骤 | 配方与产物 |
| --- | --- |
| 重建环境 | `envs/mvsam3d/`；[`default.yml`](../environments/default.yml) 提供 Python 3.11 / CUDA 12.1，脚本安装 torch 2.5.1 + cu121、[`requirements.txt`](../requirements.txt) 与 `p3d/inference/dev` extras，含 API 依赖 |
| Kaolin | [`requirements.inference.txt`](../requirements.inference.txt) 固定 0.17.0，安装时通过 `-f` 使用 torch 2.5.1 / cu121 wheel 页面 |
| 外部源码 | `third_party/depth-anything-3/`、`dinov2/`、`utils3d/`；DA3 与 utils3d 按 [`upstream_versions.json`](../configs/upstream_versions.json) 固定版本，DINOv2 pin 在安装脚本中 |
| 重建权重 | `weights/sam3d/` 校验 pipeline 引用的配置与 checkpoint（`MODEL_SOURCE=modelscope` 时 SAM 3D 与 DA3 从 ModelScope 下载）；`weights/da3-nested-giant-large/` 校验配置和模型权重；`weights/dinov2/hub/checkpoints/` 校验可读取的 state dict |
| BiRefNet | `envs/birefnet/` 与 `weights/birefnet/` 分别安装、验证，沿用 [`setup_birefnet.sh`](../scripts/setup_birefnet.sh) 的依赖和固定版本配方 |

每步开始前写 `.roomcanvas-setup-incomplete`，验证通过后改为 `.roomcanvas-setup-complete`。重跑同一入口即可恢复未完成步骤、跳过已完成步骤；无标记的已有目录只验证，失败时停止，不自动修补或覆盖。BiRefNet 环境和权重分别判断，一方已有不影响另一方安装。下载先写同目录临时文件，完成后才改名。

局部失败直接重跑 `bash scripts/setup.sh`；只更新 API 依赖的命令见 [更新与重启](../../docs/OBJECT_RECONSTRUCTION.md#更新与重启)。完整环境的依赖或模型需要升级时，先核对脚本配方，在新的 `VIEWFORGE_ROOT` 安装，并同步修改 `local.env`；完成标记不会自动触发升级。不要直接调用旧的 BiRefNet 安装器覆盖已有目录。

实测情况：2026-11-03 在 RTX 3090 服务器上对已有环境运行（经 `scripts/setup_server.sh all`），已有源码、两个 Conda 环境和权重按只检查全部通过；该机的外部源码是不含 `.git` 的快照，版本无法核对，脚本只给警告。`flash_attn` 只在 A100、H100、H200 上使用，其他显卡上检查 `xformers`。全新安装（Conda 环境、CUDA 编译、权重下载）尚未实测；安装脚本不运行 GPU 推理。

## 命令行重建

**服务器上**，在 `RoomCanvas/object-reconstruction/` 执行；先将下方约定的照片和蒙版放入 `stuffed_toy` 输入目录，或用自己的物体名替换：

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

BiRefNet 已包含在上面的统一安装入口中，无需另装。

模型版本固定在 `configs/birefnet.json`。环境为 `$VIEWFORGE_ROOT/envs/birefnet`，官方代码与权重在 `$VIEWFORGE_ROOT/weights/birefnet`，推理只从本地加载。服务器无法访问 Hugging Face 时，可在联网机器下载对应 revision 的完整 snapshot 后复制到该目录。

单独准备蒙版，**服务器上**，在 `RoomCanvas/object-reconstruction/` 执行（先准备对应物体的照片）：

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

**服务器上**，在 `RoomCanvas/object-reconstruction/`、完成环境和依赖安装后执行：

```bash
source configs/local.env
source scripts/env.sh
python -m unittest discover -s tests -v
```
