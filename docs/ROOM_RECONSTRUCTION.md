# 房间重建

把手机扫描（iPhone LiDAR + RoomPlan）重建成真实尺寸、带纹理的 `Room.glb`，再接入网页编辑器。代码在 [`room-reconstruction/`](../room-reconstruction/)：多个 Agent（Codex / GPT-6 Astra）看图分工，完成房间结构、家具建模与摆放、质量检查，随后逐件重建小物件、识别能打开的部件。

## 运行环境

重建在 Linux GPU 服务器上运行。`room-reconstruction/server/run_room.py` 运行当前 checkout 中的代码，运行环境、模型权重和私有配置从 `ROOMCANVAS_HOME` 读取：

```text
$ROOMCANVAS_HOME/
├── .env                    API 密钥和图像生成设置（不进仓库）
├── runtime/
│   ├── litereality-env/    重建主环境
│   ├── trellis-env/        TRELLIS.2 与 Grounding DINO 环境
│   ├── blender/            Blender 5.1
│   └── cuda-12.4/
└── backends/
    ├── TRELLIS.2/
    └── weights/            LiteReality、DINOv3、Grounding DINO、DINOv2 等权重
```

下文用 `$PY` 指代 `$ROOMCANVAS_HOME/runtime/litereality-env/bin/python`。

## 运行

