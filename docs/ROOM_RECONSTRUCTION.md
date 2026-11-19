# 房间重建

房间重建模块把 iPhone LiDAR + RoomPlan 扫描生成真实尺寸、带纹理的 `Room.glb`，供网页编辑器浏览和调整家具布局。流程包括房间结构重建、家具建模与摆放、视觉检查，并支持小物件重建和可动部件识别。

## 运行环境

重建在 Linux GPU 服务器上运行；完成后把房间文件复制到本机，由本机网页编辑器读取。房间重建不依赖物体 API 的 7862 端口。

设置 `ROOMCANVAS_HOME` 为环境和数据根目录的绝对路径。该目录下的 `.env` 保存 API 密钥和图像生成设置；`runtime/` 存放 `litereality-env/`、`trellis-env/`、`blender/` 和 `cuda-12.4/`，`backends/` 存放 `TRELLIS.2/` 与 `weights/`。下文 `<…>` 都要替换为自己的值。

## 安装

服务器准备 Linux x86_64、NVIDIA 驱动和至少 24 GB 显存的 GPU、Git、Python 3、Conda 或 Mamba、uv ≥ 0.9.17、已登录的 Codex CLI。系统包使用 Debian/Ubuntu apt，缺包时需 sudo 或 root；没有 sudo 时，`ffmpeg`、`git`、`git-lfs` 只要在 PATH 上即可（例如 `conda create -p <目录> -c conda-forge ffmpeg git-lfs` 后把 `<目录>/bin` 加入 PATH），库文件仍需管理员安装。

**服务器上**，从仓库根目录执行；首次获取源码先运行 `git clone https://github.com/innovationasuna/RoomCanvas.git` 并进入 `RoomCanvas/`：

```bash
export ROOMCANVAS_HOME='<环境与数据根目录的绝对路径>'
sh scripts/setup_server.sh rooms --dry-run  # 只看步骤，不安装或下载
sh scripts/setup_server.sh rooms
```

也可直接运行 [`bash room-reconstruction/server/setup.sh`](../room-reconstruction/server/setup.sh)。脚本按仓库中的 [Dockerfile](../room-reconstruction/deploy/modal/trellis/Dockerfile) 和 [扩展构建配置](../room-reconstruction/deploy/modal/trellis/app.py) 安装：主环境在 `runtime/litereality-env/`，CUDA 12.4、Blender 5.1.2 和 TRELLIS 环境也放在 `runtime/`；源码与权重放在 `backends/`。稀疏解码器只下载所需的 JSON 和 safetensors 两个文件。默认（`MODEL_SOURCE=modelscope`）TRELLIS.2、稀疏解码器、Grounding DINO 和 DINOv2 改从 ModelScope 下载；固定版本的 DINOv3 仍从 Hugging Face 下载。官方 Blender 下载站访问不了时，把 `BLENDER_ARCHIVE_URL` 设为官方镜像上的同一文件（例如 `https://mirrors.aliyun.com/blender/release/Blender5.1/blender-5.1.2-linux-x64.tar.xz`），脚本会按官方 SHA256 校验。TRELLIS 构建使用独立临时目录并保留现场；若上游使用固定 `/tmp/extensions` 且该路径已存在，会先停止，需核对其归属后处理。

完成标记 `.roomcanvas-setup-complete` 只在文件与依赖检查通过后写入。重跑同一命令会跳过已完成步骤、恢复带 `.roomcanvas-setup-incomplete` 的步骤；无标记的已有目录只验证，不补装或覆盖，验证失败时停止并提示路径。不要给已有目录手工补标记来绕过检查。

脚本仅在缺失时生成 `$ROOMCANVAS_HOME/.env`。填写 `OPENAI_API_KEY`；使用 Gemini 时填写 `GEMINI_API_KEY` 并设 `LR_IMAGE_PROVIDER=gemini`，`LR_SCANS_DIR`（扫描父目录）默认是 `scans_uploaded`，只在扫描放在别处时才填。本地运行保持 `.env` 和启动终端中的 `MODAL_TOKEN_ID`、`MODAL_TOKEN_SECRET`、`MODAL_PROFILE` 为空，设置 `LR_DINO_BACKEND=local`。Blender、生成与检测解释器路径由 [`run_room.py`](../room-reconstruction/server/run_room.py) 设置。`run_room.py` 读入的 `.env` 会覆盖启动服务时的同名环境变量；建模 agent 一次会话的时长上限 `LR_CODEX_SESSION_SECONDS`（默认 3600 秒，跑满按“没做完”处理，重试会接着已保存的房间继续）若写在 `.env` 里，就只能在那里改。

后续更新前先等重建结束。**服务器上**，在仓库根目录更新源码；只刷新主环境依赖时仍使用同一个环境目录：

```bash
git pull --ff-only
UV_PROJECT_ENVIRONMENT="$ROOMCANVAS_HOME/runtime/litereality-env" \
  uv sync --project room-reconstruction --frozen --python 3.11 --extra modal
```

安装失败后直接重跑 `sh scripts/setup_server.sh rooms`。已有完整环境的模型版本或编译依赖需要变更时，先核对脚本配方，再选择新的 `ROOMCANVAS_HOME` 安装；完成标记不会自动触发升级。

