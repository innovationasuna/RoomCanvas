## 服务器验证记录

| 字段 | 内容 |
| --- | --- |
| 验证目标与状态 | 在 Activity Classroom 上试跑 #96 的新流程一次：author 会话 → 小物品 → 可开合部件 → 检查 → 修复并重跑两步 → publish。尽量复用已有成果，少用 GPU 和模型调用。状态：**已完成，跑通**（`trial.exit` 为 0）。更新：2026-11-21 14:10 |
| 分支与基线 | worktree `/home/data1/lyk/RoomCanvas-validate-before-check`，分支 `feat/room-small-objects-before-check`，起始提交 `c9f61ed`（`9463395` 加上 run_room.py 的修复预算透传） |
| 改动内容 | 相对正式版本：#96 的全部改动（小物品和部件移到检查之前、检查读完整房间、发布已检查的房间、按接触去碎块等），以及 `run_room.py --repair-steps/--repair-seconds`。验证目录里没有改源码 |
| 运行方式 | 环境：`runtime/server-env.sh`（`ROOMCANVAS_GPU=1`、`ROOMCANVAS_GPU_SHARED_MIB=8192`）。<br>准备：`runs/activity-classroom-trial/prepare.sh`，从已发布的场景复制，只读部分用硬链接，旧记录移到 `traces.before-trial/`；`seed_passes.py`，用旧的小物品和部件结果作两步的起点，依赖记录按新代码重算、只差代码。<br>会话说明：`operator/README.md`，要求不改房间。<br>运行：`bash runs/activity-classroom-trial/trial.sh`，即 `--from author --through publish --revise`，会话最多 6 步/600 秒，修复最多 3 步/300 秒，`--wait-gpu`；其余 `--set` 同 `phase-resume.sh` / `after_publish2.sh`。<br>GPU 1 显存由 `gpu-watch.sh` 每分钟记一次（`logs/gpu.log`）。<br>输出：`runs/activity-classroom-trial/run/`，日志在 `logs/`，核对产物在 `checks/`。不用任何服务端口 |
| 验证效果 | 见下方"试跑结果" |
| 改动去向 | 代码改动都在 PR #96，已合入 `main`（`54f6699`），服务器正式目录已部署到该提交；本记录随该分支提交 |
| 是否保留 | **已清理**（2026-11-21，用户同意）：worktree 和服务器本地分支 `feat/room-small-objects-before-check` 已删除，试跑目录 `runs/activity-classroom-trial/` 已删除（释放约 14 GB）。下文路径仅作历史记录，已不存在。没有仍在运行的验证进程 |

### 试跑结果（2026-11-21 13:43–14:05）

- 新顺序跑通（各步时间为起止时刻）：
  - author 会话 57 秒，1 次工具调用，房间不变。
  - 搭建前准备约 3 分钟（复制并清理 18 个现成模型）。
  - 编译 2 分钟（13:47–13:49）。
  - 小物品约 5.5 分钟（–13:54）：59 件判断全部沿用，ShelfC0R1B、ShelfC3R2B 去掉碎块。
  - 部件约 1 分钟（–13:55）：只有 ShelfC3R2B 重新规划，CardboardBox0 的检查沿用。
  - 检查约 4.5 分钟：读的是部件房间，validate **通过**（support 0），`render_vs_capture --blend` 出了 6 组对照图；视觉复核没通过，指出地面、墙面、电视、画、纸箱的外观问题。
  - 修复约 1 分钟：3 步预算用完，只读了文件。
  - 重新编译 1.5 分钟，两步重跑共约 1.5 分钟（全部沿用）。
  - publish 2 分钟：没有重新编译，另存了 blend 并烘焙，贴图 343 张缺失 0 张。
- 模型调用：
  - author 会话 1 次（Codex，2 条回复）；
  - 视觉复核 1 次；
  - 部件规划 1 次；
  - 修复会话 1 次（3 次工具调用）；
  - 小物品 0 次。
  - 合计 4 次调用、约 8 次请求。
- GPU：
  - 只用 GPU 1，锁持有 22.1 分钟；实际用 GPU 的是渲染和烘焙，约 6–8 分钟。
  - 每分钟采样里 GPU 1 总用量最高 7192 MiB（主要是别人的任务），没有接近上限。
  - 渲染时间很短，1 分钟采样没能测出本次的显存峰值。
- 产物：
  - 发布的 `room_preview/Room.glb` 能被 `room_objects.py` 处理：可移动组 87 个，用 `joints-fixed` 时关节 22 个，与已发布的 Activity Classroom 完全一致。
  - 默认关节目录下关节 12 个，与旧房间用同一目录生成的结果相同。
- 回放：
  - `room_replay.py` 只读算出的阶段为 …搭建完整房间 → 装上可开合部件 → 检查房间 → 按检查修改；
  - 没有"重做小物品"阶段，没有"沿用/复用"字样。
- 遇到的问题：
  - 复制的 `scene.json` 里 `roots` 仍指向原运行，author 会话的记录（`authoring_trace.author*.jsonl`、`trace.html` 和 5 张 `img/author_0004_*`）因此写进了原运行目录。
  - 已处理：试跑的 `roots` 改指向试跑目录；原运行的两份 author 记录从 `history/` 放回原名，试跑自己的记录移进试跑目录；原 `trace.html` 已从恢复后的记录重建，大小与之前一致。
  - 无法还原：那 5 张配图与试跑副本是硬链接，旧内容被同名覆盖。
