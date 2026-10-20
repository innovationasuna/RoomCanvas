# 交接

给新对话接续工作用。项目介绍和用法见根目录 [README](../README.md)。更新：2026-10-19（网站第 1、2 项已合并：#12 主页和手势、#15 “添加物体”；服务器已同步到 `7b4377b`，7862 后端已重启）。

## 2026-10-20 · ViewForge 只负责物体（本地改动，未部署）

- 移除 ViewForge 的 Babylon 房间布局源码、构建产物、房间读取、场景碰撞、承托与布局快照接口；现有服务器外部数据不动。下文关于旧 ViewForge 布局页的描述属于历史。
- 保留照片、BiRefNet、DA3 / MV-SAM3D、COVER、GLB / Gaussian 单物体预览及 `dimensions.py` 实测标定。
- 物体读取拆到 `scripts/assets.py`：`/viewforge/assets/catalog`、`<结果>`、`<结果>/{result,preview}.glb`；旧 layouts 目录下只兼容 catalog/assets 读取。添加物体、标定接口保持原地址。
- 手势统一使用 RoomCanvas：内置入口照旧，独立识别页改为 `gesture/roomcanvas.html`，默认指向 7880 编辑器；协议为 `roomcanvas-gesture-v1`，不连接 ViewForge。
- 验证：网页 173 项 + Python 12 项、手势 74 项、物体预览 10 项、后端 CPU 58 项通过；类型检查、资源校验和构建通过。Chrome 合成模型验证标定 0.9 米后导入放置及 RoomCanvas 手势握手，无页面异常；未执行 GPU 重建或真人摄像头验收。
- 详情见 [物体说明](OBJECT_RECONSTRUCTION.md)。上线需要同步后端和查看器产物并重启物体服务；本次未操作服务器。

## 2026-10-20 · 兼容性复查、坐标轴与删除导入实例

- 已提交 `313a62d`：ViewForge 物体化及兼容修复。提交前网页 177 项、Python 12 项、手势 74 项、物体预览 10 项、物体后端 CPU 58 项通过；office 18/18、room3 23/23 检查通过。Chrome 回归新旧后端、离线入口、缺轻量预览、标定导入、清空撤销及手势。
- 新增本地功能：重建尺寸预览的 X/Y/Z 三轴和可点标签，Z 表示高度；仓库导入卡片可删除当前这一份实例，保留源结果及其他实例，清理碰撞、资源和历史引用。新增功能已提交为 `97c475a`，未部署。
- 新增功能验证：网页 180 项单测通过；Chrome 验证三轴选择、相机旋转标签、0.6 米标定后放置、重复实例删除、搜索、撤销/重做、待放置实例删除和源结果保留，无页面异常。
- 未执行新的 GPU 重建，也未使用真人摄像头。原有未跟踪的 `docs/OBJECT_RECONSTRUCTION_PIPELINE.md` 未纳入上述提交。

## 2026-10-20 · 物体 API 与旧界面彻底解耦

- `97c475a` 为坐标轴和删除导入实例按钮的独立提交。
- 正式 `object-reconstruction/scripts/web.py` 改为 Starlette / Uvicorn API，不加载 Gradio、旧页面、旧查看器或任意文件路由。已接入的上传、蒙版确认、重建、进度、模型、标定及旧物体读取地址兼容继续保留。
- 按用户新要求保留全部旧 UI：Gradio 页面、Babylon 单物体/房间查看器、手势接入页、场景后端、原产物、许可证与旧测试统一归档 `object-reconstruction/legacy/`，标注弃用，仅作参考，不运行或部署。前文“移除”指退出正式运行链路。
- 新增 API 依赖 `configs/api-requirements.txt`；CI 用 CPU API 回归代替旧查看器构建。历史 manifest 通过受限资产地址适配，不改历史结果，COVER/补拍 CLI 和 Gaussian 原始数据保留。
- 当前唯一正式前端为 RoomCanvas；旧界面独有的补拍操作没有自动变成新前端功能。此次只提交推送，不重启或部署正式服务器。
- 解耦验证：后端 CPU 42 项、网页 180 项、本机服务 12 项测试通过；Chrome 完整走通上传、抠图确认、重建任务、Z 轴 0.6 米标定与放置，并验证重复导入删除。GPU 运算使用 CPU 模拟，API、任务和文件处理真实执行，未重新运行模型推理。47 份归档原文件与 Git 历史逐字节核对一致。

## 现状

