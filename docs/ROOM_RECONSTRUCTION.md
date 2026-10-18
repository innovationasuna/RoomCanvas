# 房间重建（LiteReality + Astra）

把手机扫描（iPhone LiDAR + RoomPlan）重建成真实尺寸、带纹理的 `Room.glb`，再接到网页编辑器上。代码在 [`room-reconstruction/`](../room-reconstruction/)（LiteReality-Agent 官方代码，Agent 改用 Codex / GPT-6 Astra，改动见根目录 [README](../README.md#对-litereality-agent-改了什么)）。在 3090 服务器上运行，目录和环境见 [交接文档](HANDOFF.md)。

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
- 确认加载的是本仓库的代码，把配置记进运行目录（不记密钥）。

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
