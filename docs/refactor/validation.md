[重构说明与文档导航](README.md)

# 重构验收记录

更新：2026-11-18。开发分支 `refactor/reliability-start`，基线为官方 `main@d8842f65c1c1e0d0a6abd0bd1f6b7fc134ca5b7e`。源码位于本地 `runs/refactor-worktrees/reliability`；服务器仅使用独立 `validate/scut407-gpu0` worktree。正式目录未部署本轮代码。

## 范围与结果

| 计划 | 实现与验收证据 |
| --- | --- |
| 0A、0B | 首页/重建/回收站 Node 测试进入 CI；真实模型、分段耗时、long task、活动页面、射线和回放资源均有验证工具及固定样本。新增物体数组/代理/质量回归也进入 CI。 |
| 1A | 并发 JSON 保存按请求发起顺序原子发布；小物体并行结果由协调线程逐项保存。覆盖后发失败、线程并发、中断和续跑。 |
| 1B | 新鲜 `.blend`、布局和烘焙成功共同决定编译成功；真实 Blender 故障注入不再用旧文件冒充成功，重试和 publish 通过。 |
| 1C | 大网格边界计算改为循环；20 万顶点/三角面回归通过。 |
| 1D | 房间解压移出状态锁，暂存完成才发布；照片解码在线程池限流。同 ID 并发、健康请求、局部失败提示及补拍回滚通过。 |
| 1E | 房间、物体、COVER 按物理 GPU UUID 共用锁，并兼容旧锁和子进程继承；GPU 0 双向争锁、失败释放、真实重建通过。 |
| 1F | 已有 JSON 的断线/502/503/504 回退带来源标记；404、无缓存、任务版本更新分别处理。 |
| 2A、2B | 不可变实体基准几何贯通渲染/碰撞/支撑。移除永久相交豁免；真实三角形可证明的浅交叠允许移离，禁止加深、重入和重叠旋转。移动/升降、承载、导入/删除、还原、Worker 一致性通过。 |
| 2C | `asset.json` 原子冻结坐标、材质能力和文件集合；区分 mesh/asset/recommendation ready。推荐不能更改标定；未就绪返回 409，旧完整结果有兼容路径。 |
| 3A | TRELLIS 内容 receipt 贯通 seed/纹理/减面/force，缓存包含输入、参数和代码；articulate/small_objects 按完整上游输入失效。真实同输入缓存、改变 seed 实算，以及强制失败不发布旧模型的回归通过。 |
| 3B | 上传/ingest 共用扫描配对与矩阵规范；阶段结果携带错误类别、重试性和产物有效性。任务/API/UI 区分执行、可用性、质量和增强结果；失败尝试不能借用旧成功 attempt。 |
| 3C | schema 2 事件包含稳定 ID、顺序、attempt、阶段、结果和内容摘要，支持多进程、幂等、半行恢复、终态 fsync。回放新事件与旧推断适配分开，修改 mtime 不改新事件时间，外部改写标记未知。真实 Blender 产生 14 条带摘要和连续顺序的事件。 |
| 3D | author 多文件/资源一致检查点与输入配置摘要；损坏回退、输入变化、force 备份均验证。阶段开始先持久化 running 与下游失效，进程中断不能复用半成品。 |
| 4A | 独立无材质 collision.glb，逐连通分量减面，拓扑/边界/双向距离不合格则保留原分量。薄腿、孔洞、桌面及真实消费者对照通过。 |
| 4B、4C | 每实体支撑/BVH 增量复用，Worker 只传变更且拒绝旧代回包；最近射线使用实时关节和承载变换。三房间 1,990 次原生/索引射线对照无差异。 |
| 4D | DA3 单份 NHWC float32 存储，NCHW 按需视图；兼容旧 NPZ。数值、磁盘/内存基准及固定输入 GPU 0 下游重建对照已执行。 |
| 4E | 回放释放旧 root、wall fade、warm/active/克隆材质；取消晚到加载、解码及预热，释放等待在途编译；每视图复用成形材质。24 draft 真实 WebGL 验证通过。 |
| 4F | refine 子进程异步运行，取消时终止 Blender 子进程，closed/open 复用同一有效构建；心跳、取消、输入内容变化和构建次数回归通过。真实渲染对照见下节。 |
| 5 | 抽出几何、Worker、导入实体、仓库卡片和查询模块；两个 tracker 共用生命周期；房间 HTTP、任务、执行、状态分离。配置顺序与 legacy/上游 walk/Android 维护边界见 [契约文档](contracts.md)。 |