- 仓库 2026-10-17 重建为干净历史（4 个提交：官方代码、改用 Astra、网页、示例房间）。旧仓库和旧 PR 已按用户要求删除，不留备份。
- 原三块：`room-reconstruction/`（LiteReality + Astra，3090 运行脚本在 `room-reconstruction/server/`）、`web/`（编辑器）、`samples/`（room3、office）。主线已整合 `object-reconstruction/`（ViewForge）和 `gesture/`（浏览器手势），见下方整合说明。
- 2026-10-18 改名（用户定）：`reconstruction/` → `room-reconstruction/`（和 `object-reconstruction/` 成对），`docs/VIEWFORGE_INTEGRATION.md` → `docs/OBJECT_RECONSTRUCTION.md`，`web/editor/viewforge-import.mjs` → `object-import.mjs`。服务器同步后要跟着改三处（目录下未跟踪的东西不会随 git 移走）：把 `reconstruction/.venv` 链接挪到 `room-reconstruction/.venv` 并删掉留下的空 `reconstruction/`；`.git/info/exclude` 里 `/reconstruction/.venv` 改成 `/room-reconstruction/.venv`；`runtime/litereality-env` 的 `_editable_impl_litereality_agent.pth` 改指 `room-reconstruction/src`。然后跑一次 `run_room.py --check`。
- 编辑器只有一条路：任何房间都读 `room_objects.json`（`web/scripts/room_objects.py` 生成，可手写 `name` 覆盖家具名）。座面、墙角短墙、窗帘归墙都自动处理。
- 2026-10-18 合并：#8 手势接入编辑器 + 导入 ViewForge 物体 + 落点检查放后台线程（`f05f14e`）；#10 新 room3（小物件这一步之后的结果，`4243a6b`；原 #9 叠在 #8 上，#8 删分支时被 GitHub 关闭，重开为 #10）；#11 lyk 把 ViewForge 后端迁到本仓库运行、文档整理（`e077c91`）。服务器文件夹随后切回 main，迁移前的临时工作区存在 `git stash` 里。
- 测试：本次合并后网页单测 136 项、Python 8 项通过；CI 另跑 office 五个真实模型检查、两个房间的 `check_room`，以及 #5 带来的 `gesture`、`object-viewer` 两项。`room-reconstruction/` 离线测试历史记录为 785 项（服务器上 `test_stdio_bridge_matches_the_registry` 因环境原因失败，CI 通过）。
- PR #1（已合并）：选中、原位确认即时；碰撞检查提速 4–5 倍，结果与原来逐项一致。
- PR #4（已合并）小物件这一步：author 之后读 `Room.blend`，Astra 每件问一次（舍弃 / 程序化 / TRELLIS），TRELLIS 的放回原位、网页里单独可移动。用法见 [房间重建](ROOM_RECONSTRUCTION.md)。`run_room.py` 的 author 返工默认改为 1 轮（官方参数 `--repair-rounds`，没改官方文件）。
- README 2026-10-19 按常见开源项目的写法重写（用户要求）：标题和一句话、效果图（office 编辑器截图 `docs/images/editor-office.jpg`，不用私人卧室）、功能、快速开始、流程图（mermaid）、目录、文档、对 LiteReality 的改动、隐私、致谢与许可；服务器上的房间重建命令和小物件流程挪到 `docs/ROOM_RECONSTRUCTION.md`。
- 本机常开一个预览服务：仓库根目录 `python3 web/scripts/serve.py --port 7880`（静态文件每次重新验证 + 转发 ViewForge 读接口），打开 <http://127.0.0.1:7880/web/>（7870 被用户原来的 office 预览占着；7890 被代理占用）。它是由对话的后台任务起的，对话结束可能被停掉，停了就重新运行这条命令。还开着到 ViewForge 的 SSH 隧道（7865）和手势页（8800），见下文“ViewForge 和手势”。

## 约定

- 回复用中文；提交不加 Claude 署名，作者用 git 全局配置（innovationAusna）。
- 一个功能一个分支一个 PR，挪文件、改文档随功能一起；用户确认后 `gh pr merge --squash --delete-branch`。
- 提交没有签名，GitHub 上只有经 GitHub 合并（squash）的提交显示 Verified，本地推的（最早 4 个提交、#5）显示 unsigned。main 不要求签名，没有影响；要本地提交也带 Verified 需配置 SSH 签名，旧提交不改（要改就得重写 main 历史）。
- 只用 squash 合并。合并前看提交说明末尾，`Co-authored-by` 只保留用户和 lyk（GitHub 会把分支里所有提交者自动列上，#5 的 ViewForge 上游作者就是这样带进来的）；上游的署名靠许可证和 NOTICE 文件保留，不能删。
- 官方文件尽量少改，改了在 README“对 LiteReality-Agent 改了什么”补一句。用户不要 `AGENTS.md`、另写的 pyproject 或 pre-commit。
- ViewForge 与手势已通过 PR #5 squash 合入主线；上游许可证和来源说明保留，不再合并原完整历史分支。用户于 2026-10-18 授权将实际服务迁移到 RoomCanvas；后端和本机手势都使用新仓库源码，外部运行数据沿用原目录。入口与范围见 [物体重建说明](OBJECT_RECONSTRUCTION.md)。
- 私人数据：原始扫描、照片、`room_layout.json` 不进仓库；room3 的 `Room.glb` 和主页缩略图 `thumbnail.jpg` 是用户同意的例外，仓库公开前必须删。

## 服务器（3090）

`ssh 3090x2-docker`（免密）。RoomCanvas 在服务器上只有一个文件夹 `/workspace/geyinuo/RoomCanvas/`（2026-10-17 整理），它就是本仓库 main 的 checkout，也是 `ROOMCANVAS_HOME`。下表的服务器专用目录写在 `.git/info/exclude` 里，不进 git。

