# 交接

给新对话接续工作用。项目介绍和用法见根目录 [README](../README.md)。更新：2026-10-18（room3 接入手势页）。

## 现状

- 仓库 2026-10-17 重建为干净历史（4 个提交：官方代码、改用 Astra、网页、示例房间）。旧仓库和旧 PR 已按用户要求删除，不留备份。
- 原三块：`reconstruction/`（LiteReality + Astra，3090 运行脚本在 `reconstruction/server/`）、`web/`（编辑器）、`samples/`（room3、office）。整合分支另有 `object-reconstruction/`（ViewForge）和 `gesture/`（浏览器手势），见下方整合说明。
- 编辑器只有一条路：任何房间都读 `room_objects.json`（`web/scripts/room_objects.py` 生成，可手写 `name` 覆盖家具名）。座面、墙角短墙、窗帘归墙都自动处理。
- 测试：网页单测 122 项、Python 7 项、office 五个真实模型检查、两个房间的 `check_room`，CI 全跑（另有 #5 带来的 `gesture`、`object-viewer` 两项）。`reconstruction/` 离线测试 785 项（服务器上 `test_stdio_bridge_matches_the_registry` 因环境原因失败，CI 通过）。
- PR #1（已合并）：选中、原位确认即时；碰撞检查提速 4–5 倍，结果与原来逐项一致。
- PR #4（已合并）小物件这一步：author 之后读 `Room.blend`，Astra 每件问一次（舍弃 / 程序化 / TRELLIS），TRELLIS 的放回原位、网页里单独可移动。用法见 README。`run_room.py` 的 author 返工默认改为 1 轮（官方参数 `--repair-rounds`，没改官方文件）。
- 本机常开一个预览服务：仓库根目录 `python3 web/scripts/serve.py --port 7880`（静态文件 + 转发 ViewForge 读接口），打开 <http://127.0.0.1:7880/web/>（7870 被用户原来的 office 预览占着；7890 被代理占用）。2026-10-18 还开着到 ViewForge 的 SSH 隧道（7865）和手势页（8800），见下文“ViewForge 和手势”。

## 约定

- 回复用中文；提交不加 Claude 署名，作者用 git 全局配置（innovationAusna）。
- 一个功能一个分支一个 PR，挪文件、改文档随功能一起；用户确认后 `gh pr merge --squash --delete-branch`。
- 只用 squash 合并。合并前看提交说明末尾，`Co-authored-by` 只保留用户和 lyk（GitHub 会把分支里所有提交者自动列上，#5 的 ViewForge 上游作者就是这样带进来的）；上游的署名靠许可证和 NOTICE 文件保留，不能删。
- 官方文件尽量少改，改了在 README“对 LiteReality-Agent 改了什么”补一句。用户不要 `AGENTS.md`、另写的 pyproject 或 pre-commit。
- 用户于 2026-10-17 授权把 ViewForge 及手势代码、完整历史导入本仓库。整合在 `feat/integrate-viewforge` 分支，原 ViewForge 仓库和运行服务保留；不要再按旧的“只读、不迁”约定处理本次整合。入口与范围见 [整合说明](VIEWFORGE_INTEGRATION.md)。此分支合入 main 时需普通 merge commit，以保留导入历史。
- 私人数据：原始扫描、照片、`room_layout.json` 不进仓库；room3 的 `Room.glb` 是用户同意的例外，仓库公开前必须删。

## 服务器（3090）

`ssh 3090x2-docker`（免密）。RoomCanvas 在服务器上只有一个文件夹 `/workspace/geyinuo/RoomCanvas/`（2026-10-17 整理），它就是本仓库 main 的 checkout，也是 `ROOMCANVAS_HOME`。下表的服务器专用目录写在 `.git/info/exclude` 里，不进 git。

| 路径（在 `/workspace/geyinuo/RoomCanvas/` 下） | 内容 |
|---|---|
| 仓库文件（`reconstruction/`、`web/`、`samples/`、`gesture/` …） | 与 GitHub main 一致 |
| `.env`、`.env.astra` | 密钥，**不要打印** |
| `runtime/` | litereality-env、trellis-env、Blender 5.1.2、CUDA 12.4、codex-cli；测试环境 `runtime/venv-tests`（链接为 `reconstruction/.venv`） |
| `backends/` | TRELLIS.2 和权重 |
| `data/` | 扫描（`scans/hausen/` room1–3、bathroom，私人）、输入包、office 扫描 `example-scans/` |
| `runs/` | 所有运行结果，不覆盖 |
| `runs/room3-astra-20261016/pipeline/hausen_room3/realism_authoring/room_preview/` | room3 的 `Room.glb`、`room_layout.json` |
| `runs/full-astra-20260919/office_room/realism_authoring/room_preview/` | office 的 `room_layout.json` |
| `archive/` | 只挪不删的旧东西：9 月旧仓库、旧脚本（`astra_run.py`、`repo/`、`official/` 等）、小物件试跑 |