## 自动化与真实浏览器

| 检查 | 结果与环境 |
| --- | --- |
| 房间 Ruff / 完整默认 pytest | 本机 `uv.lock` + Python 3.12：Ruff 通过，884 passed、2 skipped；服务器 Python 3.11：同样 884 passed、2 skipped。两项跳过需要仓库未附带的 Office_room 原始扫描。默认不运行付费模型/live 标记。 |
| 网页 Node | 297/297；包含页面流程、碰撞、Worker、支撑、漫游、回放资源。 |
| 网页 Python | 96 项，95 通过、1 项因本机 OpenCV 缺失跳过；服务器单独运行回放 29 项全部通过，包含该 RGB-D 颜色用例。 |
| 物体 Python | 12 组 CI 套件共 75/75，服务器 Open3D 环境无跳过；其中代理 2 项、重建质量 7 项，最终质量报告 7 个分项全部通过。 |
| 真实样例几何 | office 18、room3 23、room-3934 60，合计 101 项通过。 |
| 手势 | TypeScript、105 项测试、资源清单、独立页构建、embed 构建通过；已重建 `web/vendor/gesture`。Chrome 伪摄像头下两个入口各启停 2 轮，每轮至少 3 帧真实 MediaPipe 推理；资源全 200、Worker 退出、相机轨道结束、无页面异常。 |
| 编辑器 | Chrome 157 / Apple M5 / Metal，1440×1000、DPR 1、balanced-no-ao、关闭手势；三房间各五轮导入删除、关节和 WASD 检查通过。最终真实 Worker 第 3 代与主线程一致，钢琴及琴上物体升高后扫掠/落点通过。 |
| 回放 | 24 次 draft 替换、成形中切换、回拖、1/2/8 倍速、灯光、晚到加载、同 key 重试、解码取消、预热期间关闭通过；稳态 8 geometry、9 texture、13–14 program，清空后旧 root/active/clone 引用为零。 |

房间唯一警告来自退化体积测试的 trimesh 数值运算，预期回退行为通过。初次用临时、未锁定依赖环境运行遇到缺失 SciPy 和 MCP 版本不匹配；最终验收使用项目 `uv.lock`，未为绕过依赖问题放宽代码或断言。

房间观测另补齐：`job.json` 记录每次重新入队后的等待/执行时间；每个 attempt 的 `runtime-timing.json` 记录 GPU 锁等待、持锁区间及 pipeline/articulate 子进程的墙钟/CPU 时间；阶段状态保留每次有限重试的独立时间与结果。两种 Agent harness 都记录 `.litereality/agent-timing.jsonl`，区分流等待期间存在已发工具的区间、模型/harness 等待、调用方处理时间。Claude 提供原生 API 时长时保留来源；Codex 未提供精确 API 时长则为 null。GPU 持锁时间包括 CPU/API 工作，不能当作 CUDA kernel 时间；并发和嵌套时间不能简单相加。日志放在隐藏元数据目录，不改变源码/资源指纹。完成/失败/取消、并发写入、缓存不重复计时及不可写日志的行为均有回归。

从 `room-reconstruction/` 执行 `uv run python -m litereality_agent.timing /path/to/job` 可生成只读 JSON 汇总，历史任务缺失字段明确未知，不倒填虚构耗时。

补充 `check_editor_latency.mjs` 在同设备每个房间五轮新 context + 同 context reload，各采十次真实滚轮输入，共 150 次。下表延迟从浏览器收到事件到首个实际绘图的 RAF 回调完成，不含操作系统输入、GPU 完成及合成器呈现。所有样本页面可见且聚焦、相机实际移动。

| 场景 | 首开 / 同 context reload 中位数 | 输入到绘图 p50 / p95 / 最大值 |
| --- | --- | --- |
| office | 2,954.0 / 2,883.3 ms | 24.8 / 28.5 / 29.3 ms |
| room3 | 4,720.2 / 4,766.9 ms | 1.9 / 2.6 / 2.6 ms |
| room-3934 | 6,253.2 / 6,389.2 ms | 6.0 / 7.3 / 7.6 ms |