**这个文件夹里跑着正式服务**：ViewForge 后端（2026-10-18 起，lyk 迁移）从 `object-reconstruction/` 启动，监听 `172.18.0.2:7862`。所以：这里始终停在 main、工作区保持干净（不在这里直接改文件，改动走 PR）；更新代码后，若 `object-reconstruction/` 的代码有变，先告诉 lyk，再重启这个服务（在该目录 `source configs/local.env && source scripts/env.sh && python scripts/web.py --host 172.18.0.2 --port 7862`）；只改文档、网页时不用重启。

| 路径（在 `/workspace/geyinuo/RoomCanvas/` 下） | 内容 |
|---|---|
| 仓库文件（`room-reconstruction/`、`web/`、`samples/`、`gesture/` …） | 与 GitHub main 一致 |
| `.env`、`.env.astra` | 密钥，**不要打印** |
| `runtime/` | litereality-env、trellis-env、Blender 5.1.2、CUDA 12.4、codex-cli；测试环境 `runtime/venv-tests`（链接为 `room-reconstruction/.venv`） |
| `backends/` | TRELLIS.2 和权重 |
| `data/` | 扫描（`scans/hausen/` room1–3、bathroom，私人）、输入包、office 扫描 `example-scans/` |
| `runs/` | 所有运行结果，不覆盖 |
| `runs/room3-astra-20261016/pipeline/hausen_room3/realism_authoring/room_preview/` | room3 的 `Room.glb`、`room_layout.json` |
| `runs/full-astra-20260919/office_room/realism_authoring/room_preview/` | office 的 `room_layout.json` |
| `archive/` | 只挪不删的旧东西：9 月旧仓库、旧脚本（`astra_run.py`、`repo/`、`official/` 等）、小物件试跑 |

同步代码：服务器访问 GitHub 不稳定，用 `git bundle` + `scp`，在这个文件夹里先 `git status` 确认干净，再 `git fetch <bundle> main:refs/tmp/main`、`git merge --ff-only refs/tmp/main`。运行一律用 `room-reconstruction/server/run_room.py`（先加 `--check`），它会确认加载的是这份 checkout 的代码。litereality-env 的可编辑安装已改为指向这里的 `room-reconstruction/src`。手动跑 Blender 要带 `LD_LIBRARY_PATH`（见 `run_room.py`）。

`/workspace/geyinuo/` 下的 `ViewForge/` 是 lyk 的运行目录（Python 环境、权重、照片、重建结果；旧的 `ViewForge/code` 不再启动），上面的 ViewForge 后端从这里读，不要动；`rc3090/` 等是 RoboSyn 的，也不要动。`/workspace/geyinuo/RoomCanvas-Reconstruction/`（9 月的早期重建试验）原先供 ViewForge 旧布局读取；2026-10-20 本地代码已移除这项依赖，但尚未部署，仍**不要动**。挪服务器上任何目录前，先查别的项目和正在运行的进程是否引用它。

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
- 已替换 `samples/room3`（2026-10-18，用户同意，#10 已合并）：`Room.glb` 由 99.7 MB 无损缩到 66.5 MB——8 件 TRELLIS 物件和一批盒子、圆柱的法线就是面法线，去掉后 three.js 自动平面着色，画面不变，再合并完全相同的顶点；贴图、材质、节点名都没动。`room_objects.json` 用服务器结果（保留手写名字，谱架已舍弃）；`check_room` 23/23。同视角与原 99.7 MB 文件逐像素对比：俯视 0 像素不同，整体视角 85 万像素中 7 个不同（编辑器按 glTF 规范给无法线网格补面法线，阴影偏移才一致）。新房间里“是否放稳”的判断原来每次刷新 0.7 秒，手势帧会过期；支撑面三角形改用网格索引后 23 毫秒，在 room3、office 上随机布局 4078 项对比与原结果完全相同。
- 再次替换 `samples/room3`（2026-10-19，用户要求）：钢琴（Table0）换成可动物体试验方法 2 的 TRELLIS 钢琴，顶盖和琴键盖能在“预览”里打开，谱子随顶盖转。做法：gltf-transform 只换 `Table0_Static` 的网格、把 `Table0_Fallboard`/`Table0_TopLid` 和两个深色内腔挂在它下面，其他数据原样；钢琴的两张 TRELLIS 贴图从 4096 降到 1024（和房间里其他 TRELLIS 物件一致，同视角拉近看不出差别），`Room.glb` 66.5 → 69.7 MB。`room_objects.json` 用新的 `Table0.urdf`（`runs/articulation-trials-20261019/`）重新生成，只多了这两个关节；`check_room` 23/23，缩略图已重拍。已知：琴键盖合上只盖住琴键后半；翻开后在谱子下面，从上往下点不回来。

## ViewForge 和手势（PR #5 合进来的，lyk 的部分）

