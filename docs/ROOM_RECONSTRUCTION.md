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

也可直接运行 [`bash room-reconstruction/server/setup.sh`](../room-reconstruction/server/setup.sh)。脚本按仓库中的 [Dockerfile](../room-reconstruction/deploy/modal/trellis/Dockerfile) 和 [扩展构建配置](../room-reconstruction/deploy/modal/trellis/app.py) 安装：主环境在 `runtime/litereality-env/`，CUDA 12.4、Blender 5.1.2 和 TRELLIS 环境也放在 `runtime/`；源码与权重放在 `backends/`。稀疏解码器只下载所需的 JSON 和 safetensors 两个文件。设置 `MODEL_SOURCE=modelscope` 时，TRELLIS.2、稀疏解码器、Grounding DINO 和 DINOv2 改从 ModelScope 下载；固定版本的 DINOv3 仍从 Hugging Face 下载。官方 Blender 下载站访问不了时，把 `BLENDER_ARCHIVE_URL` 设为官方镜像上的同一文件（例如 `https://mirrors.aliyun.com/blender/release/Blender5.1/blender-5.1.2-linux-x64.tar.xz`），脚本会按官方 SHA256 校验。TRELLIS 构建使用独立临时目录并保留现场；若上游使用固定 `/tmp/extensions` 且该路径已存在，会先停止，需核对其归属后处理。

完成标记 `.roomcanvas-setup-complete` 只在文件与依赖检查通过后写入。重跑同一命令会跳过已完成步骤、恢复带 `.roomcanvas-setup-incomplete` 的步骤；无标记的已有目录只验证，不补装或覆盖，验证失败时停止并提示路径。不要给已有目录手工补标记来绕过检查。

脚本仅在缺失时生成 `$ROOMCANVAS_HOME/.env`。填写 `OPENAI_API_KEY`；使用 Gemini 时填写 `GEMINI_API_KEY` 并设 `LR_IMAGE_PROVIDER=gemini`，同时填写扫描父目录 `LR_SCANS_DIR`。本地运行保持 `.env` 和启动终端中的 `MODAL_TOKEN_ID`、`MODAL_TOKEN_SECRET`、`MODAL_PROFILE` 为空，设置 `LR_DINO_BACKEND=local`。Blender、生成与检测解释器路径由 [`run_room.py`](../room-reconstruction/server/run_room.py) 设置。

后续更新前先等重建结束。**服务器上**，在仓库根目录更新源码；只刷新主环境依赖时仍使用同一个环境目录：

```bash
git pull --ff-only
UV_PROJECT_ENVIRONMENT="$ROOMCANVAS_HOME/runtime/litereality-env" \
  uv sync --project room-reconstruction --frozen --python 3.11 --extra modal
```

安装失败后直接重跑 `sh scripts/setup_server.sh rooms`。已有完整环境的模型版本或编译依赖需要变更时，先核对脚本配方，再选择新的 `ROOMCANVAS_HOME` 安装；完成标记不会自动触发升级。

实测情况：2026-11-03 在 RTX 3090 服务器上对已有环境运行 `scripts/setup_server.sh all`，各组件按已有目录只做检查，全部通过；2026-10-30 在 RTX 4090 服务器（Ubuntu 26.04，无 sudo）从零安装，主环境、CUDA 12.4 和 Blender 已装好并通过检查。TRELLIS.2 编译和模型下载的全新安装尚未实测；安装脚本不运行 GPU 推理。

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

`--check` 不占 GPU，只核对当前仓库的包加载位置并打印配置，不验证所有依赖、权重或推理。正式运行自动选择空闲 GPU 并加锁，默认执行一次 author 修复（`--repair-rounds 1`）；上面的模型和思考程度由命令行显式指定。

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

保持复制后的目录层级，脚本会自动找到 `room_preview/` 旁的 `../room/Objects/`；若另存到其他位置，生成命令加 `--joints '<本机 Objects 目录>'`。上述 `scp -r` 会跟随目录中的符号链接复制实际文件；换用其他复制工具时，也要避免留下指向服务器路径的链接。没有关节文件仍能生成家具清单，但不会生成对应的开合数据。

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