这里的热加载表示同一浏览器 context 重载，仍遵循当前文件重验证策略；报告保留实际传输字节，GLB 正文仍被读取，不能解读为跳过了解析/BVH。该补测未采用前面照明基准的 API 路由模拟，不能与其导航时间直接做版本加速比。

回放新增 `compileShader` 调用与 `compileAsync` 时长观测。前两次 warm 为 13.8/13.4 ms，第 3–24 次 warm 中位 0.3 ms、最大 0.4 ms；切换后仍会有 shader API 调用，但未观测到每轮重复的编译尖峰。报告保留每次调用，不把程序数量稳定等同于零编译。

## 性能与质量

同条件重复五轮的详细数据见 [编辑器记录](editor-validation.md)。以下是具体工作负载的收益，不代表所有场景端到端耗时。

| 指标 | 原版 → 重构 |
| --- | --- |
| Room_3934 导入索引重建中位数 | 4,159.0 → 26.4 ms |
| Room_3934 删除索引重建中位数 | 4,377.6 → 16.8 ms |
| 导入删除期间最长主线程任务，五轮中位数 | 8,771 → 245 ms |
| 54 条漫游射线 CPU 中位数，office / room3 / room-3934 | 34.8 / 70.4 / 19.0 → 2.6 / 1.1 / 5.1 ms |
| 真实物体完整网格 / 碰撞代理 BVH 构建 | 1,055.97 → 29.53 ms（Node 24，预热后五轮） |
| 碰撞准备总 CPU，含解析和提取 | 1,138.24 → 33.82 ms；显示模型和贴图保留原件 |
| DA3 NPZ 磁盘字节 | 19,816,028 → 6,098,902 |
| DA3 pointmap 数组字节 / 进程峰值 RSS | 18,289,152 → 4,572,288 / 81,375,232 → 56,066,048 |
| TRELLIS 同输入缓存 | 首次 392.52 s；复用 0.89 s，无 GPU 调用、文件摘要和 mtime 不变；改变 seed 重新计算 172.99 s |

代理实测：314,064 → 12,196 面，11,510,452 → 220,028 字节；两个分量中的一个未通过减面质量要求，自动保留原几何。49 次放置判断、12 次扫掠的阻挡结论、281 条射线的命中结果均一致。接触位置最大差 0.000205 倍对角线，射线距离最大差 0.001639，低于预设 0.005 容差。单次查询并非全面加速：首次 49 姿态检测 326.69 → 21.84 ms，稳态扫掠批次 8.88 → 5.90 ms，射线 0.91 → 1.43 ms，放置判断 3.63 → 4.84 ms；主要收益是导入时的索引准备。

DA3 数值最大绝对误差 3.12e-8、最大相对误差 1.12e-7。旧版与新版同照片、seed、配置、相机和坐标做下游几何、材质、COVER 与支撑检查，7 个分项全部通过，不要求 GPU 结果逐字节相同。8,321 条支撑探针中两边各命中 7,128 条，命中一致率 100%；5,507 个稳定水平内点最大高度差为对角线的 8.68e-5。原始极值探针有一条跨层边界，最大差 0.1418：两层表面均存在，双向最近距离极小，但竖直射线因微小横向变化切换了最先命中的层。最终检查保留这个原始失败指标；稳定水平内点仍使用原 2%/5% 高度阈值，所有超过 2% 的原始异常必须逐条满足双向最近距离 ≤1e-4 对角线，以及 8 点邻域全部命中且高度差 ≤原 2%。这一个异常满足上述条件，未解释异常为零。斜面抬高、支撑丢失和超过 20 条异常的反例不可绕过此检查。该判定衡量有限探针，不声称证明所有微小支撑面完全相同。

## GPU 0 运行记录

服务器 `scut407`，独立源码 `/home/data1/lyk/RoomCanvas-validate-gpu0`，证据根目录 `/home/data1/lyk/roomcanvas-validation-gpu0`。使用 RTX 4090 物理 GPU 0，UUID `GPU-75569c5b-3b01-b1b6-4430-2735806177a8`；采样进程 PID 和 UUID，遵守共享锁。未使用 GPU 1，未终止他人进程。

