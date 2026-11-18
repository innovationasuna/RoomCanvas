# 本次重构主要改动

2026-11-18。本文说明本轮实际完成的改动，以及它们解决的问题。实现基于 `main@d8842f6`，保存在 `refactor/reliability-start`；源码和验收记录截至 `48cf0d0`，本次文档整理不改变运行代码。尚未合入 main 或部署到正式目录。

本轮重点是消除任务失败与状态不一致，减少编辑器重复计算，并把缓存、产物和恢复条件写成明确契约。最直接的变化是：增删物品不再重建整个房间的索引；失败重试不会拿旧模型冒充成功；资产标定不再随推荐计算改变；回放和手势运行时能正确释放异步资源。

## 文档怎么读

| 文档 | 用途 |
| --- | --- |
| **本文** | 先了解主要改动、用户可见变化和代码职责。 |
| [实施计划](plan.md) | 批次 0–5 的原始目标、依赖、完成矩阵及关键提交。 |
| [完整验收记录](validation.md) | 最终测试数量、性能口径、质量对照、GPU 0 证据位置和未覆盖边界。 |
| [编辑器专项验证](editor-validation.md) | 原始接触规则、真实 Worker、增量索引、漫游射线与浏览器实测。 |
| [配置与维护契约](contracts.md) | 配置优先级、GPU 共享锁、兼容接口及 legacy / 上游 walk / Android 的维护边界。 |
| [最初代码审查](history/initial-review.md) / [第二份审查意见](history/second-review.md) | 保留重构前的判断依据；其中的旧问题、旧数字和建议不代表最终实现。 |

实现范围看本文与实施计划，是否验证通过看验收记录；配置和后续维护以契约文档及源码为准。历史意见不再作为当前待办清单。

## 1. 编辑器：统一几何，减少重复计算

### 修正移动后重建的坐标错误

原先从已经应用布局的场景中再次提取几何，可能重复应用移动、旋转或升降；导入一个新物品后，原有家具的显示、碰撞和支撑位置就可能不一致。同名网格也可能查到其他实体的节点。

现在每个实体保留不可变的基准几何，通过同一套位姿接口派生渲染、碰撞和支撑坐标；节点查找限制在所属实体内。移动或抬高家具后，再导入、删除其他物品，原物品及其承载物的位置保持一致。收纳、撤销、重做、恢复原布局也沿用同一几何契约。

代码入口：[entity-geometry.mjs](../../web/editor/entity-geometry.mjs)、[scene-entities.mjs](../../web/editor/scene-entities.mjs)。

### 移除原始相交的永久豁免

原始扫描中的一对网格如果最初相交，过去可能持续跳过这对网格的碰撞判断，导致搬开后仍能重新穿入。

现在原始布局仍可展示、恢复和撤销，每件物品都能在扫描位置原地确认。扫描时就相交的一对网格不再整对跳过：两边各自拆成连通部分，只有扫描时确实相交的那一对部分按穿入深度判断：任何姿态下，穿入不超过扫描时的深度加 5 mm 即可放置，朝任意方向移开、抬起后原地放下、不加深的旋转都允许；比扫描时穿得更深的移动在越界处停下。扫描时没有接触到的部分和其余网格对一样，走普通的三角形相交检查和扫掠，没有额外余量。

深度取这一对连通部分各自凸包面和包围面上的最小穿出距离，拖动哪一件结论都相同；同一个凹形连通部分内部仍按凸包计算。选中物品时预先算好这些面，拖动时只做平移量的加减。这是一套有明确边界的保守规则，不是通用的网格解穿插算法。相关实现集中在 [collision.mjs](../../web/editor/collision.mjs) 和 [placement.mjs](../../web/editor/placement.mjs)。

### 增删物体只更新受影响的实体

原先每次导入、删除都会重新提取全屋几何，重建支撑和碰撞 BVH，并向 Worker 重发全量数据。现在静态房间和未变化实体的几何、支撑采样和索引都能复用；Worker 只接收新增、变化或删除的实体。请求携带版本，旧版本的晚到结果不能确认新布局，错误或切换时等待中的请求也会结束。

漫游和部件点击增加最近射线接口，复用几何与 BVH；查询采用门、抽屉和承载物的实时世界变换，并保留地面、隐藏、收纳等过滤规则。大数组求边界改为循环，避免大网格触发 JavaScript 参数数量上限。

代码入口：[scene-geometry.mjs](../../web/editor/scene-geometry.mjs)、[collision-client.mjs](../../web/editor/collision-client.mjs)、[ray-queries.mjs](../../web/editor/ray-queries.mjs)。

## 2. 物体重建：资产发布稳定，几何与数组更轻