- 代码：`object-reconstruction/`（ViewForge：照片 → 抠图 → 多视角重建 → 尺寸标定；布局页用 Babylon，松手时请服务器做承托和碰撞校验），`gesture/`（本机浏览器里用摄像头识别手势，通过 `viewforge-gesture-v1` 消息协议驱动嵌入的布局页）。服务器后端 2026-10-18 起从本仓库的 `object-reconstruction/` 运行（见上文“服务器”），运行环境、权重、照片、历史结果仍来自 `/workspace/geyinuo/ViewForge`；服务器上的 `object-reconstruction/configs/local.env` 已配好，不进 git。
- 本机试 ViewForge 原布局：开隧道 `ssh -C -N -o IPQoS=none -o ServerAliveInterval=15 -L 127.0.0.1:7865:172.18.0.2:7862 3090x2-docker`（lyk 的机器把 `3090x2-docker` 换成他自己的 SSH 别名）；仓库根目录 `sh scripts/gesture.sh install`、`sh scripts/gesture.sh dev`；Chrome 打开 <http://127.0.0.1:8800/viewforge.html>。房间打开时是空的（服务器上没有保存的布局），要先“确认尺寸并固定”，再在“加入重建物体”里选 `20260926_sofa_web_114146_561893`（沙发）、“重新读取已保存尺寸”、“加入场景”。左手比 1/2/3 切移动/旋转/观察，右手捏合抓取。
- 旋转偏慢的原因：`object-reconstruction/viewer/src/layout-gesture.ts` 里旋转量 = 手在画面中横移比例 × π，手扫过整个画面才转 180°，平时一次只转 36–54°；移动则是 1:1 指向地面，所以流畅。改成 2π 倍率或按手速加速即可，是否改待和 lyk 商量。我们自己的接收端用 2π。
- **room3 接进手势页（2026-10-18，#8 已合并）**：定为做法 (a)，给 RoomCanvas 编辑器加手势协议接收端（`web/editor/gesture-bridge.mjs`），手势页用 `?layout=` 指向编辑器，`gesture/` 和 ViewForge 一行没改。room3 全部家具可用手势移动、旋转，观察模式环绕/平移；手的指针覆盖整个编辑器（捏合按钮=点击），从仓库卡片捏住拖出（手进房间家具才出现），松手只停成预览，在预览上轻捏一下=放置并落下（用户 2026-10-18 要求；原来松手即放下、仓库拖不出来）；编辑器“导入物体”按实测尺寸导入 ViewForge 物体（显示完整模型，碰撞用轻量预览，自动放到最近空地）。打开：<http://127.0.0.1:8800/viewforge.html?layout=http%3A%2F%2F127.0.0.1%3A7880%2Fweb%2Feditor%2F%3Fscene%3D..%2F..%2Fsamples%2Froom3>（需隧道 7865、手势页 8800、`serve.py` 7880）。用 Playwright 驱动真实手势页、模拟手势消息验证过：连接、切模式、环绕、导入 Cody（约 12 秒）、手势拖动放下、旋转 45°；没有真人摄像头验收。已知：导入的物体不随布局保存；琴凳夹在床和钢琴之间，原地转 15° 就碰床（原有逻辑如此）。做法 (b) 不做。

## 开门、开柜门（2026-10-18，分支 `feat/open-doors`）

2026-10-19 补：放在部件上的东西跟着动（用户提出：office 升降桌升起时桌上的东西不动、钢琴顶盖掀开时谱子悬着）。`joints.mjs` 的 `ridersOf` 在打开房间时按形状找出同组里底部压在部件上的物件，部件动时它们做同样的世界变换，关上时恢复原位。office 升降桌带上桌面 15 件（升 0.151 米），room3 试验钢琴的顶盖带上 4 份谱子（书压在谱子上，跟谱子走）。

**可动物体试验（2026-10-19）**：room3 钢琴三种做法的对比在服务器 `runs/articulation-trials-20261019/`（`compare/overview.jpg`、`summary.md`），本机 `~/Downloads/RoomCanvas-runs/articulation-trials-20261019/`。方法 2（整台 TRELLIS、Astra 标部件再切开）的钢琴先在本机试验房间 `samples/room3-piano-m2/`（不进 git，`.git/info/exclude`）试过，2026-10-19 换进了正式 `samples/room3`（见上文“小物件这一步的 room3 结果”）。另外发现服务器 `runtime/bin/codex` 链接到已挪进 `archive/` 的 `scripts/codex_api.sh`，`run_room.py` 的 Astra 调用现在会失败，未修，待用户决定。

用户要柜子等能打开。重建时 Astra 生成的程序化物体本来就带关节（`runs/<运行>/pipeline/<场景>/realism_authoring/room/Objects/*/<物体>/sim/<物体>.urdf`，含合页位置、方向、角度范围），只是没传到网页。做了两步：`room_objects.py` 把能和 `Room.glb` 对上的关节写进 `room_objects.json` 的 `joints`（两个示例已用服务器数据重新生成，除新增 `joints` 外与原文件完全相同）；编辑器“预览”模式点门、柜门、窗开合（`web/editor/joints.mjs`），回“布置”全部关上。柜体节点带不均匀缩放，门板挂在柜体下、原点就在合页上，所以按世界里的合页线刚体转动，不在柜体坐标里转（否则变形）。用 Chromium 验证：room3 6 扇柜门和房门、office 两扇窗、升降桌、房门都能开合，转开后部件世界尺寸不变。没做的：手势开门（用户说先不做）；office 抽屉在重建里没有滑轨，要开得改房间重建让 Astra 把抽屉做成活动部件。

