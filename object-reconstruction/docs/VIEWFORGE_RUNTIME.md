# ViewForge 运行说明

RoomCanvas 整合说明：本模块现位于 `object-reconstruction/`，从该目录执行下面的相对启动命令；手势入口位于 RoomCanvas 的 `gesture/`。环境、权重和数据仍由 `VIEWFORGE_ROOT` 配置。下文的独立 `code/`、`upstream` 远程和旧部署路径属于原 ViewForge 运行记录，当前目录与历史保留方式以 [整合说明](../../docs/OBJECT_RECONSTRUCTION.md) 为准。

`code/` 是保留上游历史的 MV-SAM3D 仓库。`upstream` 指向原作者仓库，当前部署基于 `abb04b5`；尚未创建 GitHub 账号下的远程 fork。

```bash
source configs/local.env
bash scripts/launch.sh --object stuffed_toy --attempt a02 --check
bash scripts/launch.sh --object stuffed_toy --attempt a02
```

本机设置从 `configs/local.env.example` 复制并填写，必须显式加载，且不纳入 Git。`VIEWFORGE_ROOT` 指向外部存储根目录；环境为 `envs/mvsam3d`，`CUDA_VISIBLE_DEVICES` 指定获授权的一张 GPU。`VIEWFORGE_GPU_LOCK` 与其他使用该卡的应用共用。容器无 tzdata 时可用 `TZ=CST-8` 表示 UTC+8。

输入为 `data/inputs/<物体>/images/` 和相邻 `masks/`。支持 `.png`/`.jpg`；对应掩码如 `1.png` 或 `1_mask.png`，须唯一、尺寸一致、RGBA alpha 非空。允许单视角；其实际推理行为由上游处理。

`--config <yaml>` 替换默认配置。`mv` 字段直接传给上游 `run_weighted_inference`：50/25 步与 entropy 仅是默认值，不强制禁止其他融合选项。上游不支持的参数会直接报错，不静默忽略。

每次新建 `runs/<日期>_<物体>_<attempt>/`，拒绝覆盖；保留 `config.yaml`、`inputs.json`、`result.json`、`da3/`、`reconstruction/` 和 `logs/`。运行 DA3 与重建，输出 GLB 网格和 Gaussian PLY；查看结果可使用上游可视化工具。

常规重建不提供逐阶段性能基准、显存采样、日志文字融合验收及重复结果快照。历史测量结果和旧运行不受影响。

维护与检查：

```bash
source configs/local.env
source scripts/env.sh
python -m unittest discover -s tests -v
git diff upstream/main -- sam3d_objects run_inference.py run_inference_weighted.py
```

核心算法源码未修改。DA3 原生脚本仅增加外部路径适配；MV 本地入口仅生成本地权重配置并重定向输出目录。数据、权重、环境、缓存和运行结果均在 checkout 外。上游历史中的公开样例媒体保留，本机 sparse checkout 不展开 `data/`。

旧包装仓库及旧源码归档于 `logs/setup/upstream-repo-20260913/`；历史提交和实验记录不改写。

## 网页

在 code 目录执行：

```bash
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 172.18.0.2 --port 7862
```

当前容器地址为 `172.18.0.2`（重建容器后用 `hostname -I` 核对），网页监听该内网地址。通过容器 SSH 别名转发网页端口：

```bash
ssh -C -N -o IPQoS=none -o ServerAliveInterval=15 -L 127.0.0.1:7865:172.18.0.2:7862 3090x2-docker
```

本机访问 http://127.0.0.1:7865 。没有开启 Gradio 公网分享；关闭 SSH 连接会断开本机访问。默认 `--host` 仍为 `127.0.0.1`，可用于其他机器的回环部署。

从 `data/inputs/<物体>/images` 选择照片，先点“准备预览”，确认选区后再点“开始重建”；每次运行的 `input/` 只链接选中照片与掩码，DA3 和 MV 使用相同视角。CLI 也可用 `--images 1 3 5 7` 指定文件名（不含扩展名）。网页重建串行执行，完成后默认使用 `<model-viewer>` 查看 GLB 网格，支持拖动旋转和缩放；切换到 Gaussian 时才向上游同款 `gr.Model3D` 加载 PLY。两种模式均在本地浏览器渲染，重建仍在服务器执行。支持重新打开已有结果。网页只展示运行状态，不显示日志或模型下载入口；文件和日志仍保存在服务器运行目录中。查看器脚本随 `scripts/assets/` 本地提供。


## BiRefNet 自动 mask

首版只处理现有输入目录中的照片。即使还没有 `masks/`，物体及其照片也可选择和预览。网页“准备预览”检查所选照片：唯一有效的 mask 原样复用，缺失项由官方 `ZhengPeng7/BiRefNet` 补齐。画廊以缩小副本显示半透明绿色前景，确认后“开始重建”。改变物体或照片会撤销确认；正在准备的旧选择也不能恢复确认或启动重建。

首次部署（与重建环境完全隔离）：

```bash
source configs/local.env
bash scripts/setup_birefnet.sh
```

模型 revision 固定在 `configs/birefnet.json`，当前为 `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4`。环境为 `$VIEWFORGE_ROOT/envs/birefnet`；官方代码与权重在 `$VIEWFORGE_ROOT/weights/birefnet`，下载来源记录为其中的 `viewforge_revision.json`。正常推理只从本地加载，不访问模型服务。服务器不能访问 Hugging Face 时，可在联网机器下载此 revision 对应的 snapshot，并将完整文件和 revision 记录传到上述目录。

独立准备入口使用已有运行环境启动协调进程，按需调用独立 BiRefNet Python：

