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

房间选择页右上角的 **重建房间** 接受一个房间的完整扫描包：LiteReality Scanner 导出的 tar 可以直接上传，也可以是 ZIP 或 `.tar.gz`（最大 2 GB，解压后最大 8 GB / 50,000 个文件；按文件开头判断格式，不看扩展名）。扫描需要包含 `room.usdz`（也可以在 `roomplan/` 中）、`frame_*.json` 相机数据、`depth_*.png` 深度数据，以及图像帧或 `frames.mp4`；扫描 App 导出的 `pointcloud.pcd` 可一起放入（重建优先使用它）；支持外面套一层房间文件夹。这里只接收扫描数据，不接收普通照片集或已生成的场景包。

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

用 uv 直接安装的环境（例如 macOS + Modal）可选择 `--runner cli --pipeline-dir /path/to/RoomCanvas/room-reconstruction`，此模式调用 `uv run --no-sync litereality run ... --through publish`，使用该环境已有的模型配置，不包含服务器专用可动部件后处理；部署方负责 GPU 资源协调。默认 `server` 模式沿用本项目已有的运行器。

### 使用与结果

- 填写房间名称，选择或拖入扫描包（tar 或 ZIP），点击 **上传并开始重建**。服务未连接时仍显示入口和扫描要求，但不能提交。
- 上传百分比只表示文件传输进度。提交后显示实际流水线阶段，不估算重建完成百分比；同一 API 服务一次运行一个任务。
- 提交成功后可关闭窗口或刷新网页，任务继续运行。任务记录保存在 `--data-dir`，失败可重试并复用已有阶段；同一次上传的重复提交不会创建重复任务。
- 服务重启会恢复排队任务，并把未完成任务标记为需重试。上次进程仍运行时，任务文件锁阻止重复执行。超时默认 6 小时，可用 `--timeout <秒>` 修改。
- 完成后自动运行 `room_objects.py`，校验 GLB 节点与布局，再发布 `Room.glb`、`room_objects.json` 和可选的 `thumbnail.jpg`。没有缩略图时显示“房间预览暂不可用”，不影响进入布置。
- 新房间通过动态目录加入首页，不改写仓库中的 `web/rooms.json`。读取新房间仍需重建服务及隧道在线；后端离线不影响原有示例房间。
- 原始扫描、运行输出及日志留在服务器的数据目录，不要放进 Git。失败详情看 `<任务号>/task.log`；默认运行器的阶段日志在 `<任务号>/run/attempt-*/`。网页不提供任意服务器路径或日志读取接口。

### 查看重建过程

首页“房间重建任务”里，正在重建的任务有 **实时查看**，结束的任务有 **查看过程**，都打开 `web/replay.html?job=<任务号>`：

