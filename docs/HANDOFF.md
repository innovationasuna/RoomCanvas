# 交接

给新对话接续工作用。项目介绍和用法见根目录 [README](../README.md)。更新：2026-10-17（晚）。

## 现状

- 仓库 2026-10-17 重建为干净历史（4 个提交：官方代码、改用 Astra、网页、示例房间）。旧仓库和旧 PR 已按用户要求删除，不留备份。
- 三块：`reconstruction/`（LiteReality + Astra，3090 运行脚本在 `reconstruction/server/`）、`web/`（编辑器）、`samples/`（room3、office）。
- 编辑器只有一条路：任何房间都读 `room_objects.json`（`web/scripts/room_objects.py` 生成，可手写 `name` 覆盖家具名）。座面、墙角短墙、窗帘归墙都自动处理。
- 测试：网页单测 122 项、Python 6 项、office 五个真实模型检查、两个房间的 `check_room`，CI 全跑。`reconstruction/` 离线测试 770 通过、2 跳过。
- PR #1（已合并）：选中、原位确认即时；碰撞检查提速 4–5 倍，结果与原来逐项一致。
- 本机常开一个预览服务：仓库根目录 `python3 -m http.server 7880`，打开 <http://127.0.0.1:7880/web/>（7870 被用户原来的 office 预览占着）。

## 约定

- 回复用中文；提交不加 Claude 署名，作者用 git 全局配置（innovationAusna）。
- 一个功能一个分支一个 PR，挪文件、改文档随功能一起；用户确认后 `gh pr merge --squash --delete-branch`。
- 官方文件尽量少改，改了在 README“对 LiteReality-Agent 改了什么”补一句。用户不要 `AGENTS.md`、另写的 pyproject 或 pre-commit。
- ViewForge（lyk 的）只读，不改不迁。
- 私人数据：原始扫描、照片、`room_layout.json` 不进仓库；room3 的 `Room.glb` 是用户同意的例外，仓库公开前必须删。

## 服务器（3090）

`ssh 3090x2-docker`（免密）。服务器访问 GitHub 不稳定，传代码用 `git bundle` + `scp`。

| 路径 | 内容 |
|---|---|
| `/workspace/geyinuo/RoomCanvas/` | `ROOMCANVAS_HOME`：`runtime/`（litereality-env、trellis-env、Blender 5.1.2、CUDA 12.4、codex-cli）、`backends/`（TRELLIS.2 和权重）、`.env`（密钥，**不要打印**） |
| `/workspace/geyinuo/roomcanvas/rc-main/` | 仓库 checkout（分支 `main`），`reconstruction/.venv` 链接到 `../.venv-rc` 测试环境 |
| `/workspace/geyinuo/roomcanvas/data/` | 扫描（`scans/hausen/` room1–3、bathroom，私人）和输入包 |
| `/workspace/geyinuo/roomcanvas/runs/` | 运行结果，不覆盖 |
| `…/runs/room3-astra-20261016/pipeline/hausen_room3/realism_authoring/room_preview/` | room3 的 `Room.glb`、`room_layout.json` |
| `/workspace/geyinuo/RoomCanvas/runs/full-astra-20260919/office_room/realism_authoring/room_preview/` | office 的 `room_layout.json` |

坑：litereality-env 里还有一个指向旧代码的可编辑安装，`PYTHONPATH` 不对就会悄悄用旧代码；`run_room.py` 启动前检查，对不上就退出。手动跑 Blender 测试要带 `LD_LIBRARY_PATH`（见 `run_room.py`）。

## 最近的结果

- **room3 完整运行**（`runs/room3-astra-20261016`）：重建 8 件（床用 TRELLIS，5 件程序化，门窗各 1），author 阶段视觉验收 4.0 → 5.0 → 5.0 未过，按官方新规则停在 author，没有 publish。约 54 个 Codex 会话，按 Astra 标准价折算约 $69。评审意见：窗帘褶皱太规则、床品不对、窗框简化、马图发糊。
- **布局验证摸底**：office、tea_room、room3 通过；room1、room2、bathroom 失败，6 条错误里 5 条是嵌入式家具（柜门与墙齐平的衣柜、壁龛）被识别成贴墙薄片。
- 本地运行目录：`~/Downloads/RoomCanvas-runs/room3-astra-20261016/`（含 `room_layout.json`）、`~/Downloads/RoomCanvas-office-astra/`。

## 下一步：小物件改用 TRELLIS（方案已定，未实现）

**背景**：room3 的 97 个物体里，只有 8 件是重建阶段建的；其余 83 件（书、拖鞋、袋子、瓶子、乐谱、枕头、被子、窗帘、插座、灯……）是 author 阶段 Astra 用 Blender 基本形状拼的，小东西都像方块。author 阶段 Astra 只有取材质、渲染、评审、选视角、查碰撞几个工具，没有生成三维模型的工具；后续的逐件精修也只修程序化物体。