实测情况：2026-11-03 在 RTX 3090 服务器上对已有环境运行 `scripts/setup_server.sh all`，各组件按已有目录只做检查，全部通过；2026-10-30 在 RTX 4090 服务器（Ubuntu 26.04，无 sudo）从零安装，主环境、CUDA 12.4 和 Blender 已装好并通过检查。TRELLIS.2 编译和模型下载的全新安装尚未实测；安装脚本不运行 GPU 推理。

## 从网页重建房间

房间选择页右上角的 **重建房间** 接受一个房间的完整扫描包：LiteReality Scanner 导出的 tar 可以直接上传，也可以是 ZIP、`.tar.gz` 或 `.tgz`（最大 2 GB，解压后最大 8 GB / 50,000 个文件；按文件开头判断格式，不看扩展名）。扫描需要包含 `room.usdz`（也可以在 `roomplan/` 中）、`frame_*.json` 相机数据、`depth_*.png` 深度数据，以及图像帧或 `frames.mp4`；扫描 App 导出的 `pointcloud.pcd` 可一起放入（重建优先使用它）；支持外面套一层房间文件夹。这里只接收扫描数据，不接收普通照片集或已生成的场景包。

例如，可用 `tar -cf room.tar -C /path/to/scans room-folder` 打包单个扫描文件夹；需要 gzip 压缩时改用 `tar -czf room.tar.gz -C /path/to/scans room-folder`。已有 TAR 扫描包可以直接上传，无需重新压缩为 ZIP。

### 启动服务