- 左栏按 11 个阶段列出重建记录并配图，右边三维视图随过程变化：先是扫描点云（每个点的颜色取自扫描时拍的照片，按深度图判断是否被遮挡）从房间中间向四周展开，再出现物品框；制作物品时房间的墙和地面先出现，物品做好一件，镜头就推近到它跟前（选没有别的物品挡着的方向），到位后物品表面亮起与它同色的细密点云，蓝色线框从下往上扫过，实体紧跟着填满（约 3 秒，左下角显示三角面数），没做的留线框；建模 agent 后加的部件也这样出现。拖动时间轴时直接显示结果，系统开启“减少动态效果”时不播放；之后依次换成初版房间、检查时的房间、最终房间和装好可开合部件的房间（发布的就是这一版；新模型约 2 秒淡入，实时查看时模型还没写完导致加载失败会 5 秒后再试）。实时查看建模时，正在改的房间也会显示，最多每 5 分钟换一次新版本（模型约 90 MB），记下最终房间后换成最终房间；左栏和结尾只说检查是否通过、是否修过，不显示分数。过程中失败的尝试和报错（如某件物品这次没做成）不在页面上显示，只留在日志里；任务本身没跑完时结尾显示“重建还没完成”（不标红），提示在任务列表里重试。底部时间轴可拖动、单步，时钟显示真实用时。
- 已完成任务的回放文件由本机 `serve.py --ssh` 在后台下载到 `runs/room-cache/`，下载完后从本机读取，服务器关机也能看（见 [README](../README.md) 的服务器启动说明）。
- 重建中每 5 秒取一次新记录并停在最新处；往回拖可以看之前的步骤，点 **回到最新** 继续跟随。结束后从头自动播放。播到最后（房间建好）时换成与房间预览相同的“物理光照”（直接调用编辑器的 `web/editor/time-lighting.mjs`，那边调整后回放跟着变），往回拖则回到回放自己的光照。回放按真实用时等比例排布（时钟显示真实时间），长时间没有新进展的等待会压缩，每件物品成形至少留 4.5 秒，读取扫描至少 6 秒；整体一般 90 秒左右，物品多时相应变长。
- 记录来自运行目录里流水线自己写的文件：`scene_init/obj_stage/traces/` 下的 `trace.jsonl`、建模 agent 的 `authoring_trace.*.jsonl`，以及 `realism_authoring/acceptance/` 的检查结果。新的重建还会在 `trace.jsonl` 里记下回放按真实时间排布所需的时间点：每件物品做好的时间（`object_done`，AI 重建和程序建模都有，建模过程中一做好就记，便于实时查看）、椅子形状没通过后的重新生成（`chair_qc_retry`、`chair_qc_restored`）、初版房间／检查时的房间／最终房间／装好可开合部件的房间的保存时间（`model_saved`，`seed`/`round`/`final`/`articulated`）、检查结论（`review_done`，通过与否）、修复开始和结果（`repair_start`、`repair_done`，修复 agent 的操作另记在 `authoring_trace.repair.jsonl`）、可开合部件这一步的开始和结果（`articulate_start`、`articulate_done`）、建模 agent 每次编译房间新增的部件（`room_built`），以及每次运行的编号（`run`，`run_room.py` 用 `attempt-NN`，重试时回放会标出“重新开始重建”，检查次数按每次运行分别计）。有了这些记录，房间模型只按记录的时间出现：建模 agent 工作时会反复改写最终房间的文件，不再因此提前显示“导出最终房间”。没有这些记录的旧任务仍按文件时间和 agent 日志推断。流水线阶段用固定的中文说明；建模 agent 的操作由重建服务按批交给 Codex（默认 `gpt-6-astra`、思考程度 `low`）概括成白话，结果缓存在 `<任务号>/replay/summary.json`，回看不再调用模型。概括出来之前先显示按时间合并的简要说明。
- 概括使用 `$ROOMCANVAS_HOME/runtime/bin/codex`（没有时用 PATH 里的 `codex`）。模型和思考程度可用环境变量 `LR_REPLAY_MODEL`、`LR_REPLAY_EFFORT` 修改，`LR_REPLAY_CODEX` 指定其他命令；启动服务时加 `--no-replay-summary` 则不调用模型，只用简要说明。调用失败写入 `<任务号>/replay-error.log`，5 分钟后重试。

以前用命令行跑完的运行也可以登记进来回看，不复制运行目录：

```bash
"$ROOMCANVAS_HOME/runtime/litereality-env/bin/python" web/scripts/room_replay.py \
  --data-dir "$ROOMCANVAS_HOME/runs/web-room-jobs" --run '<运行目录，内含 pipeline/<场景>>' --name '<名称>'
```

一次运行目录常有几十 GB，大部分是回放用不到的物品建模中间文件。加 `--slim-to '<新目录>'` 会先把回放读取的文件（日志、检查结果、点云与布局、房间模型、配图，保留文件时间）复制到新目录，再登记这份副本，原运行目录可以删除或留在别处。room3 的运行从 55 GB 减到 245 MB，回放内容与原目录一致。

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
