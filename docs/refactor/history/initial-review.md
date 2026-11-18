[重构说明与文档导航](../README.md)

# 最初代码审查

> 本文保留重构前的审查意见，部分问题现已修复。最终实施与验证以[重构验收记录](../validation.md)为准。

我建议按 “修正状态与坐标 → 减少重复计算 → 拆分模块职责” 的顺序重构。当前最值得处理的是碰撞系统、重建任务与缓存的一致性；这些地方同时影响速度和结果正确性。

这次只做审查和离线验证，没有修改源码。

项目整体链路已经比较清楚：

| 模块 | 实际职责 |
|---|---|
| room-reconstruction | 扫描 → 结构与物体重建 → Agent 编辑 → Blender 编译、验收 → 可动部件生成 |
| object-reconstruction | 照片 → 抠图 → DA3 → MV-SAM3D、纹理烘焙 → COVER → 尺寸标定 |
| web | 编辑、碰撞与支撑、漫游、回放；Python 服务负责代理、任务管理和缓存 |
| gesture | MediaPipe 识别 → 手势状态 → 编辑器操作 |
| android-app | GLB 导入、第一人称漫游和关节动画 |

已有的按需渲染、静止后补算 AO、手势推理背压值得保留。

运行速度方面，优先处理下面六处。

| 优先级 | 问题与证据 | 重构建议 |
|---|---|---|
| 高 | 碰撞索引在主线程和 Worker 各构建一次，增删物品又全屋重建。 本机真实样例的单次 BVH 构建：office 约 0.85 秒，room3 约 2.60 秒，尚未计入其他初始化开销。入口代码 (web/editor/scene-editor.js:2386) | 静态房间索引缓存；新增、删除只更新对应实体；将昂贵构建移到 Worker，并避免两端重复构建。 |
| 高 | 默认 PBR 物体没有轻量碰撞模型。 烘焙成功后提前返回，跳过 preview；前端缺少 preview 时克隆完整模型充当 light，面数完全没减少。后端 (object-reconstruction/scripts/run_reconstruction.py:76)、前端 (web/editor/object-import.mjs:76) | 分离完整模型、显示 LOD、低面数碰撞代理。碰撞代理不需要保留显示贴图。 |
| 高 | 漫游一次身体检测做 9 次全场景射线检测，拐角最多重复三轮。 本机 CPU 采样中，单次检测 p95 约 11.4–14.6 ms，尚未计渲染。代码 (web/editor/walk.mjs:65) | 使用轻量碰撞体和空间索引，先筛附近障碍，再查询最近命中。 |
| 中 | 上传、解压会阻塞其他请求。 物体上传在异步请求中同步复制文件；房间解压持有所有任务共用的锁，健康检查和进度读取也等待这把锁。上传 (object-reconstruction/scripts/objects.py:266)、解压 (web/scripts/room_service.py:203) | 磁盘操作放线程池；解压移出全局锁，锁只保护短暂的任务状态更新。 |
| 中 | DA3 保存了两份仅轴顺序不同的 pointmap，并意外升为 float64。 已验证：40 张 504×504 图片，仅这两份数组约 465 MiB。代码 (object-reconstruction/scripts/run_da3.py:83) | 明确使用 float32，只保存一种布局，需要时转置，减少内存、磁盘写入和后续读取。 |
| 中 | 实时回放释放旧模型不完整。 drop() 删除模型表项，但 wallFades 仍持有旧模型和几何引用，每帧继续遍历。最小复现中删除 5 个模型后仍保留 5 个旧根节点。代码 (web/replay/room-view.mjs:408) | 统一模型生命周期，删除时同步清理墙面、动画、预热对象等引用。 |

以上计时是本机 Node 的真实几何 CPU 测量，不能直接换算成浏览器 FPS。

房间重建还有一个值得测量的耗时点：可动部件阶段固定使用 Cycles CPU 串行渲染，候选检查和开合验证合计每个对象最多约 14 张图。代码 (room-reconstruction/src/litereality_agent/pipeline/realism_authoring/articulate/blender_ops.py:99) 建议先记录阶段耗时和渲染张数，再决定是否调整渲染器、采样或并发；目前没有证据认定它是整条流水线的最大瓶颈。

逻辑上，下面这些问题需要先修。

1. 移动家具后导入或删除物品，会造成碰撞、支撑位置与画面错位。已复现。

   重建索引读取当前 matrixWorld，其中已经包含家具位移，后续判断又应用一次 layout。复现场景中，家具实际位于 x=[1.5,2.5]，支撑脚印却变成 [3.5,4.5]，碰撞结论也随之改变。导入入口 (web/editor/scene-editor.js:2020)、几何提取 (web/editor/collision.mjs:531)

   应保存稳定的局部几何，位姿只应用一次。这个修正可以和增量碰撞索引一起做。