## 下一步：RoomCanvas 网站（用户 2026-10-18 定，分支 `feat/roomcanvas-app`）

用户的意思：项目就叫 RoomCanvas，网页应该是 RoomCanvas 自己的网站；现在是 ViewForge 的手势页（`gesture/viewforge.html`，标题“ViewForge 手势布局”、地址栏、开启/关闭摄像头、移动/旋转/仅观察、取消当前操作）套着 RoomCanvas 编辑器，颜色不统一，那排按钮多余。三件事，分两个 PR：

1. **主页 + 手势内置 + 配色统一**（#12，2026-10-18 用户确认后合并）
   - 主页 `web/index.html` 读 `web/rooms.json`：房间卡片显示缩略图（房间目录里的 `thumbnail.jpg`，`web/scripts/thumbnail.py` 用 Playwright 从编辑器截图）、名字、家具组数、模型大小，点进 `editor/?room=<id>`。`?scene=` 仍可用；编辑器里原来那张“载入房间”卡片去掉了，直接加载；左上角 RoomCanvas 回主页。
   - 手势内置：工具栏“手势”开关 → 左上角摄像头卡片（镜像画面、左右手状态、模式标签可点，左手 1/2/3 也能切），工具栏挪到右下、摇杆左下（即原来嵌在手势页里的布局，`data-gesture`）。帧直接喂 `GestureInput`（`web/editor/gesture-camera.mjs`）。关掉手势只结束手上的操作，预览留给鼠标；取消用编辑器自己的“取消”。嵌在 lyk 手势页里时“手势”按钮隐藏，iframe 桥照旧（用模拟消息验证过）。
   - 识别代码：`gesture/` 只新增 `src/embed/`（入口 + 可传资源地址的 tracker）和 `vite.embed.config.ts`（构建时把 `../tracking/tracker` 换成新 tracker，`integration/runtime.ts` 原样用）。`npx vite build --config vite.embed.config.ts` 输出到 `web/vendor/gesture/`（运行时 25 KB + Worker 199 KB，已提交）。wasm 和模型直接读 `gesture/public/vision/`。
   - 配色：`web/theme.css` 放 `--rc-*`，主页、编辑器共用；手的指针从蓝色改成主题绿（`--rc-hand`）；原来暗色模式的 `light-dark()` 实际被强制成浅色，已去掉。`publish.py` 同时复制 `theme.css`、`icon.svg`。
   - 验证：网页单测 142 项（新增 6 项）、Python 8 项、office `check_room` 18/18；手势包类型检查、74 项测试、资源校验、原构建都过。Chromium 假摄像头下 MediaPipe 能在 Worker 里加载、出帧、切模式；**没有真人摄像头验收**，请用户用手试一遍。
2. **仓库“添加物体”：几张照片 → 重建**（#15，2026-10-19 合并，`7b4377b`）
   - 做了什么：后端 `object-reconstruction/scripts/objects.py`（`/viewforge/objects/` 的上传、抠图、重建、进度接口，挂在 `web.py` 上），`run.py`、`prepare_masks.py` 加 `--wait-gpu`（GPU 锁被占时等，不加时行为不变）；`serve.py` 转发这些请求和保存尺寸的 `POST /viewforge/dimensions/<结果>`（只收同源）；编辑器仓库第一张卡片“添加物体”和四步对话框（`web/editor/add-object.mjs`、`add-object-dialog.mjs`）。接口表见 [物体重建说明](OBJECT_RECONSTRUCTION.md)。
   - 验证：后端测试在服务器 ViewForge 环境 76 项通过（新增 5 项），网页单测 150 项、Python 12 项通过。在服务器上用本分支的临时克隆另起 7863 实例（共用数据、缓存和 GPU 锁，正式 7862 没动），本机 Chromium 走完整流程：上传仓库自带的 4 张玩偶示例照片（每张约 10 MB）→ 抠图（BiRefNet 71 秒，去掉 1 张的切换正常）→ 重建（排队 → 深度 → 重建 → 补拍建议，共 7 分 35 秒）→ 结果预览、填高 0.30 米 → 放进 room3。刷新页面后从 localStorage 续上、尺寸自动带出也验证过。临时实例、克隆、隧道已清掉。
   - 留在服务器的测试数据：物体 `测试_玩偶`（`ViewForge/data/inputs/测试_玩偶/`）和结果 `runs/20261018_测试_玩偶_web_232915_330299/`（已标定高 0.30 米），ViewForge 页面和“导入物体”里能看到；不要了可在 ViewForge 页面“删除当前物体”（会移到 `data/removed/`，结果目录保留）。
   - 2026-10-19 合并后已同步服务器、重启 7862 后端（日志 `ViewForge/logs/roomcanvas-web-20261019.log`），本机 `serve.py` 7880 和 7865 隧道已重开。
   - 没做的：GPU 只用 `local.env` 里授权的那一张（现为 GPU0），不在两张卡之间挑空闲的；任务记录在后端进程内存里，重启服务后进行中的任务跟踪不到；补拍（基于已有结果加照片）只在 ViewForge 页面有。
   原计划：
   - 后端（用户 2026-10-18 定）：ViewForge 是本项目的一部分，在本仓库里一起维护、修改，不是 lyk 独立的只读代码。所以直接在现有后端（`object-reconstruction/scripts/web.py` 起的服务）上加给 RoomCanvas 用的接口（通过同服务的 ASGI middleware），不另起服务。流程用仓库 `object-reconstruction/` 的脚本：`import_photos`（导入照片）→ `scripts/prepare_masks.py`（BiRefNet 抠图预览）→ `scripts/run.py`（DA3 深度 + SAM3D 重建，产出 `reconstruction/result.glb`、`preview.glb`）→ 尺寸标定（`dimensions.py`），参考 `scripts/web.py` 的 Gradio 流程。
   - 目录：沿用后端现有的 `VIEWFORGE_ROOT`（`/workspace/geyinuo/ViewForge`：`envs/mvsam3d`、`weights/`、`cache/`、`third_party/`，数据在 `data/inputs`、`runs/`），数据和缓存共用；新重建的物体直接进现有物体目录，编辑器“导入物体”就能读到。GPU 排队用后端已有的 `VIEWFORGE_GPU_LOCK`，一次占一张空闲 GPU。
   - 前端：仓库栏“+ 添加物体”卡片 → 分步对话框：命名 + 上传照片（拖拽，3 张起）→ 抠图预览（可剔除坏图）→ 重建进度 → 结果预览 + 填一条实测边长 → 进仓库（复用现有“导入物体”的显示/碰撞做法）。浏览器经 `serve.py` 转发 + 现有 SSH 隧道（7865）到这个服务。
   - 服务器上的后端是正在运行的服务：改了 `object-reconstruction/` 的代码，同步后要重启它才生效，重启前告诉 lyk（他可能正在用）。`/workspace/geyinuo/ViewForge` 运行目录不挪。

