# 服务器部署与运维

网页在自己的电脑运行。要重建房间或拍照生成物品，在服务器安装相应模块。要使用全部网页功能，安装两套环境并启动网关。只想布置示例房间，可以直接在电脑上开始。[本机快速开始](../README.md#快速开始)

## 安装环境

| 用途 | 运行条件 | 安装内容 |
| --- | --- | --- |
| 房间重建 | Debian/Ubuntu x86_64、NVIDIA 驱动及 GPU、已登录的 Codex CLI。完整重建建议按 24 GB 级显存规划，实际峰值随物品而变 | Python 3.11 主环境、CUDA 12.4、Blender 5.1.2、TRELLIS 和检测模型 |
| 物品重建 | Linux x86_64、NVIDIA 驱动，能访问源码和模型源。默认配置下，执行重建或生成新蒙版时，选中的 GPU 至少要有 22 GiB 空闲显存。启动 API 和读取已有结果无需满足这一门槛 | MV-SAM3D 环境、DA3、烘焙扩展、独立 BiRefNet 环境及 API 依赖 |
| 无卡预览 | 已准备好可运行的服务环境和已有模型、任务目录 | 显示房间、物品和回放，支持保存物品尺寸。提交重建时会提示不可用 |

1. 在服务器准备 Bash、Git、Python 3、Conda 或 Mamba、uv ≥ 0.9.17。确认 `nvidia-smi` 能看到授权使用的显卡，并给模型和 CUDA 编译预留磁盘空间。安装脚本会显示可用空间。
2. 房间安装会用 `dpkg-query` 和 `apt-get` 检查构建工具、图形库、压缩和图像依赖。只有需要安装缺包时才用 root 或 sudo。无 sudo 时，ffmpeg、git-lfs 可从 Conda 安装后加入 PATH，缺少的系统开发库请管理员安装。
3. 在服务器克隆官方仓库，已有部署直接进入其根目录。以下命令默认把环境和数据放在仓库下。需要单独存放时，在安装和启动前将 `ROOMCANVAS_HOME` 导出为同一个绝对路径。

```bash
git clone https://github.com/innovationasuna/RoomCanvas.git
cd RoomCanvas
sh scripts/setup_server.sh all --dry-run
sh scripts/setup_server.sh all
```

| 选项 | 作用 |
| --- | --- |
| `all`（默认） | 先安装房间模块，再安装物品模块，适合一键启动 |
| `rooms` / `objects` | 只装指定模块，单服务启动见[房间指南](ROOM_RECONSTRUCTION.md)、[物品指南](OBJECT_RECONSTRUCTION.md#启动与检查) |
| `--dry-run` | 打印计划、路径与磁盘信息，预览时可在没有 GPU 的电脑运行 |

无 sudo 且缺少 ffmpeg、git-lfs 时，可先用 Conda 补齐这两个工具，再运行所选模块的安装命令。

```bash
conda create -p "$HOME/.local/roomcanvas-tools" -c conda-forge ffmpeg git-lfs
export PATH="$HOME/.local/roomcanvas-tools/bin:$PATH"
```

安装中断后重跑原命令。脚本跳过带 `.roomcanvas-setup-complete` 的组件，续装带 `.roomcanvas-setup-incomplete` 的组件。无标记的已有目录只做验证。验证失败时按报错核对路径和配方，不要手工补完成标记，否则下次会跳过验证。安装器只在本次安装的组件通过验证后，将未完成标记改名为完成标记。升级完整环境或模型时选新运行根目录。

## 配置环境与模型

| 位置或变量 | 配置方法 |
| --- | --- |
| `$ROOMCANVAS_HOME/.env` | 房间安装缺文件时从模板生成。用运行账号编辑此私有文件。为 OpenAI 参考图填写 `OPENAI_API_KEY`。如用 Gemini，设 `LR_IMAGE_PROVIDER=gemini` 并填写 `GEMINI_API_KEY`。建模另需以运行账号登录 Codex CLI。 |
| 房间本地推理 | 设置 `LR_DINO_BACKEND=local`。启动终端和 `.env` 中的 `MODAL_TOKEN_ID`、`MODAL_TOKEN_SECRET`、`MODAL_PROFILE` 均留空。 |
| 房间扫描与解释器 | `LR_SCANS_DIR` 可指定扫描父目录，模块默认目录为 `scans_uploaded`。服务器入口设置 Blender、CUDA 和模型解释器路径。 |
| `$ROOMCANVAS_HOME/runtime/server-env.sh` | 启动脚本会加载这份机器专用文件。用 `export` 配置 GPU、缓存、临时目录或下载代理。手动启动时先在同一终端加载所需设置。 |
| `object-reconstruction/configs/local.env` | 首次安装生成，已有文件保留。默认 `VIEWFORGE_ROOT=$ROOMCANVAS_HOME/runtime/object-reconstruction`。安装时已有配置只提供这个根目录。与显式导出的值冲突会停止。 |
| 物品环境 | 安装时需要的 GPU 或 `TORCH_CUDA_ARCH_LIST` 在调用终端导出。运行时先加载 `configs/local.env` 再加载 `scripts/env.sh`。时区按机器设置，精简容器可在配置中设 `TZ`。 |

房间启动器先读取进程环境，再合并 `.env`。显式导出的 GPU 限制优先于 `.env`。运行器设置机器路径，命令行 `--set KEY=VALUE` 最后覆盖。单次 Codex 建模会话的 `LR_CODEX_SESSION_SECONDS` 默认 3600 秒。[配置优先级](refactor/contracts.md)

**选择模型来源**

- 默认 `MODEL_SOURCE=modelscope`。TRELLIS.2、稀疏解码器、Grounding DINO、房间模块的 `facebook/dinov2-small`、SAM 3D 和 DA3 等使用可用的同名镜像。稀疏解码器只取所需 JSON 与 safetensors。固定版本的 DINOv3 仍走 Hugging Face。
- 物品模块的 DINOv2 权重 `dinov2_vitl14_reg4_pretrain.pth` 默认从 `dl.fbaipublicfiles.com` 下载，不随 `MODEL_SOURCE` 切换。安装前可用 `DINOV2_WEIGHT_URL` 指定该权重的下载地址。
- 设 `MODEL_SOURCE=huggingface` 可切换来源。安装缺失的 SAM 3D 权重前，先在 Hugging Face 获得 `facebook/sam-3d-objects` 的访问权限，再在安装环境私下提供 `HF_TOKEN`。
- 安装还需要访问 GitHub、PyTorch 和部分固定来源，可按网络情况配置 `https_proxy`。
- Blender 下载源可用 `BLENDER_ARCHIVE_URL` 指向镜像上的同一份 Linux x64 归档，历史示例为 `https://mirrors.aliyun.com/blender/release/Blender5.1/blender-5.1.2-linux-x64.tar.xz`，归档以安装脚本固定的 SHA-256 校验为准。TRELLIS 在独立临时目录编译并保留现场。若上游占用固定的 `/tmp/extensions` 且路径已存在，先查明归属再续装。

房间模块的安装入口是 `bash room-reconstruction/server/setup.sh`。

主环境与模型环境分别在 `runtime/litereality-env/` 和 `runtime/trellis-env/`，另有 `runtime/cuda-12.4/`、`runtime/blender/`。

模型源码在 `backends/TRELLIS.2/`，权重在 `backends/weights/`。可从脚本查看 Blender 镜像应对应的官方文件名及固定哈希。[房间安装配方](../room-reconstruction/server/setup.sh) · [TRELLIS Dockerfile](../room-reconstruction/deploy/modal/trellis/Dockerfile) · [扩展构建配置](../room-reconstruction/deploy/modal/trellis/app.py)

物品的照片和蒙版在 `$VIEWFORGE_ROOT/data/inputs/`，结果在同一根目录的 `runs/`，权重、环境和外部源码分别在 `weights/`、`envs/`、`third_party/`。[物品环境与烘焙检查](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md)

## 分配 GPU

两个模块按物理 GPU UUID 加独占文件锁，子进程继承锁。跨账号共用显卡时，把两端的 `ROOMCANVAS_GPU_LOCK_DIR` 指向同一可访问、可创建锁文件的本机绝对路径。默认路径 `~/.cache/roomcanvas/gpu-locks` 仅供同一账号共享。

| 设置 | 生效范围与默认值 |
| --- | --- |
| `ROOMCANVAS_GPU` | 房间默认 `auto`，也接受物理编号或 UUID。设置了 `CUDA_VISIBLE_DEVICES` 时只在允许集合内选，持锁后再次检查占用。 |
| `CUDA_VISIBLE_DEVICES` | 物品环境默认选启动时剩余显存最多的卡，共享机器可固定一张授权卡。子进程内的 `cuda:0` 对应选定的物理卡。 |
| `ROOMCANVAS_GPU_SHARED_MIB` | 房间默认 `0`，只选无计算进程、已用 ≤ 100 MiB 的卡。正值允许其他进程占用最多指定的 MiB。还须有足够的剩余显存。 |
| `ROOMCANVAS_GPU_PEAK_MIB`、`ROOMCANVAS_GPU_HEADROOM_MIB` | 房间共享模式要求可用显存至少达到峰值与余量之和，默认分别为 8400 和 2048 MiB。 |
| `ROOMCANVAS_TRELLIS_PEAK_MIB` | 共享模式下，小物品 TRELLIS 再检查其峰值（默认 16800 MiB）加同一余量。显存持续不足最多等两小时，随后保留替身。 |

房间命令行用 `--wait-gpu` 等候，网页物品任务等待时显示排队。获取锁最多等 30 分钟。共享目录下的锁按 `gpu-<UUID>.lock` 命名，最后一个持有文件描述符的进程退出后才释放。

两端仍兼容物品旧锁 `VIEWFORGE_GPU_LOCK` 和房间旧锁 `runtime/locks/gpu-<UUID>.lock`。从独立锁升级时，先等待旧版 GPU 作业退出，再切换两端进程，保留锁文件。[选卡与锁实现](../scripts/roomcanvas_gpu.py) · [房间资源检查](../room-reconstruction/server/gpu.py)

## 启动服务

在服务器仓库根目录启动，然后查看状态。若安装时改了 `ROOMCANVAS_HOME`，在这个终端先导出相同路径。

```bash
bash scripts/start_server.sh
bash scripts/start_server.sh status
```

脚本依次检查房间、物品、网关，保留健康进程。没有可见 NVIDIA GPU 时自动进入预览，也可显式运行 `bash scripts/start_server.sh --preview`。预览仍需已有的房间 Python 和物品 API 依赖。缺 `local.env` 时会尝试默认物品目录。

```text
电脑浏览器 → 本机网页 127.0.0.1:7880
               └─ 本机 127.0.0.1:7865 ── SSH ── 服务器网关 127.0.0.1:7870
                                                ├─ /room-reconstruction/ → 房间 :7866
                                                └─ 其他路径              → 物品 :7862
```

网关默认把两个后端连到服务器回环地址。物品服务要监听指定网卡时，将 `OBJECT_ADDR` 设为网关可达的本机网卡地址，启动和查状态时都传入这个地址，否则单独运行状态命令会检查默认回环地址。

```bash
bash scripts/start_server.sh --object-host "$OBJECT_ADDR"
bash scripts/start_server.sh status --object-host "$OBJECT_ADDR"
```

仅启动网关时，从服务器仓库根目录运行 `python3 web/scripts/gateway.py`。可用 `--objects 地址:端口`、`--rooms 地址:端口` 分别指定已运行的后端。

## 从电脑连接

在自己的电脑上准备 Git、Python 3、SSH 和一份相同版本的仓库。先用 `ssh gpu-host` 验证登录，输入 `exit` 回到电脑。以下命令均从本机仓库根目录运行，用 `~/.ssh/config` 里的别名或 `user@host` 替换 `gpu-host`。

```bash
python3 web/scripts/serve.py --ssh gpu-host
```

浏览器打开 <http://127.0.0.1:7880/web/>。默认只转发网关一个端口。SSH 断线会重连，密码登录可能再次提示。按 Ctrl-C 停止本机服务并关闭隧道。手机分享首次生成二维码才启动单独的只读端口 7881。[手机体验与端口设置](MOBILE_HANDOFF.md)

| 场景 | 为上面的命令增加的参数或操作 |
| --- | --- |
| 网关监听地址不同 | `--gateway 主机:端口`，填 SSH 主机一侧能连通的网关地址。 |
| 连接时启动服务器服务 | `--server-dir /path/to/RoomCanvas`。转发连接中执行启动脚本，另开 SSH 连接读取凭证，可能需要输入两次密码。 |
| 服务器使用电脑上的 CLIProxyAPI | `--cpa` 将服务器的回环端口 8317 转回电脑的同一端口，亦可用 `--cpa PORT`。使用该代理的 Codex 建模、精修或回放概括需要保持连接。 |
| 绕过网关 | 传 `--remote 127.0.0.1:7862` 或 `--room-remote 127.0.0.1:7866` 即启用双隧道。可同时指定两者。省略的一端用对应默认值。本机分别监听 7865 和 7866。 |
| 容器或指定网卡 | 直连参数填 SSH 主机可达的 IP 与端口。容器可绑定 `0.0.0.0`，转发目标填宿主机映射地址或可达的容器 IP。 |
| 自己维护外部隧道 | 省略 `--ssh`，用 `--viewforge URL`、`--room-backend URL` 指向本机隧道端口。单网关要让两者指向同一端口，并指定本机私有凭证副本。 |

本机更新客户端前先退出网页服务，在干净的部署分支执行 `git pull --ff-only`，再用原参数启动。[本机代理及参数](../web/scripts/serve.py) · [网关路由](../web/scripts/gateway.py)

## 服务凭证

三个服务的健康检查、模型读取和上传均验证同一个 Bearer 凭证。启动时自动创建或复用运行账号的 `~/.local/state/roomcanvas/service.token`。文件放在源码目录之外，由账号本人持有，权限设为 `0600`。

| 使用方式 | 凭证交给谁 |
| --- | --- |
| 默认 SSH 连接 | `serve.py --ssh` 通过 SSH 读取凭证到进程内存，为代理请求和后台下载添加请求头。浏览器无需输入。 |
| 更改服务器文件位置 | 三个服务使用相同的 `ROOMCANVAS_TOKEN_FILE`，手动启动也可以各传 `--token-file`。本机 SSH 客户端加 `--remote-token-file /path/to/service.token`。 |
| 手动转发 | 通过受保护的渠道把同一文件交给本机账号，以本人所有的 `0600` 普通文件保存。启动本机网页时用 `--token-file /path/to/service.token` 指定。 |
| 离线使用 | 本机已有的示例和已缓存房间无需服务凭证。 |

服务器上在仓库根目录运行下面的只读检查。它分别经过网关访问两套服务，只打印状态响应。物品响应应包含 `service: roomcanvas-objects` 和 `status: ok`。健康接口成功仅表示 API 在线。[凭证的生成与验证](../scripts/service_auth.py)

```bash
PYTHONPATH=scripts python3 - <<'PY'
from service_auth import load_token, urlopen

token = load_token()
for path in ("/room-reconstruction/health", "/health"):
    with urlopen("http://127.0.0.1:7870" + path, token=token, timeout=5) as response:
        print(path, response.status, response.read().decode())
PY
```

## 示例模型与本机缓存

示例清单列出每个 Release 附件名、目标路径、字节数和 SHA-256。缩略图与物品清单随 Git 提供。下表按 1 MB = 1,000,000 字节估算。[当前模型清单](../samples/models.json)

| 下载情形 | 冷启动用量 |
| --- | --- |
| 只取三个示例，无本地副本 | 办公室 36.0 MB、卧室 69.7 MB、Activity Classroom 263.7 MB，共 369.4 MB |
| 另用 SSH 缓存服务器任务 | 取决于已完成任务及模型版本，含点云、各版模型和配图。旧部署四示例、两任务的 2.49 GB 估算保留在[历史测量](history/README_DEPLOYMENT_NOTES.md#2026-11-21-下载测量)。 |

1. 本机服务先预取缺失示例，再经 SSH 将完成任务存入 `runs/room-cache/`。正常每 5 分钟检查一次。可用 `--cache DIR` 改位置，`--no-download` 关闭后台预取。
2. 手动获取示例用已登录的 GitHub CLI（`gh auth login`）或具有仓库读取权限的 `GH_TOKEN` / `GITHUB_TOKEN`。脚本也会给出浏览器下载位置与本机目标文件名。
3. 打开缺模型的示例时，先复用本机同大小、同摘要的文件，再从房间服务取关联任务的模型或服务器清单内的示例。未关联任务且服务不可达时，可用 GitHub 登录按需取单个附件。首页和 HEAD 探测不会下载模型。
4. 文件先写临时文件并校验。缓存与示例相同的内容优先硬链接，跨盘复制。更换自己的模型时以新文件替换目录项，避免原地改写所有硬链接。旧服务不提供摘要时，回放缓存仍可直接下载。
5. 房间与回放文件优先读取本机副本。任务状态和时间线优先访问服务器并保存成功响应。连接失败、传输中断或 502/503/504 时可显示上次缓存。后台跳过运行中任务的大文件，任务重试会使旧副本失效。

| 本机仓库根目录命令 | 用途 |
| --- | --- |
| `python3 scripts/fetch_samples.py --check --verify` | 只查示例大小与 SHA-256，有缺失或不匹配时退出码为 1。单用 `--check` 只核对存在性和大小。 |
| `python3 scripts/fetch_samples.py office --verify` | 修复指定示例，包括同大小但内容不同的模型。省略房间名可处理全部示例。 |
| `python3 web/scripts/cache_manage.py list --json` | 查看条目 ID、已下载文件和占用，也可省略 `--json`。 |
| `python3 web/scripts/cache_manage.py clear sample:office sample:room3` | 删除所选本机下载副本，ID 取自列表。显式清空全部可用 `clear --all`。 |
| `python3 web/scripts/cache_manage.py resume` | 恢复后台预取。以 `--no-download` 启动的服务仍仅按需获取。 |

使用自定义缓存时，独立下载器可运行 `python3 scripts/fetch_samples.py office --verify --cache /path/to/room-cache`，复用其中大小与摘要均匹配的模型。缓存管理器在子命令前传相同目录，例如 `python3 web/scripts/cache_manage.py --cache /path/to/room-cache list`。

清理后暂停标记在 `.roomcanvas/cache-downloads-paused`，重启后仍有效，打开示例仍能单独获取。

清理范围包括清单内的本机模型和可识别的回放下载副本。“离线房间列表”是单独条目。空间按文件数据去重。仍有硬链接时仅移除选中的副本。读写中的缓存会提示稍后再试。[编辑器缓存管理](../web/README.md#清理本地缓存)

## 更新、重启与故障排查

1. 在服务器正式仓库运行 `git status --short --branch`、`git rev-parse HEAD`，确认在 `main` 且受版本控制的文件干净。先查看房间、物品任务，等需重启的服务进入空闲窗口。物品任务进度在内存中，已保存的模型仍可用。
2. 执行 `git pull --ff-only origin main`。若有独有修改或无法快进，先保全并核对差异。房间主环境若需刷新，仅在原环境执行下面的命令。物品 API 依赖更新见[物品服务更新](OBJECT_RECONSTRUCTION.md#更新与重启)。
3. 只在需要重载代码、切换预览模式或修改后端地址时停止相应旧进程。先核对 PID、命令和工作目录。确认退出后再运行一键启动与状态检查。切换物品地址时需让物品服务和网关都使用新地址。

```bash
# 服务器仓库根目录，ROOMCANVAS_HOME 使用安装时的值；未设置时使用当前仓库
UV_PROJECT_ENVIRONMENT="${ROOMCANVAS_HOME:-$PWD}/runtime/litereality-env" \
  uv sync --project room-reconstruction --frozen --python 3.11 --extra modal
```

| 症状 | 检查位置与处理 |
| --- | --- |
| 启动超时、端口被占用 | 每个服务启动后最多探测 60 轮，每轮失败后等 2 秒，另计健康探针耗时。查 `$ROOMCANVAS_HOME/runs/web-room-jobs/service.log`、同目录 `gateway.log` 或 `$VIEWFORGE_ROOT/logs/web.log`。脚本保留旧进程，空闲时再按 PID 重启。 |
| 网关显示健康，物品服务连不上 | 一键状态对网关走房间健康路径。用上面的双路径探针检查网关到物品服务，再核对监听网卡、容器端口和 `--object-host`。 |
| 收到 401 或升级后检查失败 | 本机和服务器更新到兼容版本，核对三个服务的凭证路径、所有者与权限。启动检查要求匿名请求被拒、带凭证得到 200。旧的匿名服务需在空闲窗口更换。 |
| 网页只能浏览，无法提交 | 查启动输出是否为预览。检查驱动、`nvidia-smi -L` 和授权显卡，空闲后重启受影响服务。预览本身也依赖已安装的 API 环境。 |
| 卡在等待显卡或报告显存不足 | 对照 `nvidia-smi`、共享显存阈值和锁目录。房间任务的 `run-config.json` 记录选卡时的占用。 |
| 更换本机端口 | 网页用 `--port`。内置 SSH 隧道可用 `python3 web/scripts/serve.py --ssh gpu-host --viewforge http://127.0.0.1:7965` 换端口。默认网关模式下两项服务共用本机 7965，双隧道模式可另用 `--room-backend` 指定房间端的本机 URL。只读手机分享用 `--share-port`。 |
| 物品能打开，烘焙失败 | 在 MV 环境按[颜色烘焙检查](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#颜色烘焙) 核对 `nvdiffrast`、`gsplat`、`xatlas` 和 CUDA。 |