2. “容忍原始重叠”变成了永久忽略两件物体之间的碰撞。已复现。

   两个模型只要初始相交，整对 mesh 就被永久豁免。最小场景中，初始重叠 0.1 米的两个方块，后来完全重合、分开后再穿过对方，都被允许。代码 (web/editor/collision.mjs:310)

   应只容忍原始接触范围以及脱离运动；分离后恢复正常检查。
3. 并发保存共用临时文件，会导致随机任务失败。已复现。

   小物体重建的多个线程共同写 items.tmp，网页缓存的后台同步和请求线程共同写 answer.json.part。一个线程完成 rename 后，另一个线程会抛 FileNotFoundError。小物体状态 (room-reconstruction/src/litereality_agent/pipeline/realism_authoring/small_objects/run.py:61)、网页缓存 (web/scripts/room_cache.py:38)

   应统一原子写入工具，并保证状态更新与保存顺序；仅随机化临时文件名还不足以防止旧状态覆盖新状态。
4. 两条重建服务默认没有共用 GPU 锁。

   房间使用 runtime/locks/gpu-<UUID>.lock，物体使用 cache/gpu.lock 或另一个配置路径。显存检查只是瞬时检查：房间等待 Agent 时显存空闲，物体可能启动，随后两者同时进入推理。房间入口 (room-reconstruction/server/run_room.py:172)、物体入口 (object-reconstruction/scripts/run.py:224)

   应统一按 GPU UUID 管理的锁和等待规则。这是默认启动链路的缺口，尚未核实实际服务器是否通过私有配置补齐。
5. 未完成物体会提前进入资产目录，已保存的尺寸可能随后失效。已复现。

   资产是否可用只检查 result.glb 存在；此时 COVER 的坐标变换可能尚未生成。用户先标定，随后变换写入，标定键改变，读取结果变成 calibration=None。资产判断 (object-reconstruction/scripts/dimensions.py:30)

   应区分“网格生成”“资产可用”“补拍建议完成”，模型和坐标变换准备完毕后再允许导入、标定。
6. 重建的失败判断与缓存失效规则不统一。
   - compile_room() 忽略烘焙返回码；模拟烘焙返回 23，仍返回成功路径，工具还可能缓存这次成功。代码 (room-reconstruction/src/litereality_agent/room_ops/api.py:86)
   - TRELLIS service 分支丢掉强制重建参数，并硬编码 --skip-existing，强制重跑可能继续使用旧模型。调用 (room-reconstruction/src/litereality_agent/pipeline/scene_init/reconstruct/flow.py:329)、服务 (room-reconstruction/src/litereality_agent/models/trellis/service.py:95)
   - articulation 缓存只比较处理计划，不绑定来源房间；上游几何更新后，可能保留旧模型却复制新布局。代码 (room-reconstruction/src/litereality_agent/pipeline/realism_authoring/articulate/run.py:246)

   应统一成功条件，并让缓存绑定输入内容、配置、模型版本和上游产物。

还有两个容易补上的边界问题：大网格使用 Math.min(...array) 已能触发 RangeError，位置 (web/editor/placement.mjs:96)；网关在线但房间服务返回 503 时，代理不会回退到已有本地缓存，位置 (web/scripts/serve.py:206)。

过度冗余主要集中在编排和状态管理。

- scene-editor.js (web/editor/scene-editor.js) 有 2,434 行，同时管理场景、布局、撤销、导入、碰撞队列、灯光、手势和 DOM。建议先建立明确的“对象增删、位姿更新、提交与撤销”接口，再拆成场景状态、摆放控制、碰撞服务、资产导入和渲染模块。
- 手势的 tracking/tracker.ts (gesture/src/tracking/tracker.ts) 和 embed/tracker.ts (gesture/src/embed/tracker.ts) 几乎整类重复。可以共用实现，注入 Worker 创建方法与资源地址。
- 房间流水线多处重复实现编译、状态保存、子进程执行和缓存判断，已经产生行为差异。适合提取小型公共组件，统一结果与缓存契约。

实施上，我会分三批：第一批修坐标、碰撞规则和任务一致性；第二批做碰撞代理、增量索引和漫游加速；第三批拆分编排模块、合并重复实现。 第一批应补“移动后导入／删除”“并发保存”“处理中标定”“来源改变后重试”这些组合场景的测试。

验证结果：网页 Node 285 项通过；网页 Python 87 项通过、1 项跳过；物体 CPU 55 项最终通过。房间模块做了离线最小复现，未运行完整测试集；Android 做了静态阅读，未做设备验证；未运行 GPU、Blender或付费模型调用。工作区保持干净。