## 光影增强（lyk，#19）

2026-10-20 本地修复（`fix/static-lighting-stability`，尚未提交）：鼠标仅悬停／跨家具／离开画布不再请求重绘，避免清除静态 AO 缓存；新增 `lighting-composite.mjs`，让交互、静态和 `ao=off` 共用线性透明混合、MSAA 与输出转换。物体／相机等真实变化仍按需绘制，停止 350 ms 后补算；AO 缓冲等静止后才分配，静止不常开循环。

新增 `check_lighting_stability.mjs` 验证两个房间 × GTAO／N8AO／关闭 AO：悬停零渲染帧、零 AO 更新、截图不变，实际相机和家具移动后更新，拖动期间暂停 AO。16% 不透明度墙合成测试的平坦区域移动／静止最大 RGB 差为 0，屏幕和离屏均为 4× MSAA；异常后还原状态通过。现有前端单测及 Python 12 项通过，结果与私人截图在 `/tmp/roomcanvas-lighting-stability/`，不进 Git。

统一交互合成增加一次全屏绘制，并沿用屏幕 MSAA 的离屏缓冲。本机 Chrome / Apple M5、office、1440×1000、DPR 1 的有限同轨迹对照（预热后 60 次镜头请求、5 次静态补算）中，交互 GPU p50/p95 修复前 5.91/9.78 ms、修复后 6.29/10.33 ms；静态 GPU 10.28/10.36 → 10.83/10.94 ms。CPU 提交 p50/p95 为 8.50/22.30 → 8.00/23.70 ms。单次短测不能当作稳定 FPS 或其他设备的结论；详细数据为同临时目录的 `performance-compare.json`。

更新：2026-10-19（lyk）。分支 `feat/static-ambient-occlusion`，2026-10-20 以 #19 合入 main（与 #17、#18、#20 合并时只有更多工具里一行开关文字冲突，两边都保留）。原为根目录的 `LIGHT-HANDOFF.md`，合并时并入本节，内容保留；下面记录完成后的状态。

### 当前结果

P0 基线工具、P1 通用校准与可回退导入 PBR 实验、P2 两种 AO 的首轮对照及原生阴影检查已实现并验证。目标是通用场景、低交互开销，保留原有半球光与两盏平行光的类型和位置，无逐房间补丁。**烘焙 GI 不在范围内**，未引入路径追踪或高成本 GI。