### 区分模型生成、正式可用和推荐完成

新流程的结果仅看到 GLB 文件，不再等于资产已经能导入和标定。新的 `asset.json` 在模型、材质能力和坐标信息齐全后原子发布，冻结文件集合和稳定变换；状态分别表示 `mesh_ready`、`asset_ready`、`recommendation_ready`。未就绪资产的标定请求返回 409。已发布资产的文件被重新生成后，只要文件本身完整就继续提供，损坏时才隐藏；发布前的旧结果和手工放入的结果，模型文件完整即可使用。“完整”指 GLB 和二进制 PLY 的实际长度等于文件头声明的长度，文本 PLY 或含列表属性的 PLY 以能否完整解析为准（结果按文件身份缓存）；模型损坏会阻止发布和下载，只有相机拟合失败才降级为未对齐的模型。

COVER 可以在资产发布后继续生成补拍建议，但不能再改变已发布的坐标和尺寸契约。补拍生成新结果，不修改已导入的旧实例。已有完整历史结果和手工 GLB 仍有明确兼容路径。

代码入口：[asset_state.py](../../object-reconstruction/scripts/asset_state.py)、[assets.py](../../object-reconstruction/scripts/assets.py)、[dimensions.py](../../object-reconstruction/scripts/dimensions.py)。

### 为碰撞单独生成轻量模型

默认 PBR 结果现在额外生成不带材质的 `collision.glb`，完整显示模型和贴图保留原件。减面逐个处理连通分量，并检查拓扑、包围范围及双向表面距离；不合格的分量保留原几何。薄腿、孔洞、桌面支撑有专门对照。

前端按 `collision.glb → preview → 完整模型副本` 的顺序选择碰撞模型，旧结果也能导入。收益主要是更少的解析、几何提取和索引构建，不意味着每类稳态查询都更快。

代码入口：[collision_proxy.py](../../object-reconstruction/scripts/collision_proxy.py)、[object-import.mjs](../../web/editor/object-import.mjs)。

### 减少 DA3 pointmap 的重复存储

pointmap 统一为 float32，只保存一份 NHWC 布局；需要 NCHW 的消费者使用转置视图，避免同时保存两套大数组。旧 NPZ 的读取兼容保留，深度、相机内外参和坐标约定保持一致。

新增数组基准和下游质量检查，固定输入、seed 和配置比较几何、材质、支撑及 COVER。GPU 输出允许合理数值差异；原始异常探针和解释规则都保留在报告中。

代码入口：[da3_arrays.py](../../object-reconstruction/scripts/da3_arrays.py)、[check_reconstruction_quality.py](../../object-reconstruction/scripts/check_reconstruction_quality.py)。

## 3. 保存、上传与 GPU：避免并发破坏状态

| 原问题 | 本次处理 | 实际影响 |
| --- | --- | --- |
| 并发请求覆盖缓存，较早请求晚返回可能覆盖较新结果 | JSON 原子发布，按请求发起顺序裁决；后发失败时仍允许先发成功结果保存 | 保留最新有效结果，不因临时文件重名或返回顺序丢状态。 |
| 小物品并行生成同时更新进度 | 生成继续并行，由协调线程逐项持久化 | 单项失败或写入中断后可以续跑。 |
| 房间上传解压持有全局状态锁 | 先在暂存目录解压校验，再短暂加锁发布扫描与任务 | 大包上传期间健康检查和任务查询仍可响应，同一上传 ID 只入队一次。 |
| 照片解码阻塞异步请求，部分失败难以重试 | 在线程池限流解码，暂存后发布，记录具体失败文件 | 同名修正重试、部分成功提示及补拍回滚有明确行为。 |
| 房间、物体和 COVER 用不同锁争同一张卡 | 按物理 GPU UUID 共享锁，兼容旧锁并让子进程继承 | 不同 GPU 编号映射下仍能正确互斥；失败后释放锁。 |
| 服务短时离线导致已有房间无法读取 | 已保存 JSON 可在断线和 502/503/504 时回退，并用响应头标记来源 | 有缓存时仍可查看；404 和无缓存情况保留真实错误，任务版本变化会重新拉取缺失文件。 |

代码入口：[room_cache.py](../../web/scripts/room_cache.py)、[room_scan.py](../../web/scripts/room_scan.py)、[objects.py](../../object-reconstruction/scripts/objects.py)、[roomcanvas_gpu.py](../../scripts/roomcanvas_gpu.py)。

## 4. 房间流水线：缓存、失败和恢复有可检查的依据

### 编译失败不能冒充成功

