# 交接

给新对话接续工作用。项目介绍和用法见根目录 [README](../README.md)。更新：2026-10-17。

## 现状

- 仓库 2026-10-17 重建为干净历史（4 个提交：官方代码、改用 Astra、网页、示例房间）。旧仓库和旧 PR 已按用户要求删除，不留备份。
- 三块：`reconstruction/`（LiteReality + Astra，3090 运行脚本在 `reconstruction/server/`）、`web/`（编辑器）、`samples/`（room3、office）。
- 编辑器只有一条路：任何房间都读 `room_objects.json`（`web/scripts/room_objects.py` 生成，可手写 `name` 覆盖家具名）。座面、墙角短墙、窗帘归墙都自动处理。
- 测试：网页单测 121 项、Python 6 项、office 五个真实模型检查、两个房间的 `check_room`，CI 全跑。`reconstruction/` 离线测试 770 通过、2 跳过。

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

## 待办和待决定

1. **编辑器性能**：选中、原位确认已是即时；移动后的完整检查比原来快 4–5 倍且结果不变，但 room3 琴凳每步仍约 2 秒。时间主要在 `collision.mjs` 的包含判断（`pointInside` 射线）。“每个连通部件只测一个点”的捷径试过，在重建网格上（如钢琴由 23 块重叠壳体组成）会漏判，已放弃。下一步可选：给重网格做简化碰撞外形，或放到 Web Worker。
2. **清空房间、导出空房间**：按 `room_objects.json` 的 `role` 删家具，导出 `empty_room.glb`。窗帘、挂画、白板算不算家具未最终定（现在窗帘留在房间，挂画、白板算家具）。
3. **room3 视觉验收没过，是否照样 publish**：(a) 用现有结果跑 publish 和 simulate，(b) 先提升效果再重跑，(c) 先 a 后 b。
4. **嵌入式家具三层方案**（自动识别开凹槽 / 交给修复和布局 Agent / 剩余的人工确认），还没做。
5. 邀请协作者（等用户给 GitHub 用户名）；审阅规则（是否要求批准）待用户定。
6. 服务器上旧的 `astra_run.py`、`repo/` 是否归档。