参数、测量及来源见 [光影调研](../web/README.md#光影调研)（原 `docs/LIGHTING_RESEARCH.md`，已并入网页说明），完整操作与验收命令见 [web/README](../web/README.md#通用光影增强)。本文其他各节有历史服务信息；本轮没有核对或修改远程运行状态。

| 优先级 | 已实现 | 验证及边界 |
| --- | --- | --- |
| P0 | 可重放相机／布局／显隐、模型 SHA256、固定截图、整帧跨 pass 统计、CPU 提交及异步 GPU query | 两房间五档位；空闲 650 ms 无新帧；GPU 不可用／disjoint 不伪装成零耗时 |
| P1 光照 | 通用 original / initial / balanced 档，一次生成 128 面尺寸 PMREM | 对照后默认 balanced，深色钢琴和窗帘层次更易辨认；不是从照片恢复照明 |
| P1 材质 | “导入物体随光照变化（实验）”：保留已有 PBR、转换 unlit、补法线、受光阴影、原显示回退 | 合成顶点色 GLB 走真实导入／放置／开关流程；原模式开／关灯均 192，PBR 约 173.82 / 0，回退恢复 192 / 192 |
| P2 AO | 相同低分辨率、半径及合成的 GTAO / N8AO；停止 350 ms 后补算 | 没有观察到替换默认方案的稳定优势，继续默认 GTAO；移动暂停，松手后更新 |
| P2 阴影 | 2048² PCFSoft、边界拟合阴影相机、像素尺度偏移 | 原参数近景对照及移动／放置更新检查；透射玻璃、透明预览、碰撞代理排除 AO |

两个房间原有显示材质均是 PBR：room3 运行时 54 Standard + 4 Physical，office 74 Standard + 10 Physical；加载后均有几何法线。导入旧显示是 Basic，受光实验默认关闭，以免拍摄颜色再次受光变暗。摆放中切换会保留草稿并提示先结束摆放。

### 默认参数与入口

| URL 档位 | 半球 / 主光 / 补光 | 曝光 | 环境 |
| --- | --- | ---: | ---: |
| 默认或 `lighting=balanced` | 1.1 / 3.0 / 0.65 | 1.1 | 0.35 |
| `lighting=initial`（第一版增强） | 2.5 / 2.4 / 1.4 | 1.15 | 0.18 |
| `lighting=off`（完整原始） | 2.5 / 2.4 / 1.4 | 1.15 | 0 |

正常启动：`python3 web/scripts/serve.py` → `http://127.0.0.1:7880/web/`，无需额外后端或构建步骤。本轮临时 7881 在收尾停止，原有 7880 保留；请求队列修复需重启旧 serve.py 才生效。

- `ao=off` / `ao=n8ao`：关闭 AO / 对照 N8AO；默认 GTAO。
- `env=off`、`shadows=original`：分项对照；比较算法时使用相同 lighting 档。
- `materials=pbr`：预选导入受光实验，也可从更多工具切换。
- `lightingLab=1`：才开放 `roomLightingLab` 的状态重放、材质审查、镜头回放及 GPU 计时；正常页面无该测试接口。

### 关键代码与兼容

- `web/editor/scene-editor.js`：现有渲染／导入生命周期的接入、只读 roomEditor、显式 lab。
- `lighting-profiles.mjs`、`environment-lighting.mjs`、`lighting-settings.mjs`：档位、PMREM、原阴影校准。
- `static-lighting.mjs`、`settled-render.mjs`：有限静态 AO，半宽／半高、长边最多 960、混合 0.35；后台暂停，截图保留效果。
- `render-metrics.mjs`：在交互／静态 AO／截图各阶段外重置并汇总 renderer.info，修复原末个 pass 的 renderCalls=1 误导；CPU 提交不等于 GPU 或端到端帧耗。
- `import-materials.mjs`：原显示与受光版本独立，原材质／贴图不被修改；补法线克隆几何，碰撞代理不变；受光卡片沿用当前环境。
- `web/scripts/check_lighting.mjs`、`check_import_lighting.mjs`：可重放的浏览器验收，Playwright 只是开发依赖。
- `publish.py` 更新旧预览的 vendor；`serve.py` 请求队列增至 64，避免并行模块连接重置。编辑器缓存版本 app-38。

引擎保持 Three.js r180。N8AO 固定 1.10.2 / commit `6481f6b39f6ec0301b43648492833cdb8bcd99ac`，只取独立 Pass，移除未用 N8AOPostPass 入口并对齐 import map，不引入完整 postprocessing 框架。adapter 已补其空 dispose 的资源释放，关闭透明自动探测、时域累积和内部 gamma。源码与许可证／npm 标记差异见 [vendor 说明](../web/vendor/n8ao/README.md)。

### 已跑验证与结果位置

- 前端 **166/166**；Python **12/12**；33 个 JS/MJS 模块语法通过。
- room3 **23/23**（9 条原模型提示）；office **18/18**（1 条原模型提示）。几何、布局与碰撞算法未改。
- 两房间五档位：1440×1000、DPR 1、实际画布 1414×704，Chrome 无头、ANGLE Metal / Apple M5、Three r180，手势摄像头未开。每档 60 次同轨迹镜头请求、5 次有限静态补算，另记加载到 settled 与首次初始化。
- 默认 GTAO 预热后静态补算：room3 CPU p50/p95 5.70/6.20 ms、GPU 12.16/14.06 ms；office CPU 13.90/16.10 ms、GPU 9.01/9.11 ms。CPU/GPU 可重叠，不能相加或推导稳定 FPS；这是单机短序列结果。
- 普通页面的默认档、无 lab 接口、暖光、空闲、家具移动、松手补算、取消通过；导入另验摆放草稿保留及切回原显示。

原始报告与私人截图均在仓库外，不加入 Git：

| 路径 | 内容 |
| --- | --- |
| `/tmp/roomcanvas-lighting-final/` | 五档位 report.json、模型指纹、固定状态、整体／近景截图 |
| `/tmp/roomcanvas-lighting-glass-check/` | 最后补充透射玻璃排除后的两种 AO 回归 |
| `/tmp/roomcanvas-lighting-shadow-check/` | 原阴影近景对照 |
| `/tmp/roomcanvas-import-lighting-final/` | 最终导入／受光／回退验收与像素响应 |

临时目录不是长期存档，需保留时复制到仓库外稳定目录。重跑命令见 web README；本机已有 Playwright 模块在 `/Users/lyk/.cache/uv/archive-v0/V2lEP-Ob1puP69RiKEEa-/playwright/driver/package`，Chrome 在 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。这是本机验收配置，不写入产品代码。

### 后续验收与限制

1. 用户截图的床面细小黑点未在固定镜头稳定复现；需保存同一视角进一步定位，不宣称所有伪影已消除。（2026-10-20 合并前核对：同视角下合并前的 main 床单上也有同样的黑点，是床单贴图自带的；另一类“马赛克方格”是隔着变淡的透射玻璃看到的，已在 #18 修掉。）
2. 真人手势并行、更多设备及不同 DPR／大画布未量测；未测实际显存字节数，不能把纹理数量当显存大小。
3. 本轮只读查询 7865 隧道的物体目录为 0 项。合成实验验证路径生效；真实重建颜色的二次明暗和纹理／金属表面需要有资产后视觉验收，暂保留实验开关。
4. 共同规则已覆盖当前两个场景，不等于证明所有未来场景更真实。未做反照率分离；通用环境不是局部真实反射或 GI。
5. 后续提交前审阅整批未提交更改、vendor 来源与许可、生成物排除。本轮没有提交、推送、合并、发布或操作重建服务器任务。（之后已随 #19 提交并合入；N8AO 为 CC0 许可。）

常用检查：`node --test 'web/editor/tests/*.mjs'`、`python3 -m unittest discover -s web/scripts`，以及 `node web/scripts/check_room.mjs --scene-dir samples/room3` / `samples/office`。

## 产品方向（用户 2026-10-18 提出）

做成一个网页（以后加自己的 App 扫描和展示）：扫描房间 → 清空 → 加入物体（自己拍几个视角、可补拍、按实际尺寸重建；或给一个商品链接，找多视角图和尺寸后重建；以及房间原有的物品）→ 在房间里自由布置，网页上用鼠标或摄像头手势操作。

| 环节 | 现状 |
|---|---|
| 扫描 → 真实尺寸房间 | 有（LiteReality + Astra），慢且贵（room3 几小时、约 $69），产品化要降成本 |
| 清空房间 | 差一步（`room_objects.json` 的 `role` 已有，见待办 2） |
| 自己拍物体 → 按尺寸重建 | 基本有（ViewForge），尺寸目前靠用户填一条实测边长 |
| 商品链接 → 多视角图和尺寸 → 重建 | 没有；重建部分可复用小物件流程（参考图 → TRELLIS → 按商品尺寸缩放），注意网站条款 |
| 网页布置 | RoomCanvas 主页 + 编辑器，内置手势，可导入 ViewForge 物体（`feat/roomcanvas-app`）；ViewForge 布局页仍单独存在 |
| 手势 | 有（`gesture/`，协议与页面无关），编辑器已能接收 |
| 后端 | 没有：需要接收上传、排队跑房间/物体重建、两张 3090 调度、存结果 |

建议顺序：1) 一个网页里 room3 + 手势 + 导入 ViewForge 已有物体，先验证体验（#8 已合并；下一步把手势内置、做主页，见上节）；2) 网页上传照片 → 服务器重建物体（补拍、填尺寸）→ 放进房间；3) 清空房间；4) 商品链接重建；5) 网页上传扫描 → 房间重建排队，同时降成本；6) App。ViewForge 和手势是 lyk 的部分，合成一个网页前先和 lyk 商量分工。

