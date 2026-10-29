# 房间重建

房间重建模块把 iPhone LiDAR + RoomPlan 扫描生成真实尺寸、带纹理的 `Room.glb`，供网页编辑器浏览和调整家具布局。流程包括房间结构重建、家具建模与摆放、视觉检查，并支持小物件重建和可动部件识别。

## 运行环境

在 Linux GPU 服务器上准备环境，设置 `ROOMCANVAS_HOME` 指向环境和数据根目录。该目录下的 `.env` 保存 API 密钥和图像生成设置；`runtime/` 存放 `litereality-env/`、`trellis-env/`、`blender/` 和 `cuda-12.4/`，`backends/` 存放 `TRELLIS.2/` 与 `weights/`。

## 安装

1. 准备 Linux、至少 24 GB 显存的 NVIDIA GPU、uv 和已登录的 Codex CLI。Python 范围及依赖以 [`pyproject.toml`](../room-reconstruction/pyproject.toml) 为准。在 `room-reconstruction/` 下按 [Install](../room-reconstruction/README.md#install) 安装主环境：

   ```bash
   uv sync --frozen --extra modal --group dev
   ```

2. 将生成的 `.venv` 链接到 `$ROOMCANVAS_HOME/runtime/litereality-env`；按 [本地 GPU 安装](../room-reconstruction/deploy/local-gpu.md) 安装 TRELLIS.2、CUDA 扩展和检测依赖。`backends/TRELLIS.2` 放在 `$ROOMCANVAS_HOME` 下；本页的运行脚本默认由 `runtime/trellis-env/bin/python` 同时执行生成和检测。
3. 按 [`run_room.py`](../room-reconstruction/server/run_room.py) 配置运行目录：Blender 位于 `runtime/blender/blender-5.1.2-linux-x64/`，CUDA 库位于 `runtime/cuda-12.4/lib/`；检测权重放在 `backends/weights/grounding-dino-tiny/` 和 `dinov2-small/`。生成模型按 [`trellis_local.py`](../room-reconstruction/server/trellis_local.py) 放在 `backends/weights/` 下的 `trellis2/`、`dinov3/` 和 `sparse-decoder/`。
4. 参考 [环境模板](../room-reconstruction/.env.example) 创建 `$ROOMCANVAS_HOME/.env`，填写 API 密钥和图像生成设置。本地 GPU 模式保持 Modal 令牌为空且不设置 `MODAL_PROFILE`。完成后回到仓库根目录，设置解释器并执行下一节的 `--check`：

   ```bash
   PY="$ROOMCANVAS_HOME/runtime/litereality-env/bin/python"
   ```

下文从仓库根目录执行；脚本使用当前仓库中的代码。

## 运行

```bash
$PY room-reconstruction/server/run_room.py <扫描输入> <新的运行目录> --check   # 只检查配置，不占用 GPU
$PY room-reconstruction/server/run_room.py <扫描输入> <新的运行目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

脚本自动选择空闲 GPU 并加锁。完整重建默认包含可动部件识别，最终房间在 `<运行目录>/articulate/room_preview/`；加 `--no-articulate` 可跳过这一步。中断后重新运行同一命令会从中断处继续。

## 接入网页

`room_preview/` 中的主要产物是 `Room.glb`（网页模型）、`Room.blend`（建模源文件）和 `room_layout.json`（布局）。为最终结果生成编辑器物品清单：

```bash
python3 web/scripts/room_objects.py <room_preview 目录>
```

将房间目录（`Room.glb` + `room_objects.json` + `thumbnail.jpg`）加入 `web/rooms.json`，配置方式见 [网页编辑器](../web/README.md#房间文件)。编辑器可读取物品分组和关节，让用户移动家具、开合部件。

## 小物件

对已有房间中的书、拖鞋、枕头等物品，挑选照片、判断是否需要重建，再用 TRELLIS 生成模型并放回原处。单独运行，不重跑房间建模：

```bash
$PY room-reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录> --check
$PY room-reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录>
```

结果在 `<新目录>/room_preview/`，包含 `Room.blend`、`Room.glb` 和 `room_layout.json`；`overview.jpg` 提供照片与重建前后的对比。按上面的接入方式导入网页后，小物件可单独移动，放在家具上的物件会随家具移动。

## 可动部件

识别已有模型中的门、抽屉、盖子等部件，切分模型并添加关节和开合动画，再检查开合效果。完整重建会自动执行，也可对已有房间单独运行：

```bash
$PY room-reconstruction/server/run_room.py --articulate runs/<运行>/pipeline/<场景> <新目录> --check
$PY room-reconstruction/server/run_room.py --articulate runs/<运行>/pipeline/<场景> <新目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

结果在 `<新目录>/room_preview/`，包含 `Room.blend`、`Room.glb` 和 `room_layout.json`；`overview.jpg` 展示开合对比。使用该目录重新生成 `room_objects.json`，即可在编辑器中操作可动部件。