| 运行 | 实际结果 / 相对证据路径 |
| --- | --- |
| 物体完整双图链路 | `objects/logs/gpu0refactor1/summary.json`：复用掩码 2.51 s，DA3/重建/COVER 345.46 s，GLB 10,977,780 字节、PLY 18,788,000 字节；重建与推荐完成。其冷暖条件与首轮不同，不能把耗时差称为受控加速。 |
| DA3 / 代理 / 下游对照 | `objects/refactor-assets/da3-arrays-benchmark.json`、`proxy-report.json`、`downstream-quality-final.json`。 |
| TRELLIS 首次 / 命中 / seed 变化 | `trellis/summary.json` 与三个阶段的日志、GPU 采样。参数 seed 42/43、decimation 50000、texture size 4096；输入摘要在报告内，权重只读复用。 |
| Blender 编译与故障恢复 | `blender/attempt-iZ3ycdfe/result.json`：首次 47.04 s，缓存无额外烘焙，注入失败 10.25 s，重试 46.93 s；成功均 45 张贴图、80,396,460 字节 GLB。 |
| Blender publish | 同目录 `publish-results.json`：36.47 s 发布成功，无质量警告，45 张贴图；注入 `.blend` 保存失败后 12.52 s 返回失败，旧 `.blend` 保全、成功标记移除、无额外烘焙。 |
| 新版编译事件 | 同 attempt 的 `pipeline/capture/scene_init/obj_stage/traces/trace.jsonl`：14 条 schema 2 事件，含摘要、ID、顺序和结果。故障后的未烘焙候选没有成功 baked 事件。 |
| refine 构建复用与异步调度 | `refine/n93mky90/results/summary.json`：真实 `Wall3_Door_0` 关闭/打开/关闭三姿态、每姿态四视图，旧版 3 次 build + 3 次 render，新版 1 次 build + 3 次 render；单轮 10.575 → 8.272 s。快照期间异步心跳从 0 次到 402 次，最长间隔从 4.392 s 到 27.7 ms。12 对 PNG 最大像素差 1/255、最大平均误差 4.58e-5/255，开/关门图像有明确差异。 |

复现入口：证据根目录的 `objects/validate.py <新任务名>`、`trellis-validation.py`、`RC_WITH_PUBLISH=1 bash blender/run.sh`。脚本采用新的输出目录；TRELLIS 复现需给脚本另一个尚不存在的输出目录。基础 Python、Blender 与模型环境未修改。

refine 对照冻结 `007a136` 与 `e707834` 模块，同一个 renderer 源码摘要；隔离 wrapper 在两边都固定 Cycles GPU 0、seed 42、512×512、32 samples，避免 Blender 5.1 的旧 EEVEE 枚举回退为 CPU 影响对照。未修改正式环境或 worktree 的 renderer。这里的单轮耗时只作为观测，构建次数、心跳不中断和像素容差是主要验收项。

## 验收边界与保留

- 初次大模型 BVH 仍约 2.7 秒；本轮改善了增删与查询，没有消除所有启动成本。深交叠、凹形互锁和重叠旋转遵循明确保守规则，受阻时先收起再放置。
- 硬件验证覆盖物体完整链路、真实房间 seed 的编译/发布、TRELLIS、refine；未重新付费运行整房多 Agent 创作或完整 articulate 模型推理。相应恢复/缓存/错误路径有受控回归。模型质量对照使用一个双图 fixture，不外推所有物品。
- Android、上游独立 walk、真人手势准确率未做设备验收；本轮未改变它们的交互算法。legacy 删除、大文件/LFS 迁移、历史重写、模型常驻、渲染器切换与正式部署均不在批准的默认实施范围。
- 保留本地开发 worktree、服务器独立验证 worktree、复现脚本和原始报告供审查；合并审查及证据保全后可清理。正式目录保持 `main@d8842f6`。验证分支 README 保存服务器记录。
- 结束时已核对本次 GPU 验证进程退出；正式目录和验证目录的受版本控制文件无未提交改动。最终文档提交随后只更新独立验证分支。

本机原始报告：`/private/tmp/RoomCanvas-editor-incremental/`、`RoomCanvas-editor-final/`、`RoomCanvas-editor-latency.json`、`RoomCanvas-replay-shaders.json`、`RoomCanvas-tracker-browser.json`、`RoomCanvas-proxy-benchmark/report.json`。均不含本次提交的模型/照片；私人模型和截图未加入 Git。
