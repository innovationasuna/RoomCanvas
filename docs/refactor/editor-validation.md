[重构说明与文档导航](README.md)

# 编辑器重构验证记录

2026-11-18，验证工作区 `runs/refactor-worktrees/reliability`，起始提交 `007a136`。覆盖重构计划 2B、4B、4C 及编辑器职责拆分。代码未部署到服务器。

## 行为与边界

- 原始扫描可显示、重置及撤销恢复。每件物品都能在扫描位置原地确认，不保留 mesh 对永久豁免。
- 扫描时相交的网格对拆成连通部分，只有扫描时确实相交的那一对部分按穿入深度判断：不超过扫描时的深度加 5 mm 即可放置，移开、抬起后原地放下和不加深的旋转都允许；更深的移动在越界处停下。三个样例房间的 213 次实测探测放行 205 次，与基线一致。此限制是明确的保守行为，不能理解为通用网格解穿插算法。
- 原始几何、实体支撑采样、静态及已有实体 BVH 被复用。Worker 只接收变更/删除的 owner，所有旧请求在代际替换或错误时结清，过期回包不能确认新布局。
- 漫游与部件点击共享碰撞三角形 BVH，按实时世界矩阵处理门、抽屉与承载姿态。地板仍参与落脚查询。显示/裁切策略由调用方提供。
- `scene-editor.js` 保留交互编排，分组、导入实体构建、仓库卡片、几何服务、Worker 队列和最近命中查询分别位于独立模块。

## 验证

Node 覆盖薄墙、扫描交叠的斜向移动/加深/拉开后推回、旋转的墙和桌、原地转动、长步、两段互锁（两个方向拖动结论一致）、0.5° 到 30° 的斜墙（沿墙长距离移动放行、边移边入墙被拦下）、未接触过的薄隔板、深推到容差为止（两个方向一致）、高面数物体连续转动时的精确投影次数（按次数断言，不计时）、多叶 BVH 网格、重置重复结果和承载，以及增量索引计数、真实 Node Worker 主线程一致性、过期消息和取消。最近命中与 Three 原生射线对照覆盖导入删除、隐藏、过滤、铰接、镜像与非均匀缩放。

```sh
node --test 'web/editor/tests/*.mjs' 'web/scripts/test_*.mjs'
node web/scripts/check_room.mjs --scene-dir samples/room3
```

本轮记录时全量 Node 297/297，发布导入图 Python 测试 2/2，三房间 `check_room` 分别为 office 18/18、room3 23/23、room-3934 60/60。`check_room` 要求每件物品都能在扫描位置原地确认。修复后全量 Node 为 306/306。

真实浏览器使用 Chrome 157、Apple M5 / Metal、1440×1000、DPR 1、`balanced-no-ao`、关闭手势、30 帧，三个样例各运行 5 轮 `check_lighting.mjs --asset-edits`，全部通过。

| 样例 | 导入 rebuild 中位数 | 删除 rebuild 中位数 |
| --- | ---: | ---: |
| office | 24.8 ms | 15.0 ms |
| room3 | 33.8 ms | 22.8 ms |
| room-3934 | 26.4 ms | 16.8 ms |

同设备已有 5 轮 room-3934 基线，导入 rebuild 中位数 4159.0 ms、删除 4377.6 ms。导入至删除区间最长主线程任务的五轮中位数由 8771 ms 降到 245 ms，五轮最大值由 8956 ms 降到 268 ms。初次重模型 BVH 构建仍需约 2.7 秒，不能把增删改善理解为消除了启动成本。五轮样本较少，最大值只代表本次观测尾部。

原始性能报告位于 `/private/tmp/RoomCanvas-editor-incremental/round{1..5}/report.json`，历史基线位于 `/private/tmp/RoomCanvas-reliability-editor-stages/`。

最近命中基准每轮 54 条射线、5 轮，原生/索引耗时中位数如下。打开全部关节后的额外射线也逐条对照，三房间合计 1990 次查询、0 差异。

| 样例 | 原生 Three.js | BVH 最近命中 | 打开的关节数 |
| --- | ---: | ---: | ---: |
| office | 34.8 ms | 2.6 ms | 4 |
| room3 | 70.4 ms | 1.1 ms | 10 |
| room-3934 | 19.0 ms | 5.1 ms | 23 |

三房间均通过真实“体验 → 走进房间 → WASD → Esc”流程。报告与漫游截图位于 `/private/tmp/RoomCanvas-editor-queries/`。复核入口是在 `lightingLab=1` 页面执行 `await roomLightingLab.queryBenchmark()`，方法会恢复临时开合的关节。该指标衡量射线查询 CPU，不能等同于端到端帧率提升。

