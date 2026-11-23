# 服务连接与下载用量记录

本页保留根 README 中的进阶连接方式和下载测量口径。首次部署从[房间安装](../ROOM_RECONSTRUCTION.md#安装)和[物品部署](../OBJECT_RECONSTRUCTION.md#部署)开始。

## 安装与启动

| 在哪里 | 操作 |
| --- | --- |
| Debian/Ubuntu x86_64 服务器 | 需要 NVIDIA GPU 和可用驱动、`dpkg-query`、`apt-get`、Git、Python 3、Conda 或 Mamba、uv ≥ 0.9.17。仅在需要安装缺少的系统包时使用 sudo 或 root。无 sudo 时可把 Conda 安装的 ffmpeg、git-lfs 加入 PATH，缺少的系统库请管理员安装。 |
| 获取源码 | 使用官方仓库地址。诊断传输时可用 `GIT_TRACE=1 GIT_TRANSFER_TRACE=1 git clone https://github.com/innovationasuna/RoomCanvas.git`，完成后进入 `RoomCanvas/`。 |
| 安装前检查 | 在仓库根目录执行 `sh scripts/setup_server.sh --dry-run` 预览，再执行 `sh scripts/setup_server.sh`。完整步骤会跳过，未完成的安装按脚本标记恢复。 |
| 模型权重 | SAM 3D、TRELLIS.2、DA3 等可用镜像的权重默认从 ModelScope 同名仓库获取，无需 Hugging Face 令牌。GitHub、PyTorch 及仅在 Hugging Face 上分发的模型仍需外网，必要时设置 `https_proxy`。 |
| 改用 Hugging Face | 设置 `MODEL_SOURCE=huggingface`，并通过 `HF_TOKEN` 提供已获 `facebook/sam-3d-objects` 访问权限的令牌。 |
| 房间重建 | 在 `$ROOMCANVAS_HOME/.env` 填写参考图生成所用的 `OPENAI_API_KEY`，登录 Codex CLI；环境根目录默认是仓库根目录。GPU、锁文件、编译架构、数据目录有默认配置。 |
| 机器专用设置 | 缓存、临时目录、镜像等可放在不进 Git 的 `runtime/server-env.sh`。启动脚本会加载它；手动运行 `run_room.py` 前可先在同一环境中 `source` 该文件。 |
| 服务器启动或重启后 | 从仓库根目录执行 `bash scripts/start_server.sh`；`bash scripts/start_server.sh status` 只查看状态。健康的服务会跳过。重启物品服务会丢失内存中的任务，共享 GPU 上应先确认任务状态。 |

## 网关、凭证与预览

默认地址如下。编辑器在本机运行，房间重建和物品重建在服务器运行。

| 位置 | 地址 | 用途 |
| --- | --- | --- |
| 本机 | `127.0.0.1:7880` | 网页服务 |
| 本机 → 服务器 | `127.0.0.1:7865` → `127.0.0.1:7870` | SSH 将两项重建请求转给同一个网关 |
| 服务器 | `127.0.0.1:7866`、`127.0.0.1:7862` | 网关转发到房间服务、物品服务 |
| 服务器日志 | `runs/web-room-jobs/service.log`、`runs/web-room-jobs/gateway.log`、`$VIEWFORGE_ROOT/logs/web.log` | 分别查看房间、网关、物品服务 |

在本机根目录运行 `python3 web/scripts/serve.py --ssh gpu-host`，将 `gpu-host` 换为自己的 SSH 主机。Ctrl-C 关闭本机网页和转发。断线后自动重连；使用密码登录时需再次输入，密钥登录可免去反复输入。

| 附加参数 | 适用场景 |
| --- | --- |
| `--server-dir <服务器仓库目录>` | 填写自己的远端仓库目录（历史 AutoDL 示例为 `/root/autodl-tmp/RoomCanvas`）。在转发连接中运行 `scripts/start_server.sh`，另开 SSH 连接读取凭证。使用密码登录时可能需要输入两次。[服务凭证](../../web/README.md#共享服务器的服务凭证) |
| `--remote <物品地址>:7862`、`--room-remote <房间地址>:7866` | 直接转发两项服务，绕过网关；房间地址可省略。若继续使用网关，只需更换物品服务绑定地址，在服务器启动命令中加 `--object-host <地址>`，网关会跟着更新。 |
| `--cpa` | 将服务器的 `127.0.0.1:8317` 转回本机 CLIProxyAPI，供服务器上的 Codex 使用本机订阅。关闭连接后，依赖此代理的精修和回放概括无法调用模型。 |

原部署记录中的 `runtime/bin/codex` 默认走上述代理，也可设 `ROOMCANVAS_CODEX_PROFILE=api` 切换到 `.env.astra`。这是该部署所用包装脚本的约定。重建器读取的环境和数据根目录由 `ROOMCANVAS_HOME` 指定。

服务器未检测到 GPU 时会进入预览模式，也可显式运行 `bash scripts/start_server.sh --preview`。能看房间、物品库和回放、保存物品尺寸；提交房间或物品重建会收到不可用提示。

预览模式缺少 `object-reconstruction/configs/local.env` 时使用 `runtime/object-reconstruction`。切换已运行服务的模式需先停止对应服务，再按目标模式启动。

## 本机缓存与下载

- 不连接服务器时，默认只预取缺少的示例模型。连接服务器时先取示例，再把完成任务的回放（点云、各版模型、配图）和房间存进 `runs/room-cache/`；终端显示进度，每 5 分钟检查一次。
- 页面优先读取本机副本，之后用无 SSH 的本机服务也能看已缓存房间和回放。进行中的任务不缓存；重试后，失效的副本会重新获取。
- 通过 `--cache <目录>` 改位置，`--no-download` 关闭后台预取。打开缺模型的示例时仍会按需获取。[示例获取](../../web/README.md#示例房间的模型) · [缓存管理](../../web/README.md#清理本地缓存)
- 房间服务提供文件大小与 SHA-256 时，下载前按内容去重，缓存和示例目录中已有相同文件就硬链接，跨磁盘则复制。新下载先校验，再保存。旧版服务不提供摘要时仍下载文件。

### 2026-11-21 下载测量

以下为两个已完成任务的历史测量，1 MB 按 10⁶ 字节计。后续服务器的下载量取决于其任务和本机已有文件。

| 范围 | 当时的记录 |
| --- | --- |
| 四个示例模型，取整 | office 36 MB、room3 70 MB、room-3934 89 MB、activity-classroom 264 MB，共约 459 MB |
| 两个任务的房间和回放 | 418 个文件，共 2839 MB；Activity Classroom 2380 MB，Room_3934 459 MB |
| 按内容去重 | 剩 2386 MB；各任务最后一版模型也是发布的房间和示例模型，部分配图相同 |
| 本机成功取得四个示例 | 与示例相同的内容占 353 MB，服务器再取 2033 MB；首次合计约 2.49 GB，去重前约 3.30 GB |
| 示例下载失败 | 当时需从服务器获取约 2386 MB |