编译和 publish 现在共同校验本次产生的 `.blend`、布局及烘焙结果，正确传播子进程失败。旧输出存在不能证明本次成功；故障注入验证了旧 `.blend` 保全、成功标记撤销以及恢复后的重新生成。几何质量检查读取本次发布生成的布局。

### 缓存绑定输入内容和参数

TRELLIS 的 seed、减面、纹理尺寸及 force/skip 参数贯通 flow、Local/Modal 服务和启动器。缓存凭据包含输入内容、模型/代码版本和参数；失败后旧 GLB 不得冒充新结果。

articulate 与 small_objects 将候选、参考图、计划、切割、检查和最终产物作为有依赖关系的一组缓存处理。输入改变时整组失效；不能证明来源的旧缓存移到 `.stale` 保留检查。即使文件大小和 mtime 没变，内容变化也会被识别。

### 先记失效，再执行；恢复使用一致检查点

阶段开始前持久化 `running` 和下游失效状态，避免进程被中断后仍留下旧的“已完成”标记。阶段指纹只包含该阶段读取的内容和用到的模型配置，不含自身产物、源码和任务目录的位置；没有指纹的旧记录视为有效。只有阶段自己的输入变了才强制从头开始，下游失效和失败后的重试都接着已有进度跑；author 例外：决定从头开始时（显式强制，或 `.author_inputs` 记录的输入与当前不同）先在 `realism_authoring/` 下写入 `.author_pending`，旧房间只挪开一次，新 seed 先复制到 `.room-copying` 再改名就位，然后写入 `.author_inputs` 并清除标记；标记存在期间每次重试都继续从头开始，复制到一半的目录不会被当成房间。只有超时、连接等瞬时错误在运行内自动重试；用户对失败任务的重试只在明确判定为输入错误时拒绝。

author 在原有工作目录基础上保存多文件源码、必要资源、输入/配置摘要和完成情况。恢复前校验对应关系，支持损坏回退和 force 备份；语法有效的检查点与通过 Blender 构建的产物明确区分。

上传与 ingest 共用扫描目录、相机矩阵、照片/深度帧配对规则，已知输入缺陷在入队前报告，避免上传接受后才因另一套规范失败。

### refine 不阻塞其他 Agent

refine 的 Blender 子进程异步等待，取消时终止该子进程；同一份有效构建供关闭/打开等多个姿态渲染复用。真实门模型三组快照的构建次数从 3 次降到 1 次，渲染仍为 3 次，其他异步任务能在渲染期间继续运行。

代码入口：[pipeline/runner.py](../../room-reconstruction/src/litereality_agent/pipeline/runner.py)、[artifact_cache.py](../../room-reconstruction/src/litereality_agent/artifact_cache.py)、[author_checkpoint.py](../../room-reconstruction/src/litereality_agent/agent/author_checkpoint.py)、[refine_objects.py](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/author/refine_objects.py)。

## 5. 任务结果、回放与耗时：不再混用不同事实

任务/API/UI 分别展示执行状态、产物是否可用、质量结论和可选增强结果。质量 warning 沿用原有发布策略，不擅自改成硬失败；可动部件报告区分已有、候选、新增、跳过和失败，新增为零时有原因。只有本次新 attempt 的成功结果能进入发布，旧成功记录不能让新失败显示完成；可选增强失败时，完整基础房间可以作为明确标记的回退。

事件升级到 schema 2，记录 job/run/attempt、阶段、唯一 ID、顺序、结果和产物内容摘要；多进程写入协调，支持重复事件幂等、半行恢复和终态持久化。编译以及独立 articulate/small_objects 成功出口都有产物记录。任务存储负责排队执行，阶段存储负责复用，事件流负责回放，三者不强行合并成一个来源。

新回放优先用事件；旧日志/mtime 推断放进独立适配器并标记 `inferred`。无法由摘要确认的外部改写标记 `unknown`，仍按记录的时间显示。是否使用旧推断按每个模型分别决定，并且只看回放时刻之前的记录，之后追加的事件不改变过去的回放：早先的任务被后来的增强或重试追加新事件后，原有模型继续由旧适配器给出时间。复制文件只改变 mtime，不会改变新事件的时间。

观测分开记录排队、GPU 锁等待/持锁、阶段及子进程 CPU/墙钟耗时、重试和 Agent 流等待。能获取原生 API 时间时保存来源，无法获取时保留未知。GPU 持锁时间包含 CPU/API 工作，不能当作 kernel 时间；嵌套和并发区间不能直接相加。

代码入口：[room_status.py](../../web/scripts/room_status.py)、[replay_history.py](../../web/scripts/replay_history.py)、[telemetry.py](../../room-reconstruction/src/litereality_agent/telemetry.py)、[timing.py](../../room-reconstruction/src/litereality_agent/timing.py)。

