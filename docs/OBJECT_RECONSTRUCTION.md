# 物体重建

`object-reconstruction/` 把照片重建成带纹理的三维模型，并按一条实测边长标定到真实尺寸。它是无界面的 Starlette / Uvicorn API 服务，由网页编辑器物品库里的“添加物品”和“从已生成的模型添加”调用。

## 重建与材质

单独物品采用 **MV-SAM3D + 颜色烘焙 + 场景受光**。默认 `mesh_export.mode: baked_pbr`，将 Gaussian 外观烘焙到 2048² UV 颜色贴图；保留原几何、Gaussian 和 COVER 补拍流程。粗糙度固定为 1、金属度为 0，不预测分区材质属性，也不自动去除照片中的明暗。

编辑器的尺寸预览和场景导入均保留烘焙贴图并响应灯光；旧版顶点色模型仍可切换受光。单独物体的 TRELLIS、多图 TRELLIS 和分区材质实验已移除。完整流程见 [重建流水线](OBJECT_RECONSTRUCTION_PIPELINE.md)。

烘焙需要正式 MV 环境中的 `nvdiffrast`、`gsplat` 与 `xatlas`；安装入口已固定依赖。已有环境的补装和 CUDA 检查见 [颜色烘焙](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#颜色烘焙)。仅 `/health` 成功不能证明烘焙可用。

## 部署

服务跑在 Linux GPU 服务器上，网页跑在本机，通过 SSH 隧道连接。两台机器各有一份源码；服务器命令使用 Bash。以下 `<…>` 都要替换为自己的值，路径占位符使用绝对路径。

### 首次部署

准备 Linux x86_64 + NVIDIA 驱动和 GPU、Git、Python 3、Conda 或 Mamba、uv ≥ 0.9.17，以及已获 `facebook/sam-3d-objects` 访问权限的 Hugging Face 令牌；改用 ModelScope 时（`export MODEL_SOURCE=modelscope`）不需要令牌。两套环境一起安装时还需要 Debian/Ubuntu apt 和 sudo（或 root）。

**服务器上**，在仓库根目录执行；已有仓库省略克隆：

```bash
git clone https://github.com/innovationasuna/RoomCanvas.git
cd RoomCanvas
export VIEWFORGE_ROOT='<环境、权重与数据根目录的绝对路径>'
export HF_TOKEN='<Hugging Face 令牌>'   # 或 export MODEL_SOURCE=modelscope
sh scripts/setup_server.sh objects --dry-run
sh scripts/setup_server.sh objects
```

入口也可直接使用 [`bash object-reconstruction/scripts/setup.sh`](../object-reconstruction/scripts/setup.sh)。脚本创建重建环境、外部源码、模型权重和独立 BiRefNet 环境，包含 API 依赖；具体配方与续跑行为见 [安装说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#安装)。

脚本只在缺失时生成 `object-reconstruction/configs/local.env`。已有配置中的 `VIEWFORGE_ROOT` 优先；若与终端显式设置的值冲突，会停止并给出重跑命令。编辑配置中的 `CUDA_VISIBLE_DEVICES`（一张获准使用的 GPU）、`VIEWFORGE_GPU_LOCK`（共享该卡的应用使用同一路径）、`TORCH_CUDA_ARCH_LIST` 和 `TZ`，见 [服务器配置](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#服务器配置)。安装前需指定编译架构或可见 GPU 时，在终端显式 export；安装脚本只读取配置中的根目录。

### 启动与检查

**服务器上**，在 `RoomCanvas/object-reconstruction/` 执行（首次安装完成后，或服务器重启后）：

```bash
source configs/local.env && source scripts/env.sh
mkdir -p "$VIEWFORGE_ROOT/logs"
nohup python scripts/web.py --host 127.0.0.1 --port 7862 >> "$VIEWFORGE_ROOT/logs/web.log" 2>&1 &
curl --fail --show-error http://127.0.0.1:7862/health
```

等服务启动后再执行 `curl`，预期返回 `{"service":"roomcanvas-objects","status":"ok"}`；失败时查看 `$VIEWFORGE_ROOT/logs/web.log`。安装脚本会创建 `logs/`；启动命令中的 `mkdir -p` 也兼容已有环境。`/health` 只确认 API 在线，不代表 GPU 推理或权重已验证。

`--host` 是服务绑定的本地地址，必须使服务能从 SSH 登录的主机一侧访问。本机 `serve.py --remote` 则填写 **从 SSH 主机能连接到的服务地址和端口**：

| 服务所在位置 | 服务 `--host` | 本机 `--remote` |
| --- | --- | --- |
| 与 SSH 登录在同一台主机、同一网络命名空间 | `127.0.0.1` | 默认 `127.0.0.1:7862`，可省略 |
| 绑定服务器的指定网卡 | `<监听地址>` | `<监听地址>:7862` |
| 容器中监听并已将 7862 端口映射到 SSH 主机的回环地址 | `0.0.0.0`（容器内） | `127.0.0.1:7862`（宿主机映射端口） |

容器 IP 若能从 SSH 主机直接访问，也可作为 `--remote` 的地址；否则先配置端口映射。`0.0.0.0` 是绑定所有网卡的地址，不用作 `--remote` 目标。更换监听地址后，健康检查也要使用可连接的地址。

### 更新与重启

等当前重建任务结束后再更新；API 的任务进度在内存中，重启后不会恢复，已保存的结果仍可导入。

**服务器上**，在 `RoomCanvas/object-reconstruction/` 查找旧进程；核对 PID、命令和启动目录确实属于本服务：

```bash
pgrep -af 'python.*scripts/web.py'
ps -p '<旧服务 PID>' -o pid,args
readlink '/proc/<旧服务 PID>/cwd'
kill '<旧服务 PID>'
ps -p '<旧服务 PID>' -o pid,args  # 等到不再列出该进程
```

**服务器上**，在 `RoomCanvas/object-reconstruction/`，确认旧服务退出后更新并重新启动：

```bash
git pull --ff-only
source configs/local.env && source scripts/env.sh
python -m pip install -r configs/api-requirements.txt
mkdir -p "$VIEWFORGE_ROOT/logs"
nohup python scripts/web.py --host 127.0.0.1 --port 7862 >> "$VIEWFORGE_ROOT/logs/web.log" 2>&1 &
curl --fail --show-error http://127.0.0.1:7862/health
```

沿用之前的监听地址。上面的 pip 命令仅刷新 API 依赖；重建依赖或权重要求有变时，先按 [安装说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#安装) 核对配方，在新运行目录安装。只重启、不更新时，省略 `git pull` 和依赖安装。

### 数据目录

`VIEWFORGE_ROOT` 下，`data/inputs/` 保存照片与蒙版，`runs/` 保存结果，`weights/`、`envs/`、`third_party/` 存放权重、环境和依赖，`logs/web.log` 保存 API 日志。源码更新不需要重新复制或删除这些数据。

## 在编辑器中使用

本机需要 Git、Python 3 和 SSH 客户端；网页服务仅用 Python 标准库，无需安装 GPU 或 Python 包。先在 `~/.ssh/config` 配置服务器别名，或直接使用 `user@host`。

**本机**，任意目录先验证 SSH 登录，登录后执行 `exit` 回到本机，再继续下文：

```bash
ssh '<SSH 主机>'
```

**本机**，从准备存放源码的目录开始；已有本机仓库时直接进入 `RoomCanvas/`，省略克隆：

```bash
git clone https://github.com/innovationasuna/RoomCanvas.git
cd RoomCanvas
python3 web/scripts/serve.py --ssh '<SSH 主机>'
```

打开 <http://127.0.0.1:7880/web/>。隧道把本机 `127.0.0.1:7865` 接到 SSH 主机一侧的 `127.0.0.1:7862`，按 `Ctrl-C` 停止网页时一起关闭。

**本机**，在 `RoomCanvas/` 根目录，目标不是默认地址时用以下命令替代启动命令（不要同时启动两份）：

```bash
python3 web/scripts/serve.py --ssh '<SSH 主机>' --remote '<监听地址>:7862'
```

后续在本机已有仓库中运行同一启动命令即可；更新本机源码时先停止网页，再执行 `git pull --ff-only`。只用示例房间和编辑器可省略 `--ssh` 及其参数，无需服务器；“添加物品”和“从已生成的模型添加”都依赖物体服务。

“添加物品”：上传 1–40 张照片 → 确认抠图 → 重建 → 输入一条实测边长 → 放进房间。“从已生成的模型添加”读取已有结果和标定，按真实尺寸摆放；操作见 [网页编辑器](../web/README.md#添加与导入物品)。

### 补拍

按结果页的橙色箭头补拍并上传照片，即可在原结果基础上重新重建。详见 [COVER 补拍引导](../object-reconstruction/docs/COVER.md)。

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /viewforge/objects/create` | 命名并上传 1–40 张 JPEG / PNG |
| `POST /viewforge/objects/capture` | 提交已有结果 `run` 和补拍照片 |
| `POST /viewforge/objects/masks` | BiRefNet 抠图，返回任务号 |
| `POST /viewforge/objects/reconstruct` | DA3 + MV-SAM3D 重建并生成 COVER 补拍建议；`parent` 指定原结果 |
| `GET /viewforge/objects/jobs/<任务号>` | 查询进度与结果 |
| `GET /viewforge/objects/previews/<批次>/<照片>.png` | 蒙版预览 |
| `GET /viewforge/assets/catalog` | 已重建物体目录 |
| `GET /viewforge/assets/<结果>` | 尺寸基准与已保存的标定 |
| `GET /viewforge/assets/<结果>/result.glb`、`preview.glb` | 完整模型、轻量模型 |
| `GET /viewforge/assets/<结果>/result.ply`、`preview.json` | Gaussian、补拍建议 |
| `GET /viewforge/dimensions/<结果>` | 读取标定 |
| `POST /viewforge/dimensions/<结果>` | 保存或清除实测标定，支持 mm / cm / m |
| `GET /viewforge/dimensions/<结果>/model.glb` | 导出米制模型 |