同步代码：服务器访问 GitHub 不稳定，用 `git bundle` + `scp`，在这个文件夹里 `git fetch <bundle> main:refs/tmp/main`，再把 `main` 指过去。运行一律用 `reconstruction/server/run_room.py`（先加 `--check`），它会确认加载的是这份 checkout 的代码。litereality-env 的可编辑安装已改为指向这里的 `reconstruction/src`。手动跑 Blender 要带 `LD_LIBRARY_PATH`（见 `run_room.py`）。

`/workspace/geyinuo/` 下的 `ViewForge/` 是 lyk 的，`rc3090/` 等是 RoboSyn 的，不要动。`/workspace/geyinuo/RoomCanvas-Reconstruction/`（9 月的早期重建试验）也**不要动**：ViewForge 的 `layouts.py` 从它的 `runs/` 读办公室、茶室三个房间（2026-10-17 曾被误移进 archive，弄坏了 ViewForge 的房间，已移回）。挪服务器上任何目录前，先查别的项目和正在运行的进程是否引用它。

## 最近的结果

- **room3 完整运行**（`runs/room3-astra-20261016`）：重建 8 件（床用 TRELLIS，5 件程序化，门窗各 1），author 阶段视觉验收 4.0 → 5.0 → 5.0 未过，按官方新规则停在 author，没有 publish。约 54 个 Codex 会话，按 Astra 标准价折算约 $69。评审意见：窗帘褶皱太规则、床品不对、窗框简化、马图发糊。
- **布局验证摸底**：office、tea_room、room3 通过；room1、room2、bathroom 失败，6 条错误里 5 条是嵌入式家具（柜门与墙齐平的衣柜、壁龛）被识别成贴墙薄片。
- 本地运行目录：`~/Downloads/RoomCanvas-runs/room3-astra-20261016/`（含 `room_layout.json`）、`~/Downloads/RoomCanvas-office-astra/`。

## 小物件这一步的 room3 结果

最终结果在 `runs/room3-small-objects-20261017c/room_preview/`（本机 `~/Downloads/RoomCanvas-runs/room3-small-objects-20261017c/`，看 `overview.jpg`、`summary.md`）。同目录的 `room_preview-4096-textures/`、`room_preview-before-material/`、`room_preview-books-recoloured/` 是中间版本（贴图未降级、未修正材质、书堆被误转色）。前两次（`…20261017`、`…20261017b`）是有 bug 和带二次检查的旧流程，`dev1–3`、`applytest` 是调试用的，都留作记录。试跑目录已移到 `archive/small-objects-trials-20261017/`。

- 26 个候选（书堆合成一件后）：TRELLIS 10 件（风扇、蓝袋子、枕头、叠被、粉色包、书架上 3 摞书、地上一摞书、垃圾桶），保留程序化 7 件（床单、白板、乐谱），舍弃 9 件（磁贴、电线、谱架、粉色布、相机、两只拖鞋、瓶子、白板笔）。
- 费用：26 次 Astra 判断（另有旧流程的 12 次检查），gpt-image-2 共 $0.86；TRELLIS 每件约 2.5 分钟。
- 网页：`check_room` 23/23 通过，10 件重建物件单独成组。
- 已知问题：
  1. `Room.glb` 102 MB（原来 40 MB），10 件重建物件的贴图已降到 1024，仍各占约 6 MB；还想更小可以导出 JPEG 贴图或给 TRELLIS 设更小的 `--texture-size`/面数。
  2. 粉色包曾被 TRELLIS 生成成正红（参考图是品红，换种子也一样），已加材质修正：单一主色的物件转回参考图色相，非金属物件金属度归零。蓝袋子位置随原模型略偏（原模型就放偏了）。
  3. 枕头、叠被、粉色包打开时是“支撑边缘不足”（TRELLIS 底面不平），挪一下能落稳；书架上的书因书架本身“待调整”而显示未落稳。
  4. TRELLIS 默认模式下，书架上的书堆后处理要多占 7.9 GB 显存，3090 放不下；流程会自动隔离并用 512 模式重做（模型略粗）。
- 待用户决定：要不要用这个结果替换 `samples/room3`（会让仓库多约 60 MB，贴图同样来自私人照片）。

## ViewForge 和手势（PR #5 合进来的，lyk 的部分）

