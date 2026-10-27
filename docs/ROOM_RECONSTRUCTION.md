# 房间重建（LiteReality + Astra）

把手机扫描（iPhone LiDAR + RoomPlan）重建成真实尺寸、带纹理的 `Room.glb`，再接到网页编辑器上。代码在 [`room-reconstruction/`](../room-reconstruction/)（LiteReality-Agent 官方代码，Agent 改用 Codex / GPT-6 Astra，改动见下文[对 LiteReality-Agent 改了什么](#对-litereality-agent-改了什么)）。在 3090 服务器上运行，目录和环境见 [交接文档](HANDOFF.md)。

## 运行

```bash
PY=/workspace/geyinuo/RoomCanvas/runtime/litereality-env/bin/python
$PY room-reconstruction/server/run_room.py <扫描输入> <新的运行目录> --check   # 只检查配置，不占卡
$PY room-reconstruction/server/run_room.py <扫描输入> <新的运行目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
```

`run_room.py` 会：

- 自动挑一张空闲 GPU 并加锁；
- author 视觉验收后的返工默认只做 1 轮（官方默认 2 轮，`--repair-rounds 0` 只验收不返工）；
- 确认加载的是本仓库的代码，把配置记进运行目录（不记密钥）；
- 建模阶段写出房间后，**默认接着跑“可动部件”这一步**（见下文），结果在 `<运行目录>/articulate/room_preview/`，网页用这一份；建模阶段自己的 `room_preview/` 和发布出来的房间不带新切的部件。不要就加 `--no-articulate`；中断后重跑同一命令会接着做。

运行环境、模型权重和 `.env` 在服务器的 `ROOMCANVAS_HOME`（默认 `/workspace/geyinuo/RoomCanvas`）。

## 接到网页

重建完成后，给 `room_preview/` 生成网页用的物体清单 `room_objects.json`（家具分组、名字、能开合的门和柜门）：

```bash
python3 web/scripts/room_objects.py <room_preview 目录>
```

再把房间目录（`Room.glb` + `room_objects.json` + `thumbnail.jpg`）加进 `web/rooms.json`，见 [网页说明](../web/README.md)。

## 小物件：舍弃、程序化或 TRELLIS

author 阶段的小物件（书、拖鞋、袋子、枕头……）都是 Blender 基本形状拼的。这一步读 author 产出的 `Room.blend`，不重跑 author：

```bash
$PY room-reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录> --check
$PY room-reconstruction/server/run_room.py --small-objects runs/<运行>/pipeline/<场景> <新目录>
```

1. **挑候选**：author 加的、能拿起来挪动的东西。不含房间结构、门窗、重建出来的家具、插座开关灯等固定设施、挂在墙上或天花板上的东西、能放东西的家具。没有尺寸阈值。叠在一起的（一摞书）合成一件。
2. **找照片**：按相机投影挑能看到它的帧，Grounding DINO 在投影附近确认，优先清晰的，裁图转正；再从同一相机渲染当前模型，和照片并排。
3. **Astra 逐件三选一**（每件只问一次）：
   - **舍弃**：太小、看不清、不重要，或怎么建都不会像；
   - **程序化**：当前模型已经像，保留；
   - **TRELLIS**：软的、有褶皱的、形状复杂且照片清楚的。

   实验里观察到的规律作为参考写进提示词，不是硬规则。
4. **TRELLIS 重建**：证据图 → gpt-image-2 参考图 → TRELLIS → 去掉碎片，按原物件的位置、高度和朝向（俯视最小外接矩形）放回原处，基本保持新模型自身比例，正面朝向拍得最清楚的相机。
   - 某件显存不够时单独隔离，改用 512 分辨率再试；仍失败的保留原模型，重跑同一命令会补做。
   - 生成后修正材质：布、纸、塑料等的金属度归零（TRELLIS 会给布包猜出 0.4 的金属度）；单一主色的物件，如果贴图色相和参考图差 8° 以上，就整体转回去（TRELLIS 曾把品红色的包固定生成成正红，换种子也一样）。多种颜色的东西（一摞书）不转。
5. **对比图**：同一相机渲染“照片 | 原模型 | 重建”三联图放进 `overview.jpg`，供人检查；不再让 Astra 二次检查。

结果在 `<新目录>/room_preview/`（`Room.blend`、`Room.glb`、`room_layout.json`，重建的物件标 `"rebuilt": "trellis"`），每件的照片、渲染对比、Astra 的回答和费用在 `items.json`、`summary.md`、`overview.jpg`。中断后重跑同一命令会接着做。重建的物件在网页里单独可移动，放在家具上的会随家具移动。

## 可动部件：Astra 判断哪些东西能打开，切开装上合页

建模阶段只给按类别规则该动的程序化物体（有门的柜子、升降桌……）和门窗加关节；TRELLIS 重建的、类别规则覆盖不到的、建模时做成一整块的，都不能动。这一步在 author 之后读 `Room.blend`，不重跑 author，给这些东西补上能开的部件（做法是可动物体试验的方法 2：直接切现有模型，不重新生成）。完整重建默认会在最后自动跑它；对已有的运行单独跑：

```bash
$PY room-reconstruction/server/run_room.py --articulate runs/<运行>/pipeline/<场景> <新目录> --check
$PY room-reconstruction/server/run_room.py --articulate runs/<运行>/pipeline/<场景> <新目录> \
  --set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high
# 先试几件：--only Pedestal0 Laptop0（不写最终房间）；只出图不问模型：--through views
```

1. **挑候选**：家具和房间里的东西，不含房间结构、门窗、固定设施、挂在别的物体上的附件（门上的衣服、显示器的线），以及最长边不到 20 厘米的。已经有关节的也算，告诉 Astra 哪些部件已经能动，只问缺的。
2. **出图**：每件单独渲染，在它自己的坐标系里（原点和朝向取自它在房间里的位置，米，Z 朝上）：正视、侧视两张带米制刻度的正交图，和从四个斜角看的透视图；再按相机投影裁 3 张照片。
3. **Astra 判断**（每件一次）：照着照片判断真实物体有没有人会打开的部件（门、抽屉、盖子、屏幕、翻板；瓶盖这类取下来的不算），在模型里找到它，给出范围框、转轴或滑动方向、能开多大、模型里现在是开着还是合着、合上时后面是不是空的。模型里没有能切出来的面就答“没有”，不猜。框、转轴都对齐到坐标轴；离物体外表面 1.5 厘米以内的框边推到外面，免得留下一条边。
4. **切开**：按框把面切下来，合成一个部件，原点放在转轴上（滑动的放在框中心），挂在新的 `<物体>_Hinges` 下；合上时后面是空的部件，后面补深色内腔，抽屉再在前脸后面补一个开口朝上的屉子跟着滑；加一段“合上 → 全开 → 合上”的动画（App 用）。
5. **检查**（每件一次）：四个斜角的“合上”和“打开”图和照片一起给 Astra，每个部件开得对才留下；开错的比不能开更糟，直接去掉。
6. **写结果**：留下的部件从 author 的 `Room.blend` 重新切一遍，写到 `<新目录>/room_preview/`（`Room.blend`、`Room.glb`、原样的 `room_layout.json`）；每件的关节写成 `<新目录>/room/Objects/Articulated/<物体>/sim/<物体>.urdf`，原运行的 `room/Objects` 链接在旁边，所以 `python3 web/scripts/room_objects.py <新目录>/room_preview` 能一次读到全部关节。

记录在 `items.json`、`summary.md`、`overview.jpg`（照片 | 合上 | 打开）。中断后重跑同一命令会接着做。

## 对 LiteReality-Agent 改了什么

基线是官方 `28ffe1f4`（2026-10-03），即本仓库的第一个提交，原样放在 `room-reconstruction/`。之后：

- **所有 Agent 改用 Codex**：默认 provider 从 claude 改为 codex（`models.env`、`settings.py`、`agent/providers/base.py`）；Codex 会话支持附图（`providers/codex.py`）；新增 `agent/providers/vision.py`，在建模路线分类、椅子分组、程序化完整性检查、布局 Agent 四处看图。provider 设回 claude 时仍走官方原来的代码。
- **新增、不改官方文件**：3090 运行脚本 `room-reconstruction/server/`；小物件这一步 `pipeline/realism_authoring/small_objects/`（复用官方的证据图、参考图、TRELLIS 启动器和看图问答）。
- **CI**：`.github/workflows/ci.yml` 先用 gitleaks 扫描全部历史里的密钥，再跑官方测试和网页测试。

逐行改动看提交 2。另删了没有任何地方调用的官方代码（2026-10-27，用户同意删死代码）：`pipeline/scene_init/layout/agent_loop.py`、`toolcli.py`（让模型调用的 `physical_engine.toolcli` 包早已不存在），`layout/agent.py` 的 `solve_v10`、`layout/repair.py` 的 `solve_v11`–`solve_v13`，`agent/tools/shared/config.py` 的 `RANK_TOOL`、`ANNOTATE_TOOL`。