**对比实验**（`runs/trellis-compare-20261017`；本机 `~/Downloads/RoomCanvas-runs/trellis-compare-20261017/`，`compare.jpg`、`rescue_compare.jpg`、`defects_compare.jpg`）：
- 实拍裁图 + SAM2 抠图 → TRELLIS：照片清楚完整时（被子、购物袋、垃圾桶）比程序化像得多；模糊或拍不全时（拖鞋、风扇）生成出无关的东西；薄壁（塑料袋、桶壁）会被打出很多破洞。
- 证据图 → gpt-image-2 参考图 → TRELLIS（即正式流程的做法）：四件都完整、无破洞（垃圾桶透光比例 0%）。缺点：印刷图案会糊成色块；照片越糊，越像“同类商品”而不是那件实物。
- 清理碎片（只保留占表面积 ≥1% 的部件）把碎片从 19–73 块降到 1–3 块，外观无损。
- 成本：gpt-image-2 每张约 $0.086；TRELLIS 每件 2–2.5 分钟，加载模型 2–3 分钟（3090，单卡加锁）。
- 顺带发现：room3 的“落地风扇”其实是钢琴旁书堆后的台式风扇，重建记录的 0.73 m 尺寸是错的。

**用户定的方案**：
1. **不设固定的尺寸阈值，由 Astra 逐件判断**：看这件物件的照片和它在房间里的情况，三选一：
   - **舍弃**：太小、照片里看不清、对房间不重要的（比如瓶子、磁贴、马克笔）；
   - **程序化建模**：规则形状、程序化本来就能做像的（比如扁平的乐谱、单本书、规则的桶）；
   - **TRELLIS 重建**：软的、有褶皱的、形状复杂的（比如被子、枕头、购物袋、拖鞋）。
   实验里观察到的规律（小而糊的 TRELLIS 会乱生成，扁平物没必要用 TRELLIS，一摞书适合合成一件）写进给 Astra 的说明里作为参考，不作为硬规则。墙上的插座、开关、灯等固定设施不在此列。
2. TRELLIS 路线：拼证据图（仓库现成的 `make_weighted_input_sheet`、`build_prompt`）→ `generate_reference`（gpt-image-2）→ TRELLIS（`reconstruction/server/trellis_local.py`）→ 清理碎片 → 按原物件位置和尺寸替换进 `Room.blend`。
3. **重建出来很不像的（包括变成方块的）就不要了**：Astra 对照照片检查，不像就直接删除，不保留方块。程序化建的也同样检查。
4. 重建出来的物件在编辑器里**单独可移动**；放在家具上的，家具移动时跟着走（编辑器已有“随支撑物移动”）。改 `web/scripts/room_objects.py` 的分组规则。
5. 做成 author 之后的独立新步骤，读现有 `Room.blend`，不用重跑 author；重建模块只加新文件，README 补一句；和网页改动合成一个 PR。先在 room3 上验证。费用：每件一次 Astra 判断、一次 Astra 检查（看图问答），TRELLIS 的每件再加约 $0.086 图片费和 2–2.5 分钟 GPU。

**实验脚本可参考**（都在服务器实验目录，不在仓库）：`crops2.py`/`views.py`（按相机投影 + Grounding DINO 找物体、按世界朝上转正裁图）、`segment.py`（SAM2 抠图；依赖装在实验目录 `pydeps/`，没动共用环境）、`rescue2.py`（证据图 + 参考图）、`run_trellis.py`（选卡加锁跑 TRELLIS）、`cleanup.py`（清碎片）、`export_procedural.py`（从 `Room.blend` 单独导出物件）。注意：TRELLIS 启动器默认不抠图，输入要么带透明通道，要么黑底（RGB 都 ≤12 的像素当透明）；照片是横拍的，裁图要按相机朝向转正。

## 待办和待决定

1. **编辑器性能**（用户说先放着）：只有两个重网格挨着时慢，room3 里是琴凳贴着钢琴，每步约 2 秒；同一把椅子放到房间中央只要 2 毫秒，office 的 TRELLIS 椅子也只要几毫秒。“每个连通部件只测一个点”的捷径会漏判（钢琴由 23 块重叠壳体组成），已放弃。以后要做就给重网格做简化碰撞外形，或放到 Web Worker。
2. **清空房间、导出空房间**：按 `room_objects.json` 的 `role` 删家具，导出 `empty_room.glb`。窗帘、挂画、白板算不算家具未最终定（现在窗帘留在房间，挂画、白板算家具）。
3. **room3 视觉验收没过，是否照样 publish**：(a) 用现有结果跑 publish 和 simulate，(b) 先提升效果再重跑，(c) 先 a 后 b。
4. **嵌入式家具三层方案**（自动识别开凹槽 / 交给修复和布局 Agent / 剩余的人工确认），还没做。
5. 邀请协作者（等用户给 GitHub 用户名）；审阅规则（是否要求批准）待用户定。
6. 服务器上旧的 `astra_run.py`、`repo/` 是否归档。