- 代码：`object-reconstruction/`（ViewForge：照片 → 抠图 → 多视角重建 → 尺寸标定；布局页用 Babylon，松手时请服务器做承托和碰撞校验），`gesture/`（本机浏览器里用摄像头识别手势，通过 `viewforge-gesture-v1` 消息协议驱动嵌入的布局页）。服务器上实际运行的是 lyk 自己的 `/workspace/geyinuo/ViewForge/code`（`web.py`，监听容器内网 `172.18.0.2:7862`），不是仓库里这份。
- 本机试手势：开隧道 `ssh -C -N -o IPQoS=none -o ServerAliveInterval=15 -L 127.0.0.1:7865:172.18.0.2:7862 3090x2-docker`；仓库根目录 `sh scripts/gesture.sh install`、`sh scripts/gesture.sh dev`；Chrome 打开 <http://127.0.0.1:8800/viewforge.html>。房间打开时是空的（服务器上没有保存的布局），要先“确认尺寸并固定”，再在“加入重建物体”里选 `20260926_sofa_web_114146_561893`（沙发）、“重新读取已保存尺寸”、“加入场景”。左手比 1/2/3 切移动/旋转/观察，右手捏合抓取。
- 旋转偏慢的原因：`object-reconstruction/viewer/src/layout-gesture.ts` 里旋转量 = 手在画面中横移比例 × π，手扫过整个画面才转 180°，平时一次只转 36–54°；移动则是 1:1 指向地面，所以流畅。改成 2π 倍率或按手速加速即可，是否改待和 lyk 商量。我们自己的接收端用 2π。
- **room3 接进手势页（2026-10-18，分支 `feat/room3-gesture`）**：定为做法 (a)，给 RoomCanvas 编辑器加手势协议接收端（`web/editor/gesture-bridge.mjs`），手势页用 `?layout=` 指向编辑器，`gesture/` 和 ViewForge 一行没改。room3 全部家具可用手势移动、旋转，观察模式环绕/平移；手的指针覆盖整个编辑器（捏合按钮=点击，捏合仓库卡片=取出），松手只停成预览，捏合“放置并落下”才确认（用户 2026-10-18 反馈：原来松手即放下、仓库拖不出来）；编辑器“导入物体”按实测尺寸导入 ViewForge 物体（显示完整模型，碰撞用轻量预览，自动放到最近空地）。打开：<http://127.0.0.1:8800/viewforge.html?layout=http%3A%2F%2F127.0.0.1%3A7880%2Fweb%2Feditor%2F%3Fscene%3D..%2F..%2Fsamples%2Froom3>（需隧道 7865、手势页 8800、`serve.py` 7880）。用 Playwright 驱动真实手势页、模拟手势消息验证过：连接、切模式、环绕、导入 Cody（约 12 秒）、手势拖动放下、旋转 45°；没有真人摄像头验收。已知：导入的物体不随布局保存；琴凳夹在床和钢琴之间，原地转 15° 就碰床（原有逻辑如此）。做法 (b) 不做。

## 产品方向（用户 2026-10-18 提出）

做成一个网页（以后加自己的 App 扫描和展示）：扫描房间 → 清空 → 加入物体（自己拍几个视角、可补拍、按实际尺寸重建；或给一个商品链接，找多视角图和尺寸后重建；以及房间原有的物品）→ 在房间里自由布置，网页上用鼠标或摄像头手势操作。

| 环节 | 现状 |
|---|---|
| 扫描 → 真实尺寸房间 | 有（LiteReality + Astra），慢且贵（room3 几小时、约 $69），产品化要降成本 |
| 清空房间 | 差一步（`room_objects.json` 的 `role` 已有，见待办 2） |
| 自己拍物体 → 按尺寸重建 | 基本有（ViewForge），尺寸目前靠用户填一条实测边长 |
| 商品链接 → 多视角图和尺寸 → 重建 | 没有；重建部分可复用小物件流程（参考图 → TRELLIS → 按商品尺寸缩放），注意网站条款 |
| 网页布置 | RoomCanvas 编辑器已接上手势和 ViewForge 物体（`feat/room3-gesture`）；ViewForge 布局页仍单独存在 |
| 手势 | 有（`gesture/`，协议与页面无关），编辑器已能接收 |
| 后端 | 没有：需要接收上传、排队跑房间/物体重建、两张 3090 调度、存结果 |

建议顺序：1) 一个网页里 room3 + 手势 + 导入 ViewForge 已有物体，先验证体验（已做，待用户真人试用）；2) 网页上传照片 → 服务器重建物体（补拍、填尺寸）→ 放进房间；3) 清空房间；4) 商品链接重建；5) 网页上传扫描 → 房间重建排队，同时降成本；6) App。ViewForge 和手势是 lyk 的部分，合成一个网页前先和 lyk 商量分工。

## 待办和待决定

1. **编辑器性能**（用户说先放着）：只有两个重网格挨着时慢，room3 里是琴凳贴着钢琴，每步约 2 秒；同一把椅子放到房间中央只要 2 毫秒，office 的 TRELLIS 椅子也只要几毫秒。“每个连通部件只测一个点”的捷径会漏判（钢琴由 23 块重叠壳体组成），已放弃。以后要做就给重网格做简化碰撞外形，或放到 Web Worker。
2. **清空房间、导出空房间**：按 `room_objects.json` 的 `role` 删家具，导出 `empty_room.glb`。窗帘、挂画、白板算不算家具未最终定（现在窗帘留在房间，挂画、白板算家具）。
3. **room3 视觉验收没过，是否照样 publish**：(a) 用现有结果跑 publish 和 simulate，(b) 先提升效果再重跑，(c) 先 a 后 b。
4. **嵌入式家具三层方案**（自动识别开凹槽 / 交给修复和布局 Agent / 剩余的人工确认），还没做。
5. 协作者：lyk（`jbykkk`）已加入；审阅规则（是否要求批准）待用户定。