```bash
$PY room-reconstruction/server/run_room.py <扫描输入> <新的运行目录> --check   # 只检查配置，不占用 GPU
$PY room-reconstruction/server/run_room.py <扫描输入> <新的运行目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

`run_room.py` 会：

- 自动选择一张空闲 GPU 并加锁；
- author 视觉验收后默认返工 1 轮（`--repair-rounds` 可调，0 表示只验收不返工）；
- 确认加载的是当前 checkout 的代码，并把生效配置记录到运行目录（不记录密钥）；
- 建模阶段写出房间后，默认接着运行[可动部件](#可动部件)这一步，结果在 `<运行目录>/articulate/room_preview/`，网页使用这一份。不需要时加 `--no-articulate`。

中断后重新运行同一命令会从中断处继续。

## 接入网页

重建完成后，为 `room_preview/` 生成网页使用的物品清单 `room_objects.json`（物品分组、名字、可开合的部件）：

```bash
python3 web/scripts/room_objects.py <room_preview 目录>
```

再把房间目录（`Room.glb` + `room_objects.json` + `thumbnail.jpg`）加入 `web/rooms.json`，见 [网页编辑器](../web/README.md#房间文件)。

## 小物件

author 阶段的小物件（书、拖鞋、袋子、枕头……）由 Blender 基本形状拼成。这一步读取 author 产出的 `Room.blend`，逐件决定舍弃、保留，还是用 TRELLIS 重新生成，不重跑 author：

```bash
$PY room-reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录> --check
$PY room-reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录>
```

1. **挑选候选**：author 添加的、能拿起来挪动的东西。不包括房间结构、门窗、重建出的家具、插座开关灯等固定设施、挂在墙上或天花板上的东西，以及能放东西的家具。没有尺寸阈值；叠在一起的（一摞书）合为一件。
2. **找照片**：按相机投影挑选能看到它的帧，用 Grounding DINO 在投影附近确认，优先清晰的帧，裁剪并转正；再从同一相机渲染当前模型，与照片并排。
3. **Astra 逐件判断**（每件一次）：
   - **舍弃**：太小、看不清、不重要，或怎么建都不会像；
   - **程序化**：当前模型已经足够像，保留；
   - **TRELLIS**：软的、有褶皱的、形状复杂且照片清楚的。

   提示词中附有一些经验规律供参考，不作为硬性规则。
4. **TRELLIS 重建**：证据图 → gpt-image-2 参考图 → TRELLIS → 去除碎片，按原物件的位置、高度和朝向（俯视最小外接矩形）放回原处，保持新模型自身比例，正面朝向拍得最清楚的相机。
   - 显存不足的物件单独隔离，改用 512 分辨率重试；仍然失败的保留原模型，重新运行同一命令会补做。
   - 生成后修正材质：布、纸、塑料等的金属度归零；单一主色的物件，如果贴图色相与参考图相差 8° 以上，则整体校正回去。多种颜色的东西（一摞书）不做校正。
5. **对比图**：用同一相机渲染“照片 | 原模型 | 重建”三联图，汇总到 `overview.jpg`，供人工检查。

结果在 `<新目录>/room_preview/`（`Room.blend`、`Room.glb`、`room_layout.json`，重建的物件标有 `"rebuilt": "trellis"`）。每件的照片、渲染对比、Astra 的回答和费用记录在 `items.json`、`summary.md`、`overview.jpg`。重建的物件在网页里可以单独移动，放在家具上的会随家具移动。

## 可动部件

建模阶段会按类别给门窗、有门的柜子、升降桌等加上关节。可动部件这一步在此基础上进一步识别其他物品上的门、抽屉和盖子：读取 author 的 `Room.blend`，由 Astra 判断哪些东西能打开，直接切分现有模型并装上合页或滑轨，不重新生成模型。完整重建默认会在最后自动运行；也可以对已有的运行单独执行：

```bash
$PY room-reconstruction/server/run_room.py --articulate runs/<运行>/pipeline/<场景> <新目录> --check
$PY room-reconstruction/server/run_room.py --articulate runs/<运行>/pipeline/<场景> <新目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
# 只试几件：--only Pedestal0 Laptop0（不写最终房间）；只出图、不调用模型：--through views
```

1. **挑选候选**：家具和房间里的物品，不包括房间结构、门窗、固定设施、挂在其他物体上的附件（门上的衣服、显示器的线），以及最长边不到 20 厘米的东西。已经有关节的也纳入，并告诉 Astra 哪些部件已经能动，只询问缺少的。
2. **出图**：每件单独渲染，使用它自身的坐标系（原点和朝向取自它在房间中的位置，单位米，Z 朝上）：正视、侧视两张带米制刻度的正交图，以及从四个斜角看的透视图；再按相机投影裁出 3 张照片。
3. **Astra 判断**（每件一次）：对照照片判断真实物体有没有会被打开的部件（门、抽屉、盖子、屏幕、翻板；瓶盖这类取下来的不算），在模型中找到它，给出范围框、转轴或滑动方向、开合幅度、模型中当前是开还是合，以及合上时后面是否中空。模型里没有能切出来的面就回答“没有”，不猜测。范围框和转轴都对齐到坐标轴；离物体外表面 1.5 厘米以内的框边推到外面，避免留下一条边。
4. **切开**：按范围框切下面片合成一个部件，原点放在转轴上（滑动部件放在框中心），挂到新的 `<物体>_Hinges` 节点下。合上时后面中空的部件补一个深色内腔；抽屉再在前脸后面补一个开口朝上的屉体随之滑动；并加一段“合上 → 全开 → 合上”的动画供 App 使用。
5. **检查**（每件一次）：把四个斜角的“合上”和“打开”图与照片一起交给 Astra，只保留开合正确的部件。
6. **写出结果**：从 author 的 `Room.blend` 重新切出保留的部件，写到 `<新目录>/room_preview/`（`Room.blend`、`Room.glb`、原样的 `room_layout.json`）；每件的关节写成 `<新目录>/room/Objects/Articulated/<物体>/sim/<物体>.urdf`，原运行的 `room/Objects` 链接在旁边，因此 `python3 web/scripts/room_objects.py <新目录>/room_preview` 能一次读到全部关节。

过程记录在 `items.json`、`summary.md`、`overview.jpg`（照片 | 合上 | 打开）。

## 实现说明

| 模块 | 位置 |
| --- | --- |
| 看图判断：所有 Agent 使用 Codex（GPT-6 Astra），在建模路线分类、椅子分组、程序化完整性检查和布局中参考照片与渲染图 | `agent/providers/codex.py`、`vision.py` |
| 运行脚本：选卡加锁、记录配置、断点续跑 | `room-reconstruction/server/` |
| 小物件重建 | `pipeline/realism_authoring/small_objects/` |
| 可动部件识别 | `pipeline/realism_authoring/articulate/` |

运行参数以本文为准；`room-reconstruction/` 下的 README、ARCHITECTURE 介绍底层流程的通用配置。相关工作见 [README 的致谢](../README.md#致谢)。