先按上文 [安装](#安装) 装好房间重建环境并填好 `.env`；房间重建服务直接调用这套环境，不会自己安装依赖。**服务器上**，在 `RoomCanvas/` 根目录执行：

```bash
export ROOMCANVAS_HOME='<环境与数据根目录的绝对路径>'
"$ROOMCANVAS_HOME/runtime/litereality-env/bin/python" web/scripts/room_service.py \
  --data-dir "$ROOMCANVAS_HOME/runs/web-room-jobs"
```

默认只监听服务器 `127.0.0.1:7866`。默认运行器调用 [`run_room.py`](../room-reconstruction/server/run_room.py)，沿用自动选卡、GPU 锁、服务器环境配置和可动部件生成。服务只用 Python 标准库，不需要额外安装。自动选卡只用完全空闲的卡；多人共用、卡上常驻别人小进程的机器，可设环境变量 `ROOMCANVAS_GPU=<编号>`（指定卡）和 `ROOMCANVAS_GPU_SHARED_MIB=<MiB>`（允许别人已占用不超过这么多显存），例如写进 `runtime/server-env.sh`；GPU 锁照常防止两个重建同时用一张卡，运行记录 `run-config.json` 里记下当时别人占用的显存。

**本机**用 `python3 web/scripts/serve.py --ssh '<SSH 主机>'` 启动网页，默认经服务器上的网关（`python3 web/scripts/gateway.py`，监听 `127.0.0.1:7870`，房间服务在 `127.0.0.1:7866`，用 `--rooms` 改）转发；不用网关时给 `--remote` 或 `--room-remote '<地址>:<端口>'`，会回到分开的两条隧道（本机 `7865`、`7866`）。自己开隧道时用 `ssh -N -L 127.0.0.1:7866:127.0.0.1:7866 '<SSH 主机>'`，再运行不带 `--ssh` 的 `serve.py`；本机端口不同时加 `--room-backend http://127.0.0.1:<端口>`。

打开 <http://127.0.0.1:7880/web/>，点击 **重建房间**，或直接打开 <http://127.0.0.1:7880/web/#reconstruct>。

房间服务会等待获准的 GPU 可用。直接运行 `server/run_room.py` 时可用 `--wait-gpu` 开启等待，终止等待进程会释放其持有的描述符。设置 `CUDA_VISIBLE_DEVICES` 后，自动选卡只在可见范围内进行；子进程以选中卡的 UUID 运行。主流程及自动追加的 articulate 持同一把锁。

房间与物体服务默认共用 `~/.cache/roomcanvas/gpu-locks/gpu-<UUID>.lock`。使用多个账号时，将两端的 `ROOMCANVAS_GPU_LOCK_DIR` 设为同一本地目录，并为各账号配置目录访问权限。房间旧的 `runtime/locks/gpu-<UUID>.lock` 继续持有，物体端原有 `VIEWFORGE_GPU_LOCK` 也继续生效。从两个独立锁协议升级时，先等旧版 GPU 作业退出，再切换两端进程。释放锁依靠关闭文件描述符，保留锁文件供后续进程复用。

用 uv 直接安装的环境（例如 macOS + Modal）可选择 `--runner cli --pipeline-dir /path/to/RoomCanvas/room-reconstruction`，此模式调用 `uv run --no-sync litereality run ... --through publish`，使用该环境已有的模型配置，不包含服务器专用可动部件后处理；部署方负责 GPU 资源协调。默认 `server` 模式沿用本项目已有的运行器。

### 使用与结果

- 填写房间名称，选择或拖入扫描包（tar 或 ZIP），点击 **上传并开始重建**。服务未连接时仍显示入口和扫描要求，但不能提交。
- 上传百分比只表示文件传输进度。提交后显示实际流水线阶段，不估算重建完成百分比；同一 API 服务一次运行一个任务。
- 提交成功后可关闭窗口或刷新网页，任务继续运行。任务记录保存在 `--data-dir`，失败可重试并复用已有阶段；同一次上传的重复提交不会创建重复任务。
- 服务重启会恢复排队任务，并把未完成任务标记为需重试。上次进程仍运行时，任务文件锁阻止重复执行。超时默认 6 小时，可用 `--timeout <秒>` 修改。
- 完成后自动运行 `room_objects.py`，校验 GLB 节点与布局，再发布 `Room.glb`、`room_objects.json` 和可选的 `thumbnail.jpg`。服务器不生成缩略图，首页先显示“房间预览暂不可用”，不影响进入布置；在本机（`serve.py --ssh` 运行中）执行 `python3 web/scripts/thumbnail.py --url http://127.0.0.1:<端口>/web/ --room scan-<任务号> --ssh <服务器> --server-dir <服务器上的 RoomCanvas>`，会从编辑器截图并放到服务器上该房间的发布目录。
- 新房间通过动态目录加入首页，不改写仓库中的 `web/rooms.json`。读取新房间仍需重建服务及隧道在线；后端离线不影响原有示例房间。
- 原始扫描、运行输出及日志留在服务器的数据目录，不要放进 Git。失败详情看 `<任务号>/task.log`；默认运行器的阶段日志在 `<任务号>/run/attempt-*/`。网页不提供任意服务器路径或日志读取接口。

### 查看重建过程

首页“房间重建任务”里，正在重建的任务有 **实时查看**，结束的任务有 **查看过程**，都打开 `web/replay.html?job=<任务号>`：

- 左栏按 11 个阶段（房间发布后又按意见修改过的、跑过小物品重做的，各多一个）列出重建记录并配图，右边三维视图随过程变化：先是扫描点云（每个点的颜色取自扫描时拍的照片，按深度图判断是否被遮挡）从房间中间向四周展开，画出墙线和物品框时点云在一秒内淡出，之后不再显示；制作物品时房间的墙和地面先出现，物品做好一件，镜头就平滑地推近到它跟前（选没有别的物品、墙或柱子挡着、离墙不太近的方向，挡住时改从更高处看；已经看得清楚就不动，连着做好的物品之间直接移过去，不先退回全景），到位后物品表面亮起与它同色的细密点云，蓝色线框从下往上扫过，实体紧跟着填满（约 3 秒，左下角显示三角面数），没做的留线框；一次出现多件（如一组椅子）时从低到高依次成形，全部在约 4 秒内开始；建模 agent 后加的部件也这样出现，包括换成最终房间时已有的部件。拖动时间轴时直接显示结果，系统开启“减少动态效果”时不播放，底部右侧可选播放速度（0.5×、1×、2×、4×）：加速时运镜和 1× 一样，镜头移向物品的那一段仍按 1× 播放，物品成形和模型淡入只略微加快（2× 时约 1.4 倍，4× 时 2 倍），其余部分按所选倍速，所以整体比标称的倍速慢；之后依次换成初版房间、检查时的房间、最终房间、重做了小物品的房间（跑过这一步时）和装好可开合部件的房间（发布的就是这一版；新模型约 2 秒淡入，实时查看时模型还没写完导致加载失败会 5 秒后再试）。实时查看建模时，正在改的房间也会显示，最多每 5 分钟换一次新版本（模型约 90 MB），记下最终房间后换成最终房间；左栏和结尾只说检查是否通过、是否修过，不显示分数。过程中失败的尝试和报错（如某件物品这次没做成）不在页面上显示，只留在日志里；任务本身没跑完时结尾显示“重建还没完成”（不标红），提示在任务列表里重试。底部时间轴可拖动、单步，时钟显示真实用时。
- 已完成任务的回放文件由本机 `serve.py --ssh` 在后台下载到 `runs/room-cache/`，下载完后从本机读取，服务器关机也能看（见 [README](../README.md) 的服务器启动说明）。
- 重建中每 5 秒取一次新记录并停在最新处；往回拖可以看之前的步骤，点 **回到最新** 继续跟随。结束后从头自动播放。播到最后（房间建好）时换成与房间预览相同的“物理光照”（直接调用编辑器的 `web/editor/time-lighting.mjs`，那边调整后回放跟着变），往回拖则回到回放自己的光照。回放把时间留给看得见的变化（时钟仍显示真实时间）：读取扫描至少 6 秒，每件物品第一次成形留 4.5 秒（同时出现的一批再加上依次开始的时间，最多 4 秒），换上新的房间模型留 2 秒，每个阶段的第一条记录留 1.5 秒；其余记录不论实际用了多久，每条只占 0.1 秒，重做已经在房间里的物品也不再停留。整体长度主要取决于成形的物品数量，一般两分钟左右。
- 记录来自运行目录里流水线自己写的文件：`scene_init/obj_stage/traces/` 下的 `trace.jsonl`、建模 agent 的 `authoring_trace.*.jsonl`，以及 `realism_authoring/acceptance/` 的检查结果。新的重建还会在 `trace.jsonl` 里记下回放按真实时间排布所需的时间点：每件物品做好的时间（`object_done`，AI 重建和程序建模都有，建模过程中一做好就记，便于实时查看）、椅子形状没通过后的重新生成（`chair_qc_retry`、`chair_qc_restored`）、初版房间／检查时的房间／最终房间／装好可开合部件的房间的保存时间（`model_saved`，`seed`/`round`/`final`/`articulated`）、检查结论（`review_done`，通过与否）、修复开始和结果（`repair_start`、`repair_done`，修复 agent 的操作另记在 `authoring_trace.repair.jsonl`）、可开合部件这一步的开始和结果（`articulate_start`、`articulate_done`）、建模 agent 每次编译房间新增的部件（`room_built`），以及每次运行的编号（`run`，`run_room.py` 用 `attempt-NN`，重试时回放会标出“重新开始重建”，检查次数按每次运行分别计）。有了这些记录，房间模型只按记录的时间出现：建模 agent 工作时会反复改写最终房间的文件，不再因此提前显示“导出最终房间”。没有这些记录的旧任务仍按文件时间和 agent 日志推断。流水线阶段用固定的中文说明；建模 agent 的操作由重建服务按批交给 Codex（默认 `gpt-6-astra`、思考程度 `low`）概括成白话，结果缓存在 `<任务号>/replay/summary.json`，回看不再调用模型。概括出来之前先显示按时间合并的简要说明。建模 agent 和修复 agent 每开一次新会话（中断后续跑、发布后按意见修改），上一次的记录被移到 `traces/history/authoring_trace.<author|repair>.run_NNN.jsonl`；回放按顺序读全部会话，后一次会话的记录编号接着前面的往下排，已缓存的概括仍对应原来的记录，新会话另行概括（一批不跨会话）。会话的配图按会话内的步号命名，被后一次会话同名覆盖的不再显示。以前的版本每次会话都从 0 编号，它写的 `summary.json`（没有 `"numbering": "sessions"` 标记）在使用前按时间对齐：每批记录移到它第一条说明的时间所在的会话，编号加上该会话前面的记录数；当时没概括到、又在最后一批之前的记录仍不显示，回放内容不变。重建服务对齐后把缓存连同标记写回，之后不再移动。
- 分几次运行的重建（每次运行一个 `attempt-NN`，例如先做物品、再搭建和检查房间，之后单独重做小物品、装可开合部件）在回放里是一次连续的重建：上一次运行正常结束（`attempt-NN/exit` 为 `0`）时，下一次只是接着做，不标“重新开始重建”；上一次失败，或者没有 `exit` 文件（以前的运行），仍然标出，网页上的重试总在失败之后，所以照旧标出。某次装可开合部件的尝试之后还有别的运行，或又开始了重做小物品、装可开合部件时，这次尝试的开始和失败都不显示；之后又开始了重做小物品或装可开合部件时，之前装好可开合部件的房间也不再作为结尾。这两步的运行编号自成一套（`attempt-01` 起），会与主运行的编号重名，所以按记录的先后判断，不按编号。沿用以前重建做好的物品模型（`object_done` 带 `method: "provided"`，或带 `reused` 和 `source`）说成“沿用之前做好的…模型”，也在房间里成形；同一次重建重试时从缓存复用的模型（只带 `reused`）仍在当初做好的时间说“做好…的模型”。小物品重做记下开始（`small_objects_start`）、每件物品的结果（`small_object_done`，`method` 为 `trellis`/`procedural`/`dropped`/`kept`）、件数汇总（`small_objects_done`，重做、去掉和保持原样的件数）和这一步的房间（`model_saved`，`small_objects`；文件在运行目录的 `small-objects/room_preview/Room.glb`，不在那里时按记录里的 `path` 找，只认运行目录内的文件）。回放为它加一个“重做小物品”阶段，放在检查之后、装可开合部件之前：按照片重做的物品每件一行，去掉和保持原样的只在最后一行汇总，这一行换上重做了小物品的房间（新做的小物品不单独成形，随房间淡入）。这一步跑过多次（先 `--through evidence` 只整理证据再正式运行，或改代码后重跑）时只显示最后一次，即最后一个 `small_objects_start` 之后的记录。没跑过这一步的任务仍是 11 个阶段，回放与以前相同。
- 房间发布（记下 `model_saved` 的 `final`）之后，建模 agent 又开了新会话（按修改意见回到这间房间）时，回放加一个“按意见修改”阶段，放在检查之后、重做小物品之前：从第一次这样的会话开始，会话里的步骤（不论概括时归入哪个阶段）、之后的检查、修复和再次导出的最终房间都归入这一阶段，检查的编号和对应的房间模型不变；发布前的会话（如中断后续跑）仍按原来的阶段。修改会话开始之前跑过的重做小物品、装可开合部件不再显示（它们用的房间正在被修改，之后会重跑），所以修改进行中和重跑之前，回放停在“按意见修改”；这些旧房间仍在可用模型列表里。
- 概括使用 `$ROOMCANVAS_HOME/runtime/bin/codex`（没有时用 PATH 里的 `codex`）。模型和思考程度可用环境变量 `LR_REPLAY_MODEL`、`LR_REPLAY_EFFORT` 修改，`LR_REPLAY_CODEX` 指定其他命令；启动服务时加 `--no-replay-summary` 则不调用模型，只用简要说明。调用失败写入 `<任务号>/replay-error.log`，5 分钟后重试。

以前用命令行跑完的运行也可以登记进来回看，不复制运行目录：

```bash
"$ROOMCANVAS_HOME/runtime/litereality-env/bin/python" web/scripts/room_replay.py \
  --data-dir "$ROOMCANVAS_HOME/runs/web-room-jobs" --run '<运行目录，内含 pipeline/<场景>>' --name '<名称>'
```

一次运行目录常有几十 GB，大部分是回放用不到的物品建模中间文件。加 `--slim-to '<新目录>'` 会先把回放读取的文件（日志，包括 agent 以前会话的记录、检查结果、点云与布局、房间模型、配图、每次运行的 `exit`，保留文件时间）复制到新目录，再登记这份副本，原运行目录可以删除或留在别处。room3 的运行从 55 GB 减到 245 MB，回放内容与原目录一致。

登记的任务只用于回看，不进入房间列表；默认忽略最后一次检查两分钟之后写入的记录，`--until <Unix 时间>` 可指定截止时间。服务运行中登记也会被识别，无需重启。

### API 与验证

本机 `serve.py` 只转发以下接口到房间服务，并对写请求检查 Origin；大文件使用临时文件分块转发。

| 接口 | 用途 |
| --- | --- |
| `GET /room-reconstruction/health` | API 连通性，不代表所有模型依赖已经可用 |
| `POST /room-reconstruction/jobs` | 原始扫描包请求体（ZIP、tar 或 .tar.gz）；请求头 `X-Room-Name` 为 URI 编码名称，`X-Upload-ID` 为 32 位小写十六进制幂等 ID |
| `GET /room-reconstruction/jobs[/<任务号>]` | 任务列表或状态 |
| `POST /room-reconstruction/jobs/<任务号>/retry` | 重试失败任务 |
| `GET /room-reconstruction/catalog` | 已完成房间列表 |
| `GET /room-reconstruction/assets/<任务号>/<文件>` | 仅已发布的模型、物品清单和缩略图 |
| `GET /room-reconstruction/jobs/<任务号>/replay` | 重建过程：阶段、事件和已生成的房间模型 |
| `GET /room-reconstruction/jobs/<任务号>/replay/scaffold/(points.bin\|layout.json\|colors.bin)` | 扫描点云、物品框和点云颜色（首次请求时由扫描照片生成；没有照片时 404，页面改用按高度的渐变色） |
| `GET /room-reconstruction/jobs/<任务号>/replay/files/<相对路径>` | 运行目录里白名单内的模型和图片（物品图、各版房间模型、对比图），其余路径一律 404 |

离线测试不调用 GPU、模型或 Agent：

```bash
python3 -m unittest discover -s web/scripts
node --test web/scripts/test_room_reconstruction.mjs
```

## 运行

扫描输入必须已在服务器上，每个扫描目录含 `room.usdz`、`frame_*.jpg` 和相应相机／深度数据，格式见 [模块运行说明](../room-reconstruction/README.md#run)。如扫描在本机，**本机**，任意目录可上传到服务器上已存在的扫描父目录；先配置好 `~/.ssh/config` 别名或使用 `user@host`：

```bash
scp -r '<本机扫描目录的绝对路径>' '<SSH 主机>:<服务器扫描父目录的绝对路径>/'
```

**服务器上**，在 `RoomCanvas/` 根目录执行；每个新终端都重新设置 `ROOMCANVAS_HOME` 和 `PY`。检查输出确认路径和参数后，再执行正式命令：

```bash
export ROOMCANVAS_HOME='<环境与数据根目录的绝对路径>'
PY="$ROOMCANVAS_HOME/runtime/litereality-env/bin/python"
"$PY" room-reconstruction/server/run_room.py '<服务器扫描目录>' '<运行目录>' --check \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
"$PY" room-reconstruction/server/run_room.py '<服务器扫描目录>' '<运行目录>' \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

`--check` 不占 GPU，只核对当前仓库的包加载位置并打印配置，不验证所有依赖、权重或推理。正式运行自动选择空闲 GPU 并加锁，author 搭完后检查一次房间（家具支撑，再由独立模型对照照片判断是否通过，不打分），没通过就修一次，修好重建出的房间就是结果，不再复查，发布时也不再检查（`--repair-rounds 0` 只检查不修）；上面的模型和思考程度由命令行显式指定。

完整重建默认包含可动部件识别，成功产物在 `<运行目录>/articulate/room_preview/`；加 `--no-articulate` 可跳过这一步，此时使用 `<运行目录>/pipeline/<场景>/realism_authoring/room_preview/`。场景名以实际生成的 `scene.json` 所在目录为准。中断后用同一输入和运行目录重新执行可续跑。检查终端退出信息以及 `<运行目录>/attempt-*/pipeline.log`、`articulate.log` 和对应的 `exit`、`articulate-exit`；阶段失败时先看日志，不把目录存在当作重建成功。

### 路由偏好与沿用已有模型

重建同一房间的新扫描时，可以指定物品走哪条生成路线，并让部分物品直接沿用以前重建好的模型。以下变量都通过 `--set` 传入：

| 变量 | 作用 |
| --- | --- |
| `LR_ROUTE_POLICY=trellis-first` | 几乎所有物品用 TRELLIS 图生 3D；只有储物类（名称含 storage、cabinet、shelf、bookshelf、wardrobe，包括 `Sink_Storage0` 这类合并物品）和分类模型判为普通矩形的桌子（table、desk）走程序化建模。椅子组始终走 TRELLIS，门窗仍由门窗分支生成。不设时与以前相同，由分类模型判断。 |
| `LR_ROUTE_OVERRIDE=Table0=trellis,Storage1=procedural` | 按编号固定单个物品的路线，优先于上面的策略。路线只能是 `trellis` 或 `procedural`，编号必须是本次参与路由的物品或椅子组，否则报错。 |
| `LR_PROVIDED_MODELS='<目录的绝对路径>'` | 用已有模型代替生成：`<目录>/<编号>.glb` 是成品静态模型，`<目录>/<编号>/` 是程序化物品目录（一个 `*.glb` 加 `object.py`、`object.md`，可带 `previews/`、`textures/`），目录内文件名可以仍是旧编号。`<编号>` 必须是本次扫描的物品、椅子组或门窗编号，有不匹配的名字时直接报错并列出有效编号。 |
| `LR_PROVIDED_TURN=Table0=90` | 采用静态 `<编号>.glb` 时绕竖直轴转动给定角度（从上往下看逆时针为正），不适用于程序化目录。 |

分三步运行。所有阶段都传入同一组 `--set`：重建阶段的输入指纹包含这些变量和模型目录的内容，前后不一致会让重建阶段整体强制重跑（TRELLIS 和程序化物品全部重新生成），漏传 `LR_PROVIDED_MODELS` 时对应物品会被重新生成。

1. **服务器上**，按上文设置 `ROOMCANVAS_HOME` 和 `PY`，先只跑到物品检测：

   ```bash
   SETS=(--set LR_ROUTE_POLICY=trellis-first --set LR_PROVIDED_MODELS='<已有模型目录的绝对路径>' \
     --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high)
   "$PY" room-reconstruction/server/run_room.py '<服务器扫描目录>' '<运行目录>' --through ingest "${SETS[@]}"
   ```

2. 在 `<运行目录>/pipeline/<场景>/scene_init/obj_stage/object_init/` 下查看编号：`object_refs/<场景>/<编号>/reference_1024.png` 是物品，`chair_clusters/<场景>/chair_clusters.json` 列出椅子组，`opening_refs/<场景>/` 是门窗。按这些编号在模型目录中放入 `<编号>.glb` 或 `<编号>/`；需要时再加 `LR_ROUTE_OVERRIDE`、`LR_PROVIDED_TURN`，之后各阶段保持不变。

3. 从重建阶段继续：

   ```bash
   "$PY" room-reconstruction/server/run_room.py '<服务器扫描目录>' '<运行目录>' --from reconstruct --through publish "${SETS[@]}"
   ```

指定模型在重建阶段开始时复制到 `reconstructed_objs/`，来源记录在其中的 `provided.json`；TRELLIS、程序化和门窗分支以及椅子检查都不会重新生成这些物品，强制重跑时也一样。内容未变的模型重跑时不再复制。模型的水平长边会被放到新物品框短边上时，日志中出现 `[provided] WARNING`，列出两边的尺寸；确认是朝向不同后用 `LR_PROVIDED_TURN=<编号>=90` 转动静态模型。分类结果记录在 `object_init/routing/<场景>/routing.json`，参考图、策略和该物品的覆盖不变时，重跑沿用上次的判断，不再重新询问分类模型。

### 给建模 agent 的补充材料

重建以前做过的房间时，可以把补充材料放进一个目录交给 author：根目录放 `README.md`（写给 agent 的说明，例如哪些东西做成贴照片的平板、哪些小物件单独摆放），其余文件和子目录随意，例如上次重建的房间目录、近照及其说明。运行时加 `--set LR_AUTHOR_EXTRA=<该目录的绝对路径>`；目录里没有 `README.md` 时 author 直接失败。agent 在 `realism_authoring/evidence/operator/`（指向该目录的链接）看到它，各 provider 都可读取，任务说明里会多一段：先读 `README.md`，具体处照办；上次重建的东西只用来复用材质、纹理和部件代码，不用其坐标（新扫描的世界坐标系不同）。没有位姿的照片可用 `evidence/helpers/` 里的 `rectify.rectify_image(照片, 四角像素, 输出, 尺寸)` 拉正成墙上平板、画框、海报的纹理（角点按照片正常显示的方向取；HEIC 读不了，先转成 JPEG）。检查失败后的修复会话也会收到同一段说明。

这些材料不计入 author 的输入指纹和断点：author 跑过之后再改 `README.md` 或照片，不会让它重跑，也不会作废断点；trace 的 `session_start` 记下目录和内容哈希，可据此核对用的是哪一版。要让改动生效，只能让 author 从头开始；`run_room.py` 没有这个开关，可换一个新的运行目录。

会话上限用 `--set LR_CODEX_SESSION_SECONDS=<秒>`（默认 3600）和 `--set AUTHOR_STEPS=<工具调用次数>`（open 默认 300）。到达任一上限时 Codex 会话被结束，已保存的 `Room.py` 和断点保留，author 阶段报 `needs_repair` 而失败；用同样的参数重新执行即接着上次的房间开新会话。

要让小物件那一步重建某样东西，`README.md` 应要求 agent 把它做成单独一组（`group_fixture`），用描述性的驼峰名（如 `TissueBox0`、`Plant1`；小物件那一步按名字在扫描照片里找它），并声明 `rests_on`（桌面或地面），不要用 `attached_to` 挂在墙或天花板上，也不要标成可放东西的家具。挂墙的、类别为 `panel`、`socket`、`light` 等固定设施的，以及已有重建网格的物品都不会成为候选；叠放在另一个候选上并盖住它大半的物件会和它合成一组。

## 接入网页

`room_preview/` 中的主要产物是 `Room.glb`（网页模型）、`Room.blend`（建模源文件）和 `room_layout.json`（布局）。以下把选定的服务器结果复制到本机仓库的 `samples/my-room/`，再在本机生成清单；编辑器不直接读取服务器文件。

**本机**，准备 Git、Python 3 和 SSH 客户端，从准备存放源码的目录开始；已有本机仓库则直接进入 `RoomCanvas/`，省略克隆：

```bash
git clone https://github.com/innovationasuna/RoomCanvas.git
cd RoomCanvas
mkdir -p samples/my-room
scp -r '<SSH 主机>:<服务器结果目录>/room_preview' samples/my-room/
```

`<服务器结果目录>` 是上一节选定的 `room_preview/` 的父目录，例如 `<运行目录>/articulate`。这里的 `my-room` 是新房间名，已有同名目录时另选名字。

要保留开合部件，还要复制同一结果旁的 `room/Objects/`，其中含 `*/*/sim/*.urdf`。**本机**，在 `RoomCanvas/` 根目录执行（该目录存在且需要关节时）：

```bash
mkdir -p samples/my-room/room
scp -r '<SSH 主机>:<服务器结果目录>/room/Objects' samples/my-room/room/
```

保持复制后的目录层级，脚本会自动找到 `room_preview/` 旁的 `../room/Objects/`；若另存到其他位置，生成命令加 `--joints '<本机 Objects 目录>'`。上述 `scp -r` 会跟随目录中的符号链接复制实际文件；换用其他复制工具时，也要避免留下指向服务器路径的链接。没有关节文件仍能生成物品清单，但不会生成对应的开合数据。

**本机**，在 `RoomCanvas/` 根目录生成清单，只需 Python 标准库：

```bash
python3 web/scripts/room_objects.py samples/my-room/room_preview
```

脚本读取 `room_layout.json`，利用同目录的 `Room.glb` 检查节点，输出 `room_objects.json`；不会修改 GLB。检查输出的物品数、可动组数和关节数，并处理缺失节点或 `joint left out` 提示。

**本机**，编辑 `RoomCanvas/web/rooms.json`，在现有 `rooms` 数组中追加以下对象，保留原条目并补齐逗号；`dir` 相对 `web/`，不是相对仓库根目录：

```json
{"id": "my-room", "name": "我的房间", "dir": "../samples/my-room/room_preview", "note": "手机扫描重建的房间"}
```

**本机**，在 `RoomCanvas/` 根目录启动网页：

```bash
python3 web/scripts/serve.py
```

打开 <http://127.0.0.1:7880/web/editor/?room=my-room>，确认模型、家具移动和部件开合正常。主页缩略图读取房间目录的 `thumbnail.jpg`，不影响编辑器加载；生成方法和文件格式见 [房间文件](../web/README.md#房间文件)。若要同时添加或导入照片重建的物品，改用 [带 SSH 隧道的启动方式](OBJECT_RECONSTRUCTION.md#在编辑器中使用)。

## 小物件

对已有房间中的书、拖鞋、枕头等物品，挑选照片、判断是否需要重建，再用 TRELLIS 生成模型并放回原处。单独运行，不重跑房间建模：

**服务器上**，在 `RoomCanvas/` 根目录，按 [运行](#运行) 设置 `ROOMCANVAS_HOME` 和 `PY` 后执行；输入是含 `scene.json` 的已有场景目录：

```bash
"$PY" room-reconstruction/server/run_room.py --small-objects '<运行目录>/pipeline/<场景>' '<新目录>' --check
"$PY" room-reconstruction/server/run_room.py --small-objects '<运行目录>/pipeline/<场景>' '<新目录>'
```

结果在 `<新目录>/room_preview/`，包含 `Room.blend`、`Room.glb` 和 `room_layout.json`；`overview.jpg` 提供照片与重建前后的对比。按上面的接入方式导入网页后，小物件可单独移动，放在家具上的物件会随家具移动。

加 `--through evidence` 只找候选和扫描照片里的证据，不调用判断模型、不改房间；`<新目录>/candidates.md`（终端也会打印）列出每个候选的 id、author 里对应的物件名、类别、证据数和证据目录。下面的变量都用 `--set` 传入，可选：

| 变量 | 作用 |
| --- | --- |
| `LR_SMALL_OBJECTS_POLICY=trellis-first` | 尽量用 TRELLIS 重建：只有任何图里都看不出来才删，只有规整到 TRELLIS 帮不上忙的才保留原模型；不设时判断标准不变 |
| `LR_SMALL_OBJECTS_FORCE=<id>=trellis,<id>=procedural,<id>=drop` | 逐个覆盖判断结果（仍会问一次，用于取得重建所需的描述）；id 不在候选里时报错 |
| `LR_SMALL_OBJECTS_PHOTOS=<目录>` | `<目录>/<id>/*.jpg` 是该物件的近照，交给判断模型，并作为参考图的前几格；扫描里看不到但有近照的物件也会被判断 |
| `LR_SMALL_OBJECTS_MODELS=<目录>` | 预先做好的模型（见下）：id 为 `<种类>` 或 `<种类>` 加数字的物件（`TissueBox0`、`TissueBox12`）直接用 `<目录>/<种类>.glb`，`<目录>/<id>.glb` 优先；不问判断模型、不生成参考图、不启动 TRELLIS，扫描里看不到也照样替换，之后和自己重建的一样贴合原位置、朝向并放回房间。记录里 `decision` 带 `forced` 和 `source`，`small_object_done` 带 `source`；换了某个模型只重做用它的物件；目录里没有对应物件的模型只在日志里列一次；目录不存在时报错 |

近照和策略按物件记在它自己的输入里：重建前放进去就会用上，重建后再加或换某个物件的近照，只重新判断、重建这一个，其他物件和整个结果不作废。完整流程建议两步：先 `--through evidence` 看 `candidates.md`，按 id 整理近照，再去掉 `--through` 正式运行。每次运行在场景的 `trace.jsonl` 里记下 `small_objects_start`、每个物件定下结果时的 `small_object_done`（`method` 为 `trellis`、`procedural`、`dropped` 或 `kept`，沿用上次结果时 `reused` 为 true，时间仍是这次的）和 `small_objects_done`（重建、删除、保留的件数）；完整跑完时 `run_room.py` 再记 `model_saved`（`model` 为 `small_objects`）。

### 预先做好小物件模型

小物件这一步在 author 之后才跑，而 author 要几个小时；TRELLIS 要用 GPU。已经知道房间里有哪些小东西（在 author 的说明里让它按 `TissueBox0`、`WaterBottle0`、`PotPlant0` 等命名占位）时，可以在 author 之前先用近照把模型做好，GPU 随即可以交还，几小时后小物件这一步直接用这些模型，不再需要 TRELLIS：

```bash
"$PY" room-reconstruction/server/run_room.py --premake-small-objects '<近照目录>' '<模型目录>' --check
"$PY" room-reconstruction/server/run_room.py --premake-small-objects '<近照目录>' '<模型目录>' [--only TissueBox ...]
```

近照按种类分目录：`<近照目录>/<种类>/*.jpg`（或 `.jpeg`），例如 `TissueBox/`、`WaterBottle/`，同一种类的几件（两包纸巾）共用一个模型；可选 `<近照目录>/<种类>/description.txt`，一行写这是什么，没有时按种类名写成 “a tissue box”。每个种类走小物件重建的同一套步骤，只去掉需要房间的部分：近照拼成参考底图、图像模型生成参考图（设置取服务器 `.env`）、TRELLIS（经 `run_room.py` 取得 GPU 和 TRELLIS 环境）、去掉漂浮碎片、按参考图校正色相并把非金属物件的金属度归零。结果是 `<模型目录>/<种类>.glb`，旁边的 `<种类>.json` 记下近照哈希、描述和模型设置；重跑时输入没变的种类直接跳过，换了近照的重做。失败的种类不留下 `.glb`，命令以非零退出；终端打印每个种类用了几张近照、结果路径和用时。运行记录在 `<模型目录>/attempt-NN/`，不写回放记录。之后跑小物件时加 `--set LR_SMALL_OBJECTS_MODELS=<模型目录>`；这一步仍经 `run_room.py` 取 GPU（扫描照片里找物件、渲染对比图），只是这些物件不再跑 TRELLIS。

## 可动部件

识别已有模型中的门、抽屉、盖子等部件，切分模型并添加关节和开合动画，再检查开合效果。完整重建会自动执行，也可对已有房间单独运行：

**服务器上**，在 `RoomCanvas/` 根目录，按 [运行](#运行) 设置 `ROOMCANVAS_HOME` 和 `PY` 后执行：

```bash
"$PY" room-reconstruction/server/run_room.py --articulate '<运行目录>/pipeline/<场景>' '<新目录>' --check \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
"$PY" room-reconstruction/server/run_room.py --articulate '<运行目录>/pipeline/<场景>' '<新目录>' \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

结果在 `<新目录>/room_preview/`，包含 `Room.blend`、`Room.glb` 和 `room_layout.json`；`overview.jpg` 展示开合对比。按 [接入网页](#接入网页) 将该目录及 `<新目录>/room/Objects/` 复制到本机，再生成 `room_objects.json`，即可在编辑器中操作可动部件。

单独运行时也和完整重建一样记下 `articulate_start`、`articulate_done` 和 `model_saved`（`articulated`）；加了 `--through` 或 `--only` 的运行不出房间，不记。回放按固定位置 `<运行目录>/articulate/room_preview/Room.glb` 找这个房间，所以 `<新目录>` 用 `<运行目录>/articulate`。

要让发布的房间带上小物件，顺序是 author（加 `--no-articulate`）→ 小物件 → 可动部件，小物件结果放在 `<运行目录>/small-objects`，可动部件加 `--set LR_ARTICULATE_SOURCE=<运行目录>/small-objects/room_preview`：它读这个房间（`Room.blend`、`Room.glb`、`room_layout.json` 及小物件的网格），部件关节仍写在 author 房间的 `Objects/` 旁。该目录必须是小物件完整跑完的结果，且由当前的 author 房间生成，否则报错；换了来源房间，可动部件这一步整体重做。不会自动改用小物件的结果，免得用到过期的房间。
