# 代码审查与重构计划（2026-10-27）

用户 2026-10-27 要求审查整个仓库（“有点屎山，可能要重构”）。审查基于 main `038f568`，分房间重建、物体重建、网页 / 手势 / 安卓 / 整体布局三块，只读，没有改代码。下面的 bug 都对照代码核实过；标 * 的是按执行顺序推断。

**进度（2026-10-27 晚）**：第 1 批 12 个 bug 全部修好，各开 PR 等合并（见表最后一列）。#6 修前修后都在浏览器里对比过（旧代码可复现）；#7、#8、#10 只有单测，没有真人摄像头或拖动复现。第 3 批的“`?v=` 发布时统一盖版本号”（#43）和第 4 批的“统一的换材质模块”（#45）为修 bug 提前做了。

## 总体判断

- 最大、最难读的几块大多是照搬的上游代码，不该改：`object-reconstruction/` 有 155 个文件和上游 MV-SAM3D `abb04b5` 一字不差（含 4090 行的 `run_inference_weighted.py`），只有 `.gitignore`、`README.md`、`requirements.inference.txt`、`scripts/run_da3.py`（3 行）改过。
- 真正乱的地方：
  - **房间重建**：127 个环境变量散在 66 个文件里直接读，`settings.py` 只在约 11 处用；找 Blender 的代码 8 份；`articulate/run.py` 和 `small_objects/run.py` 基本复制粘贴；约 800 行死代码；`mujoco_scene.py`（1814 行，`export()` 945 行）、`build_room.py`（1334 行）、`author.py`（约 400 行提示词写在代码里）太大；可动部件和小物件两步由 `server/run_room.py` 另外串起来，不在 `PipelineRunner` 的续跑状态里。
  - **物体重建**（我们自己的 `scripts/` 约 2400 行）：写 JSON、GPU 锁、名字校验各有 3–4 份且规则不一；三个手写 ASGI 中间件重复；BiRefNet 参数写了三处；`scripts/` 平铺，接口、任务、工具、上游文件混在一起。
  - **网页编辑器**：`web/editor/scene-editor.js` 2343 行，约 60 个模块级变量；5 套代码各自给同一批模型换材质（`materialRestore`、`ghostMaterials`、`editingWallMaterials`、`wallMaterialRestore`、`wall-visibility.mjs` 的 `userData.solid`），会互相覆盖；各处手写的 `?v=` 版本号不一致，同一模块被加载两三份。
  - **整体**：3 个漫游查看器（`room_ops/walk/app.js`、`web/editor/walk.mjs`、安卓），Three.js 3 个版本（0.168 / r180 / 0.186.1）；手势协议在 `gesture/src/integration/protocol.ts` 和 `web/editor/gesture-bridge.mjs` 各写一份；安卓 `MainActivity.kt`（871 行）、`ArGestureHandler.kt` 没有入口；`object-reconstruction/legacy/`（5 MB）、空的 `object-reconstruction/viewer/`；`object-reconstruction/data/example` 152 MB 示例图和视频在 git 里，`.git` 619 MB。
  - **CI**：没有安卓；物体测试是手写列表，`test_preview_glb.py` 没跑；`gesture/backend/test_server.py`、浏览器光照检查没跑；没检查 `web/vendor/gesture` 是否和 `gesture/src` 一致。
  - **文档**：`room-reconstruction/ARCHITECTURE.md` 说 publish 在 `realism_authoring/publish`（实际 `pipeline/room_qc/publish`）、默认 provider 是 claude（实际 codex），漏了 simulate、articulate、small_objects、live。

## 确认的 bug

| # | 位置 | 问题和触发 | 修复 |
|---|---|---|---|
| 1 | `room-reconstruction/server/run_room.py:113` | `--from <阶段>` 用 `pipeline/<扫描文件夹名>`，但场景目录按 `RunContext` 起名（`room3` → `hausen_room3`），续跑报“no such capture or scene path”。修：用同文件 162 行找 `scene.json` 的办法 | #41 |
| 2 | `room_ops/rendering/room_render/render_vs_capture.py:43`、`agent/author.py:472` | 总在 `$LITEREALITY_BLENDER` 后拼 `/blender`；填成程序路径或靠 `/Applications/Blender.app` 兜底时，publish 的对照渲染全失败，每次判 needs_repair。服务器填的是目录，不受影响。修：改用 `room_ops/paths.find_blender` | #41 |
| 3 | `object-reconstruction/scripts/run.py:220` | 抢锁之前先查显存；GPU 被网页重建占着时，`--wait-gpu` 直接报显存不足而不是排队。修：只在锁里查（228 行已有） | #42 |
| 4 | `object-reconstruction/scripts/run.py:32` 与 `import_photos.py:17`、`objects.py:84,187` | 名字上限 80 字，但照片编号 `<名字>_001`、运行编号 `日期_<名字>_web_时间` 由名字拼出：77–80 字且 2 张以上照片时抠图必失败，名字也被占住；54 字以上不能补拍 | #42：新建名字上限改 53 |
| 5 | `web/editor/scene-editor.js:1783` 与 `web/scripts/publish.py` | 手势模型路径是 `../../gesture/public/vision/`，`publish.py` 只复制 `vendor/` 和 `editor/`，发布出去的预览里手势按钮必定失败 | #43：`web/vendor/vision` 软链接 |
| 6* | `scene-editor.js:186-188` | `wallVisibility.update()` 先把正在编辑的墙重新设成半透明，`setEditingWall(null)` 再还原，近侧墙上的挂件选中后确认或 Esc，那面墙卡成不透明 | #45 |
| 7* | `scene-editor.js:1231-1251`、`wall-visibility.mjs:76-104` | 拖带着上方物件的高家具跨过房间中线，预览材质和半透明切换互相覆盖，小物件永久半透明且原材质颜色被改 | #45 |
| 8 | `gesture/src/integration/runtime.ts:46`、`main.ts:72`、`scene-editor.js:1676` | 手势页先用鼠标拖出一件（未确认），再点“开启摄像头”，`start()` 里的 `stop()` 让编辑器取消预览 | #44 |
| 9 | `web/editor/collision.mjs:3`、`placement-session.mjs:1`、`collision-worker.mjs:4`、`drop-placement.mjs:1` | `?v=` 写法不一，`placement.mjs`、`layout.mjs` 各被加载多份；用不带缓存头的静态服务发布后，页面和后台线程可能跑不同版本的碰撞检查 | #43 |
| 10 | `scene-editor.js:1566,1732,1748` | 漫游中某些手势结束时重新打开 OrbitControls，没看 `walk.active`（影响小） | #44：`releaseOrbit()` |
| 11 | `object-reconstruction/scripts/objects.py:142` | 照片的抠图都已存在时也要等 GPU 锁，重新预览要排在一次重建（3–8 分钟）后面（影响小） | #42 |
| 12 | `object-reconstruction/scripts/objects.py:73` | 同名并发新建，第二个 `mkdir` 抛 `FileExistsError`，中间件没处理，返回 500 而不是“名字已存在”（影响小） | #42 |