职责抽取后的最终版本再次运行三房间 `check_lighting.mjs --asset-edits --editor-queries`，全部通过且无页面异常。导入/删除后第 3 代真实 Worker 与主线程结果一致；room3 的 `Table0` 是钢琴，连同琴上乐谱提升 12 cm 后的落点和连续扫掠均通过。WASD 期间记录的帧间隔 p95 分别为 16.8 / 16.7 / 16.8 ms。此轮报告和截图位于 `/private/tmp/RoomCanvas-editor-final/`。

## #108：Worker 单次构建与紧凑索引

2026-11-23，本地分支 `perf/collision-bvh-partition`，基于 `9460502`，未部署。保留原三角形、双精度坐标、扫描交叠容差及同距射线命中的面、法向和材质选择。根节点保留旧排序顺序，深层改用有扫描预算的中位分割；发生实际同距命中时才沿旧排序重建裁决路径，不保存第二棵树。

基础索引在 Worker 中构建，主线程安装 Float64/Uint32 数据后供碰撞及射线共用，包括只用于查询的地板。两端各保留紧凑数组；没有使用 SharedArrayBuffer，也没有声称只保留一份物理副本。普通初建的主线程 `builtMeshes=0`。新增只构建新网格，删除立即复用剩余索引；过期回复、已回复但尚未安装时的更新、销毁和 Worker 失败都有独立回归。

以下三轮交替浏览器对照以本分支第一阶段的对象树版本为基线（已有中位分割，但仍在主线程和 Worker 各构建一次）。固定 Activity Classroom：129 个碰撞 owner、1,320 个网格、2,433,752 个三角面；Apple M5，1440×1000、DPR 1，每轮全新 Chromium，关闭附加光照/AO/environment。所有变更模块均覆写为对应源码快照，并核对页面与真实 Worker 的源码哈希。表中耗时为中位数。

| 指标 | 第一阶段对象树 | 紧凑索引与 Worker 安装 |
| --- | ---: | ---: |
| 主线程碰撞及射线准备阶段 | 1,675.3 ms | 2.8 ms |
| 主线程索引安装 | — | 0.6 ms |
| Worker 内部构建 | 1,577.3 ms | 1,201.5 ms |
| 页面与 Worker 常驻 JS 堆及数组存储合计 | 2.198 GiB | 1.763 GiB |
| 54 条射线，5 轮中位数 | 3.2 ms | 3.2 ms |
| 关节打开后 98 条射线，5 轮中位数 | 5.6 ms | 5.8 ms |

内存为两端强制 GC 后 CDP `Runtime.getHeapUsage` 的 `usedSize + backingStorageSize`，不包含 GPU、所有浏览器进程或峰值。另一次 Node 24 隔离测量中，单份索引增加的 `heapUsed + arrayBuffers` 从 724.3 MiB 降到 248.6 MiB；不能将 Node 与浏览器的数字混为同一测量。界面就绪定时器的中位数仍约 13.1 秒，缩略图和首次渲染仍有长任务，以上结果不代表整页加载时间同比下降。

验证覆盖：全量 Node 测试、发布静态模块依赖检查；四个真实房间分别为 Activity Classroom 90/90、office 18/18、room3 23/23、room-3934 60/60，办公室连续碰撞验收 9/9。移除耗时字段后，真实房间输出与第一阶段完全相同。独立旧排序/射线遍历 oracle 的 3,120 组边界对照全部一致；浏览器主线程/Worker 碰撞探针、原生射线及开合后的射线对照均无差异。大教室与办公室还验证了导入、并发导入保护、删除和漫游；Worker 不可用及模型下载失败后恢复编辑也经浏览器验证。

本地证据位于 `/tmp/roomcanvas-compact-m7vj3_ws/`：`browser-final/report.json` 保存三轮对照和源码哈希，`browser-final-edits/report.json` 保存最终增删验收，`browser-failures.json` 保存失败回退结果。真实样例可复核：

```sh
node --test 'web/editor/tests/*.mjs' 'web/scripts/test_*.mjs'
python3 -m unittest discover -s web/scripts -p test_publish.py
node web/scripts/check_room.mjs --scene-dir samples/activity-classroom
node web/scripts/check_collision.mjs --scene-dir samples/office
node web/scripts/check_lighting.mjs --url http://127.0.0.1:7881/web/ --output /tmp/roomcanvas-index-check --rooms activity-classroom,office --variants original --frames 10 --asset-edits --editor-queries --playwright /path/to/playwright --browser /path/to/chromium
```