```bash
source configs/local.env
source scripts/env.sh
python scripts/prepare_masks.py --object stuffed_toy --images 1 3 5 7
# 审查选区之后，CLI 重建仍会严格检查所有 mask：
bash scripts/launch.sh --object stuffed_toy --images 1 3 5 7 --attempt a03
```

推理逐张执行：1024×1024、FP16、batch size 1、eval/no_grad、ImageNet mean/std，最后一级预测 sigmoid；float 概率图以 bicubic 恢复原图尺寸后按 >=0.5 二值化。输出 `masks/<照片名>.png` 为原图尺寸 RGBA，RGB 来自原图，alpha 仅为 0/255；不应用 EXIF 旋转、不裁剪、不选最大连通区域。二值 alpha 与上游 `notebook/inference.py::load_mask` 的 `alpha > 0` 前景判定兼容。

继续匹配 `<照片名>.png`、`<照片名>_mask.png`、`.jpg` 和 `_mask.jpg`。已有 mask 必须可读取、RGBA、同尺寸且 alpha 非空；多个匹配、坏文件、尺寸不符会报错，原文件不被覆盖。空预测或推理失败停止准备，成功写出的 mask 保留供下次复用。CLI 重建入口不会自动补 mask，避免绕过校验。

全部 mask 已存在时只做 CPU 检查和预览，既不加载模型也不获取 GPU 锁。缺失项在与重建相同的 `VIEWFORGE_GPU_LOCK` 下生成，沿用一张已配置 GPU 及默认空闲显存检查。一次模型加载处理全部缺失项，子进程退出后释放 GPU，再等待用户确认。网页的两个阶段共用串行队列。重建仍使用 seed 42、DA3 504、MV 50/25 默认配置。

每次准备的简短记录和推理日志在 `$VIEWFORGE_ROOT/logs/masks/<任务>/`，记录固定 revision、推理配置、复用/生成清单、耗时及结果状态。显示用缩略图在 `cache/mask_previews/<任务>/`。网页不增加日志区、下载入口、上传、参数或编辑器。


### 2026-09-13 部署验收

环境为独立 Python / torch 2.5.1+cu124 / torchvision 0.20.1 / transformers 4.48.3，`pip check` 通过。安装使用运行根目录缓存；cuDNN 9.1.0.70 从已有环境复制为独立副本，原环境保持不变。完整版本与安装日志见 `logs/birefnet-environment.txt`、`logs/birefnet-setup-final.log`。

使用独立物体 `birefnet_toy_20260913`，只链接 `stuffed_toy` 的 1、3、5、7 原图，最初没有 masks 目录。通过网页实际生成四张 mask：完整准备 45.311 秒；独立分割进程 30.751 秒（含 5.141 秒模型加载、图像读写），四张分别为 7.424 / 5.831 / 6.477 / 5.876 秒。200 ms 整卡采样峰值 2,680 MiB，开始和退出后均为 2 MiB；PyTorch 峰值 allocated 1,613.64 MiB / reserved 2,356 MiB。这里的整卡采样与 PyTorch 统计是不同指标。

四张输出均为 4096×3072 RGBA，保留原 RGB，alpha 仅 0/255；实际导入并调用上游 `notebook/inference.py::load_mask`，四张前景均与生成 alpha 完全一致。逐张检查缩略预览，玩偶主体被选中。这是自动 mask 流程验收，不代表复杂背景分割准确性评测。

分割记录：`logs/masks/20260913_160457_5dcf8dff/`；整卡采样：`logs/mask-gpu-20260913.csv`；下游回读检查：`logs/mask-loader-validation-20260913.json`。原物体 8 张已有 mask 的网页准备也已通过：复用 8、生成 0，17.015 秒，无模型进程与 GPU 使用。针对性及现有测试共 20 项通过，结果见 `logs/mask-tests-20260913.log`。


使用本次生成的 mask 从网页完成四图重建，运行名为 `20260913_birefnet_toy_20260913_web_160718_690463`。DA3 和 MV 阶段退出码均为 0，服务器重建约 281.23 秒（从保存配置到完成结果）；新 GLB 19,374,632 字节、Gaussian PLY 52,341,920 字节。默认 GLB 已在原网页实际加载，鼠标拖动后相机方位和可见视角均改变。验收在本次提交前工作区运行，运行记录中的 Git 起点为 `595a280`；重建核心、seed 42、DA3 504、MV 50/25 配置未改。

再次改变选择再回到同组四图，确认按钮先恢复“准备预览”；重新准备复用 4、生成 0，用时 10.228 秒，未进入模型/GPU路径，生成 mask 的大小及 mtime 均未改变。记录为 `logs/masks/20260913_161445_629dc28e/`。

另建独立物体 `birefnet_partial_20260913`，四张原图只作链接，并复制本次输出的 1、5 为 `_mask.png` 形式。真实准备复用 1、5，仅生成 3、7，共 38.542 秒；两张已有 mask 的大小和 mtime 未改变。记录为 `logs/masks/20260913_161310_9d2bedad/`。原 `stuffed_toy` 的全部照片和 mask 的大小及 mtime 与首轮准备记录一致，最终两张 GPU 均回到 2 MiB。


项目运行根目录已于 2026-09-13 统一为 `/workspace/geyinuo/ViewForge`，网页标题为 ViewForge。目录用途见 [项目目录](DIRECTORY_LAYOUT.md)。原路径 `/workspace/geyinuo/viewforge-mvsam3d` 保留为指向 `ViewForge` 的兼容软链接，用于已有环境入口、历史记录和符号链接；历史结果内容未批量改写。