## 待办和待决定

1. **编辑器性能**：落点的完整检查已移到后台线程（2026-10-18，用户反馈手势放钢琴卡），手势和确认不再冻住；方向按钮逐步挪动、鼠标悬停摆放仍在页面线程。原记录：只有两个重网格挨着时慢，room3 里是琴凳贴着钢琴，每步约 2 秒；同一把椅子放到房间中央只要 2 毫秒，office 的 TRELLIS 椅子也只要几毫秒。“每个连通部件只测一个点”的捷径会漏判（钢琴由 23 块重叠壳体组成），已放弃。以后要做就给重网格做简化碰撞外形，或放到 Web Worker。
2. **清空房间、导出空房间**：按 `room_objects.json` 的 `role` 删家具，导出 `empty_room.glb`。窗帘、挂画、白板算不算家具未最终定（现在窗帘留在房间，挂画、白板算家具）。
3. **room3 视觉验收没过，是否照样 publish**：(a) 用现有结果跑 publish 和 simulate，(b) 先提升效果再重跑，(c) 先 a 后 b。
4. **嵌入式家具三层方案**（自动识别开凹槽 / 交给修复和布局 Agent / 剩余的人工确认），还没做。
5. 协作者：lyk（`jbykkk`）已加入；审阅规则（是否要求批准）待用户定。