## 重构计划（按收益和风险排，每批一个或几个小 PR）

1. **修上面的 bug**，各自加测试。——2026-10-27 已做，PR #41–#45。
2. **低风险清理**（删的东西先列清单给用户确认）：
   - **2026-10-27 已删（#47）**：下面房间重建死代码里除 `export/mujoco_replay.py`、`room_render/rank_views.py` 以外的都删了（这两个是能跑的手动命令行工具，只是没人调用，保留）；安卓三项、`viewer/`、`MV_ROOT` 都删了。`legacy/` 不删：#23 时用户要求保留全部旧 UI 归档。
   - 房间重建死代码：`layout/agent_loop.py`、`layout/toolcli.py`、`layout/agent.py` 的 `solve_v10`、`layout/repair.py` 的 `solve_v11`–`v13`、`export/mujoco_replay.py`、`room_render/rank_views.py` 和 `shared/config.py` 里不用的 `RANK_TOOL`、`ANNOTATE_TOOL`。
   - 安卓 `MainActivity.kt`、`ar/ArGestureHandler.kt`、`res/layout/activity_main.xml`；空的 `object-reconstruction/viewer/`；`env.sh` 的 `MV_ROOT`。
   - `object-reconstruction/legacy/` 打标签留档后移出；`data/example` 移不移用户定（移出不缩小 `.git`，改写历史不建议）。
   - CI：上游文件不变的检查（对 `abb04b5` 的哈希清单）、物体测试改自动发现、加手势后端测试、安卓单测、`vite.embed` 构建后 `git diff --exit-code web/vendor/gesture`。
3. **合并重复**：找 Blender 全走 `paths.find_blender`；物体重建抽一个公共模块放写 JSON、GPU 锁、名字校验（一套规则）；`run.py` 的库函数和命令行分开；BiRefNet 参数只读 `configs/birefnet.json`；可动部件和小物件抽公共 `Pass` 基类；`load_scene_objects` 只留一份；手势协议和 tracker 只留一份，视觉模型复制到 `web/vendor`；`?v=` 改成 `publish.py` 发布时统一盖一个版本号。
4. **大改，最后做，一块一个 PR**：
   - 先写统一的换材质模块（优先级：半透明 < 编辑中的墙 < 选中染色 < 拖动预览），在 Node 里测，根治 6、7；再按现有边界拆 `scene-editor.js`（手势端口、导入、落点线程客户端、诊断和灯光实验）。
   - 环境变量按子系统逐步收进 `LiteRealitySettings`（先 codex），路径通过 `RunContext` 传，不再在 `shared/config.py` 导入时算、在 `set_room()` 里改 `os.environ`。
   - 拆 `mujoco_scene.py`、`build_room.py`、`flow.py`、`console.py`；`author.py` 的提示词挪到 `.md`。
   - 可动部件、小物件并进 `STAGES` 作为可选阶段。
   - 物体重建三个中间件换成 Starlette 路由（地址不变）；旧后端都不在后去掉 `/viewforge/layouts/*` 别名。
   - ViewForge 命名：文档和标题随时可改；`/viewforge/*` 地址、`VIEWFORGE_ROOT` 等环境变量只能加别名过渡。
   - 房间统一用 `room_objects.json` + 关节这一个格式，不再扩展 `room_ops/walk`。

**不动**：上游照搬的代码（`sam3d_objects/`、`run_inference*.py`、`notebook/`、`preprocessing/`、`scripts/vendor/cover/`、`ingest/preprocessing/vendor/litereality/`、`run_da3.py` 只保留那 3 行改动）、Three.js r180 / n8ao / MediaPipe、`room_objects.json` 和 `scene.json` 的格式及 `run/<scene>/` 输出布局（续跑靠它）、`sceneKey`（浏览器里已存布局的 key）、手势消息协议、git 历史。

## ZCode 找 bug（未完成）

用户想再用本机 ZCode 找一遍。命令行版（`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）用不了账号额度（报 “Select a model before sending a message”，账号额度只有桌面版能用），改为用户在桌面版（模型选 GLM-5.3）里对 main 的一份副本跑，提示词要求只读、只报读过上下文确认的真实 bug（文件:行号、问题、触发场景，最多 20 条，跳过上游和 vendor 目录）。跑完后从 `~/.zcode` 的本地记录读结果，逐条核实后补进上表。
