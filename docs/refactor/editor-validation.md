[重构说明与文档导航](README.md)

# 编辑器重构验证记录

2026-11-18，验证工作区 `runs/refactor-worktrees/reliability`，起始提交 `007a136`。覆盖重构计划 2B、4B、4C 及编辑器职责拆分。代码未部署到服务器。

## 行为与边界

- 原始扫描可显示、重置及撤销恢复。新确认始终检查实际三角形相交和实体包含，不保留 mesh 对永久豁免。
- 原始浅交叠仅在真实三角形支持面证明法向平移减轻穿插时允许恢复，深度上限 3 cm。完全包含、凹形互锁、重叠中的旋转及无法证明安全的方向受阻。提示先移离，仍受阻时收起后重新放置。此限制是明确的保守行为，不能理解为通用网格解穿插算法。
- 原始几何、实体支撑采样、静态及已有实体 BVH 被复用。Worker 只接收变更/删除的 owner，所有旧请求在代际替换或错误时结清，过期回包不能确认新布局。
- 漫游与部件点击共享碰撞三角形 BVH，按实时世界矩阵处理门、抽屉与承载姿态。地板仍参与落脚查询。显示/裁切策略由调用方提供。
- `scene-editor.js` 保留交互编排，分组、导入实体构建、仓库卡片、几何服务、Worker 队列和最近命中查询分别位于独立模块。

## 验证

Node 覆盖薄墙、浅交叠移离/加深/重入、重置重复结果、完全同位、凹形互锁、旋转和承载，以及增量索引计数、真实 Node Worker 主线程一致性、过期消息和取消。最近命中与 Three 原生射线对照覆盖导入删除、隐藏、过滤、铰接、镜像与非均匀缩放。

```sh
node --test 'web/editor/tests/*.mjs' 'web/scripts/test_*.mjs'
node web/scripts/check_room.mjs --scene-dir samples/room3
```

本轮记录时全量 Node 297/297，发布导入图 Python 测试 2/2，三房间 `check_room` 分别为 office 18/18、room3 23/23、room-3934 60/60。`check_room` 的原始交叠检查要求普通查询与严格查询一致，原先要求永久豁免的断言已移除。

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