## 6. 回放、手势和模块职责

回放切换 draft 时释放旧模型、墙面渐变引用、成形效果、克隆材质及预热资源；晚到加载和图片解码可以取消，同 key 重试也按新一代请求处理。释放过程等待在途 shader 编译完成，成形材质按视图生命周期复用。连续 24 次真实 WebGL 切换后资源趋稳，回拖、倍速、切灯光和预热期间关闭均已覆盖。

独立手势页面和编辑器 embed 共用 `tracker-core.ts`，由入口注入 Worker 创建方式和资源地址。初始化失败、超时、停止、重启及晚到 bitmap 有统一清理逻辑；同时重建了 `web/vendor/gesture`，避免只修改源码而遗漏实际网页使用的包。

职责拆分后，入口仍负责编排，专门模块承担状态和算法，减少重复实现：

| 原入口或重复点 | 当前职责划分 |
| --- | --- |
| `scene-editor.js` | 保留交互编排；实体、几何、Worker 通信、导入实体、仓库卡片和射线查询分到独立模块。 |
| `room_service.py` | 保留 HTTP 入口与兼容导入；拆出 `room_jobs.py`、`room_executor.py`、`room_status.py`、`room_scan.py`、`room_contract.py`。 |
| 两份手势 tracker | 统一到 [tracker-core.ts](../../gesture/src/tracking/tracker-core.ts)，两入口保留环境适配。 |
| 编译、缓存和增强产物记录 | 复用小型公共组件，不要求各服务使用同一 HTTP 框架。 |
| 分散的配置与兼容路径 | 记录默认值、覆盖顺序、GPU 共享协议及旧变量/接口保留条件。 |

## 7. 已测到的收益与验证边界

| 指标 | 重构前 → 重构后 |
| --- | --- |
| Room_3934 导入索引更新中位数 | 4,159.0 → 26.4 ms |
| Room_3934 删除索引更新中位数 | 4,377.6 → 16.8 ms |
| 真实物体完整网格 / 代理 BVH 构建 | 1,055.97 → 29.53 ms |
| DA3 NPZ 大小 | 19,816,028 → 6,098,902 字节 |
| 同输入 TRELLIS 首次生成 / 缓存复用 | 392.52 → 0.89 秒；复用未调用 GPU，模型摘要与 mtime 不变 |
| refine 三姿态实际构建次数 | 3 → 1；12 对图像最大像素差 1/255 |

各行比较的工作负载不同，不能相加为端到端加速。代理部分稳态放置/射线查询略慢，主要收益在初始化；初次大模型 BVH 仍约 2.7 秒。完整分布、误差容差和测试条件见[验收记录](validation.md)。

最终回归为房间 884 项通过、2 项因缺少原始扫描跳过；网页 Node 297 项、物体 75 项、手势 105 项通过。网页 Python 96 项中本机缺 OpenCV 的一项已在服务器补验。真实样例几何检查、浏览器 Worker/漫游/回放、GPU 0 重建、TRELLIS 缓存、Blender 发布和故障恢复均有独立证据。新增关键回归已纳入相应自动化入口。

硬件验收只使用 GPU 0，保留独立验证 worktree 和输出。没有重新付费执行整房多 Agent 创作与完整 articulate 模型推理；Android、上游独立 walk 和真人手势准确率不在本次设备验收内。归档删除、Git LFS/大文件迁移、历史重写、模型常驻和渲染器切换仍属另行决策范围。

## 文档整理与迁移记录

main 工作区的四份重构文档原本未被 Git 跟踪。核对确认它们没有重构分支尚未保留的独有内容，因此以分支内包含最终修订的版本集中维护；核验入库后移除 main 工作区的重复副本，main 提交保持不变。

| 原路径 | 本目录中的归属 |
| --- | --- |
| `docs/refactor.md` | [history/initial-review.md](history/initial-review.md) |
| `docs/RoomCanvas-重构建议.md` | [history/second-review.md](history/second-review.md) |
| `docs/refactor-plan.md` | [plan.md](plan.md) |
| `docs/refactor-validation.md` | [validation.md](validation.md) |
| 重构分支的 `docs/editor-refactor-validation.md` | [editor-validation.md](editor-validation.md) |
| 重构分支的 `docs/refactor-contracts.md` | [contracts.md](contracts.md) |

`docs/OBJECT_RECONSTRUCTION_PERFORMANCE.md` 属于单独的 GPU 1 / `perf/object-reconstruction-profile` 实验，保留在原工作区，不混入本轮 GPU 0 重构的结论。服务器验证分支的 README 与原始记录按其验证版本保留。
