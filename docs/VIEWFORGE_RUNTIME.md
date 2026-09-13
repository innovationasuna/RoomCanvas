# 本地运行

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

不再提供逐阶段性能基准、显存采样、日志文字融合验收及重复结果快照。历史测量结果和旧运行不受影响。

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

从 `data/inputs/<物体>/images` 选择照片，掩码自动匹配；每次运行的 `input/` 只链接选中照片与掩码，DA3 和 MV 使用相同视角。CLI 也可用 `--images 1 3 5 7` 指定文件名（不含扩展名）。网页重建串行执行，完成后默认使用 `<model-viewer>` 查看 GLB 网格，支持拖动旋转和缩放；切换到 Gaussian 时才向上游同款 `gr.Model3D` 加载 PLY。两种模式均在本地浏览器渲染，重建仍在服务器执行。支持重新打开已有结果。网页只展示运行状态，不显示日志或模型下载入口；文件和日志仍保存在服务器运行目录中。查看器脚本随 `scripts/assets/` 本地提供。
