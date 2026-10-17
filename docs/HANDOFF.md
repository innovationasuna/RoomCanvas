# 交接

给新对话接续工作用。项目介绍和用法见根目录 [README](../README.md)。更新：2026-10-17（夜）。

## 现状

- 仓库 2026-10-17 重建为干净历史（4 个提交：官方代码、改用 Astra、网页、示例房间）。旧仓库和旧 PR 已按用户要求删除，不留备份。
- 原三块：`reconstruction/`（LiteReality + Astra，3090 运行脚本在 `reconstruction/server/`）、`web/`（编辑器）、`samples/`（room3、office）。整合分支另有 `object-reconstruction/`（ViewForge）和 `gesture/`（浏览器手势），见下方整合说明。
- 编辑器只有一条路：任何房间都读 `room_objects.json`（`web/scripts/room_objects.py` 生成，可手写 `name` 覆盖家具名）。座面、墙角短墙、窗帘归墙都自动处理。
- 测试：网页单测 122 项、Python 6 项、office 五个真实模型检查、两个房间的 `check_room`，CI 全跑。`reconstruction/` 离线测试 770 通过、2 跳过。
- PR #1（已合并）：选中、原位确认即时；碰撞检查提速 4–5 倍，结果与原来逐项一致。
- 小物件这一步（分支 `small-objects`，PR 待合并）：author 之后读 `Room.blend`，Astra 每件问一次（舍弃 / 程序化 / TRELLIS），TRELLIS 的放回原位、网页里单独可移动。用法见 README。`run_room.py` 的 author 返工默认改为 1 轮（官方参数 `--repair-rounds`，没改官方文件）。
- 本机常开一个预览服务：仓库根目录 `python3 -m http.server 7880`，打开 <http://127.0.0.1:7880/web/>（7870 被用户原来的 office 预览占着）。

## 约定

- 回复用中文；提交不加 Claude 署名，作者用 git 全局配置（innovationAusna）。
- 一个功能一个分支一个 PR，挪文件、改文档随功能一起；用户确认后 `gh pr merge --squash --delete-branch`。
- 官方文件尽量少改，改了在 README“对 LiteReality-Agent 改了什么”补一句。用户不要 `AGENTS.md`、另写的 pyproject 或 pre-commit。
- 用户于 2026-10-17 授权把 ViewForge 及手势代码、完整历史导入本仓库。整合在 `feat/integrate-viewforge` 分支，原 ViewForge 仓库和运行服务保留；不要再按旧的“只读、不迁”约定处理本次整合。入口与范围见 [整合说明](VIEWFORGE_INTEGRATION.md)。此分支合入 main 时需普通 merge commit，以保留导入历史。
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

## 小物件这一步的 room3 结果

最终结果在 `runs/room3-small-objects-20261017c/room_preview/`（本机 `~/Downloads/RoomCanvas-runs/room3-small-objects-20261017c/`，看 `overview.jpg`、`summary.md`）。同目录的 `room_preview-4096-textures/` 是贴图降级前的版本。前两次（`…20261017`、`…20261017b`）是有 bug 和带二次检查的旧流程，留作记录；`dev1–3`、`applytest` 是调试用的。服务器上这次代码的 checkout 在 `/workspace/geyinuo/roomcanvas/rc-small`（分支 `small-objects`）。

- 26 个候选（书堆合成一件后）：TRELLIS 10 件（风扇、蓝袋子、枕头、叠被、粉色包、书架上 3 摞书、地上一摞书、垃圾桶），保留程序化 7 件（床单、白板、乐谱），舍弃 9 件（磁贴、电线、谱架、粉色布、相机、两只拖鞋、瓶子、白板笔）。
- 费用：26 次 Astra 判断（另有旧流程的 12 次检查），gpt-image-2 共 $0.86；TRELLIS 每件约 2.5 分钟。
- 网页：`check_room` 23/23 通过，10 件重建物件单独成组。
- 已知问题：
  1. `Room.glb` 102 MB（原来 40 MB），10 件重建物件的贴图已降到 1024，仍各占约 6 MB；还想更小可以导出 JPEG 贴图或给 TRELLIS 设更小的 `--texture-size`/面数。
  2. 粉色包重建成偏红色，蓝袋子位置随原模型略偏（原模型就放偏了）。没有二次检查后，这类只能人工看 `overview.jpg`。
  3. 枕头、叠被、粉色包打开时是“支撑边缘不足”（TRELLIS 底面不平），挪一下能落稳；书架上的书因书架本身“待调整”而显示未落稳。
  4. TRELLIS 默认模式下，书架上的书堆后处理要多占 7.9 GB 显存，3090 放不下；流程会自动隔离并用 512 模式重做（模型略粗）。
- 待用户决定：要不要用这个结果替换 `samples/room3`（会让仓库多约 60 MB，贴图同样来自私人照片）。

## 待办和待决定

1. **编辑器性能**（用户说先放着）：只有两个重网格挨着时慢，room3 里是琴凳贴着钢琴，每步约 2 秒；同一把椅子放到房间中央只要 2 毫秒，office 的 TRELLIS 椅子也只要几毫秒。“每个连通部件只测一个点”的捷径会漏判（钢琴由 23 块重叠壳体组成），已放弃。以后要做就给重网格做简化碰撞外形，或放到 Web Worker。
2. **清空房间、导出空房间**：按 `room_objects.json` 的 `role` 删家具，导出 `empty_room.glb`。窗帘、挂画、白板算不算家具未最终定（现在窗帘留在房间，挂画、白板算家具）。
3. **room3 视觉验收没过，是否照样 publish**：(a) 用现有结果跑 publish 和 simulate，(b) 先提升效果再重跑，(c) 先 a 后 b。
4. **嵌入式家具三层方案**（自动识别开凹槽 / 交给修复和布局 Agent / 剩余的人工确认），还没做。
5. 邀请协作者（等用户给 GitHub 用户名）；审阅规则（是否要求批准）待用户定。
6. 服务器上旧的 `astra_run.py`、`repo/` 是否归档。
