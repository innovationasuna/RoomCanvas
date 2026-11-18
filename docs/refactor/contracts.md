[重构说明与文档导航](README.md)

# 配置、维护边界与漫游行为契约

核对日期：2026-11-18。本文记录本次重构后的源码契约，不代表服务器已经部署这些改动。部署提交、GPU 实测和设备结果另记于验证记录；现有示例、归档和历史记录均保留。

## 1. 配置入口与优先级

配置仍按运行环境分层。房间流水线、TRELLIS/DINO 重型解释器、物体重建环境不合并成一个 Python 环境。

| 入口 | 实际覆盖顺序（高 → 低） | 说明与源码 |
| --- | --- | --- |
| 房间 Python/CLI | 显式构造参数或 CLI 对应阶段参数 → 进程环境 → 模块 `.env` → 模块 `models.env` → 字段默认值 | [`settings.py`](../../room-reconstruction/src/litereality_agent/settings.py) 的 `load()`、`AliasChoices`；[`cli.py`](../../room-reconstruction/src/litereality_agent/cli.py) 解析阶段参数。空环境值忽略，未知字段不导出。 |
| 房间服务器包装器 | `run_room.py --set KEY=VALUE` → 包装器固定机器路径 → `$ROOMCANVAS_HOME/.env` → 继承进程环境 | [`run_room.py`](../../room-reconstruction/server/run_room.py)。**GPU 相关四个变量例外**：进程中显式设置的 `ROOMCANVAS_GPU`、`CUDA_VISIBLE_DEVICES`、`ROOMCANVAS_GPU_LOCK_DIR`、`ROOMCANVAS_GPU_SHARED_MIB` 会覆盖 `.env`；`--set` 仍最后生效。该包装器移除全局 `LR_AGENT_PROVIDER`，角色变量和 CLI 选择另行生效。不要将此顺序误写成通用 Settings 的顺序。 |
| 物体服务与重建脚本 | 先由调用者显式 `source configs/local.env`，再 `source scripts/env.sh` | [`env.sh`](../../object-reconstruction/scripts/env.sh) 不自动读取私有配置；`VIEWFORGE_ROOT` 必填，环境/权重/缓存位于此根目录，源码来自当前 checkout。脚本会设置其专属 `CONDA_PREFIX`、`PYTHONPATH` 和缓存位置。 |
| 一键服务启动 | shell 初值 → 可选 `$ROOMCANVAS_HOME/runtime/server-env.sh`；物体子进程另读 `configs/local.env` | [`start_server.sh`](../../scripts/start_server.sh) 默认 `ROOMCANVAS_HOME` 为 checkout 根。已经健康的服务保持运行；修改配置后再次执行脚本并不自动重启它们。 |

常用字段及现有别名：

| 用途 | 首选变量 / 参数 | 默认值与兼容规则 |
| --- | --- | --- |
| 房间输出根 | `LITEREALITY_OUTPUT`、CLI `--output-root` | 旧 `OBJECT_INIT_OUTPUT` 是低优先级别名；未设时依次取 `LITEREALITY_FINAL`、`<repo_root>/run`。 |
| 房间扫描目录 | `LR_SCANS_DIR` | `<repo_root>/scans_uploaded`；显式 scan/scene 路径由 `RunContext.resolve()` 解析。 |
| Blender | `LITEREALITY_BLENDER` | 兼容 `BLENDER_PATH`、`BLENDER`，同一配置来源中依此顺序取值；路径解析由 [`room_ops/paths.py`](../../room-reconstruction/src/litereality_agent/room_ops/paths.py) 处理。 |
| TRELLIS Python | `LITEREALITY_TRELLIS_PYTHON` | 兼容 `TRELLIS_PYTHON`；无本地解释器时不能把轻量 pipeline Python 当成 GPU 环境。 |
| DINO Python | `LR_DINO_PYTHON` | 兼容 `GROUNDING_DINO_PYTHON`；模型默认 `IDEA-Research/grounding-dino-tiny`。 |
| Agent / 角色 | `LR_AGENT_PROVIDER`；`LR_AUTHOR_PROVIDER` 等角色变量 | 默认 `codex`；author/materials/quality/refine 有显式 `codex` 默认，procedural 未设时继承全局。不要假设只改全局就会覆盖所有角色。角色 CLI 显式 provider 优先。 |
| Codex 模型 | `LR_CODEX_MODEL`、`LR_CODEX_EFFORT` | `gpt-6-astra`、`high`；会话超时 `LR_CODEX_SESSION_SECONDS=3600`。 |
| 参考图模型 | `LR_OPENAI_IMAGE_MODEL`、`LR_IMAGE_PROVIDER` | 模型 `gpt-image-2`；provider 未指定时由现有图像生成适配器选择。 |
| Hosted TRELLIS | `MODAL_PROFILE` 或完整 Modal token pair | 已配置 hosted 身份时选择 Modal；否则需要显式本地 TRELLIS Python。只有 app 名称或半套 token 不视为已配置。见 [`models/registry.py`](../../room-reconstruction/src/litereality_agent/models/registry.py)。 |
| TRELLIS 质量参数 | `--seed`、`--decimation`、`--texture-size` | 重建主链默认 `42`、`50000`、`4096`；直接旧 Modal service API 的 `texture_size=1024` 默认仍保留。直接 `generate-3d --simplify` 仍支持旧比例，显式 decimation 优先。CLI → 阶段 options → Local/Modal → launcher 已贯通。 |
| 生成缓存版本 | `LITEREALITY_TRELLIS_REVISION` | 默认 `default`；服务缓存同时绑定图片、参数、launcher/inference 源码及本地模型配置标识。替换 hosted 部署或原地更换未改配置的模型权重时应更改此 revision 或使用 force。 |

别名在本轮继续支持，没有已经安排的删除日期。移除条件是：调用入口和实际部署均改用首选名称、兼容用例通过、发布说明给出迁移方式，再单独决定弃用版本。本文不承诺不存在的自动迁移，也不重命名全部环境变量。

## 2. GPU 与共享锁

实现入口是 [`scripts/roomcanvas_gpu.py`](../../scripts/roomcanvas_gpu.py)、[`server/gpu.py`](../../room-reconstruction/server/gpu.py)、[`object-reconstruction/scripts/run.py`](../../object-reconstruction/scripts/run.py) 和 [`run_cover.py`](../../object-reconstruction/scripts/run_cover.py)。

| 设置 | 当前行为 |
| --- | --- |
| 房间 `ROOMCANVAS_GPU` | 默认 `auto`；可给物理 index 或 GPU UUID，限制在 `CUDA_VISIBLE_DEVICES` 允许的物理集合内。显式指定不能逃出可见集合。锁内再次检查设备占用。 |
| 物体 `CUDA_VISIBLE_DEVICES` | 作业要求恰好一张授权卡。若进入 `scripts/env.sh` 时未设，脚本用 `nvidia-smi` 选空闲显存最多的卡；这只选候选卡，实际作业仍需获取锁。 |
| 子进程 CUDA 编号 | 启动前将选择解析为物理 UUID；子进程接收 `CUDA_VISIBLE_DEVICES=<UUID>`，其内部 `cuda:0` 指该物理卡。不能把可见集中的逻辑编号和主机物理编号混用。 |
| `ROOMCANVAS_GPU_LOCK_DIR` | 新的共用锁目录，默认 `~/.cache/roomcanvas/gpu-locks`，要求本机绝对路径。多服务账号使用同一物理卡时必须指向同一可访问目录；各自的 home 默认路径不会互斥。 |
| 物体旧锁 `VIEWFORGE_GPU_LOCK` | 显式指定时继续独占该文件；默认 `$VIEWFORGE_ROOT/cache/gpu.lock` 以共享模式持有，与旧程序的独占操作兼容，也允许新程序在不同 GPU 上运行。物理 UUID 锁始终独占。 |
| 房间旧锁 | 继续持有 `$ROOMCANVAS_HOME/runtime/locks/gpu-<UUID>.lock`，同时持有新共用物理锁。 |
| `ROOMCANVAS_GPU_SHARED_MIB` | 默认 `0`：允许显存不超过 100 MiB 且没有计算进程的空闲卡；设为正值时按该显存阈值允许已有轻量占用，不代表跳过锁。 |
| 等待与继承 | 房间 `--wait-gpu` 和物体任务等待资源时每 2 秒重试一次、等待期间不持有任何锁，最长 30 分钟，超时以明确错误结束。物体任务只在网页服务里等一次，等待期间状态为 `queued`，拿到锁后经 `--lock-fd` 交给重建脚本。房间任务等待期间在 `runtime-timing.json` 写入 `gpu_waiting_since`，任务状态带 `gpu_waiting`；未取得显卡时记录 `gpu_error`。锁 FD 传递到子进程，父进程关闭自己的 FD 不提前解锁仍工作的子进程。COVER 使用继承锁时校验同一物理卡和同一锁文件。 |

新旧兼容锁不是可删除的临时文件；不能通过删除锁文件“解除占用”。GPU0 验证时使用 `ROOMCANVAS_GPU=0 CUDA_VISIBLE_DEVICES=0`，由统一入口解析为 UUID。

## 3. 服务地址与缓存边界

| 入口 | 默认监听 / 参数 | 数据归属 |
| --- | --- | --- |
| [`web/scripts/serve.py`](../../web/scripts/serve.py) | 本地网页端口 `7880`；`--viewforge`、`--room-backend`；`--ssh` 默认接远端 gateway `127.0.0.1:7870` | 默认 `runs/room-cache`；`--cache` 可改，`--no-download` 关闭自动补缓存。 |
| [`web/scripts/gateway.py`](../../web/scripts/gateway.py) | `127.0.0.1:7870`；objects `127.0.0.1:7862`，rooms `127.0.0.1:7866` | 只路由已有接口，不选择 GPU，不执行重建。 |
| [`web/scripts/room_service.py`](../../web/scripts/room_service.py) | `127.0.0.1:7866`；`--data-dir` 必填 | 一键启动默认 `runs/web-room-jobs`。任务记录、执行器和 HTTP 的维护边界以当前模块导入为准。 |
| [`object-reconstruction/scripts/web.py`](../../object-reconstruction/scripts/web.py) | `127.0.0.1:7862`；`--host`、`--port` | `VIEWFORGE_ROOT`；uploads、任务状态、资产 ready 与尺寸标定各自维护。 |

阶段复用、服务任务状态和事件回放不是同一个状态源：pipeline 输入指纹决定是否强制从头重做（选项变化和上游重跑只引起不强制的重跑）；任务存储表示排队/运行；事件表示发生过什么。新缓存保存内容 receipt，无法证明输入一致的旧缓存明确失效并移至 `.stale`。author 多文件检查点位于 `.room_checkpoint.d`，恢复摘要为 `.author_resume.json`，房间初始化所用的输入指纹记在 `.author_inputs`；检查点只表示源码语法与本地资源一致（资源检查只决定是否保存新检查点，不参与恢复判断），不能冒充 Blender 构建或质量验收通过。

## 4. 保留代码的实际调用与维护责任

| 代码 | 已核实的入口 / 使用关系 | 维护边界 |
| --- | --- | --- |
| `object-reconstruction/legacy/` | [`legacy/README.md`](../../object-reconstruction/legacy/README.md) 归档早期 Gradio/Babylon 界面。当前 [`scripts/web.py`](../../object-reconstruction/scripts/web.py) 导入 assets/dimensions/objects middleware，未导入 legacy 页面。 | 保留源码、构建文件、许可证和旧测试；不在本轮删除。当前 `/viewforge/layouts/...` 兼容路由仍由新 [`assets.py`](../../object-reconstruction/scripts/assets.py) 接受；“不加载旧界面”不等于旧 URL 可以删掉。旧页面重新启用时需单独跑其环境和测试。 |
| 网页编辑器漫游 | [`scene-editor.js`](../../web/editor/scene-editor.js) 调用 [`walk.mjs`](../../web/editor/walk.mjs) 的 `createWalk()`，共享当前场景的可见性与射线查询。 | RoomCanvas 当前交互实现；键盘、鼠标中键、触控、碰撞和模式退出的修改应在此验证。 |
| 上游独立 walk | `litereality view` 经 [`cli.py`](../../room-reconstruction/src/litereality_agent/cli.py) 调用 [`room_ops/walk`](../../room-reconstruction/src/litereality_agent/room_ops/walk/__init__.py)；也保留 `python -m litereality_agent.room_ops.walk <GLB>`，默认端口 `8780`。 | 是仍可调用的独立查看器，不能当死代码删除。`app.js` 头部声明来自上游 `make_vr_pages.py`，应上游修复后重新 vendor；独立 Three.js `0.168.0` 与本地编辑器版本不强制合并。当前仓库未包含该上游生成器，本文不声称已验证重新生成。 |
| Android | [`VrWalkthroughActivity.kt`](../../android-app/app/src/main/java/com/hausen3d/arviewer/VrWalkthroughActivity.kt) 实际调用 [`VrCameraController.kt`](../../android-app/app/src/main/java/com/hausen3d/arviewer/vr/VrCameraController.kt)、[`ArticulationController.kt`](../../android-app/app/src/main/java/com/hausen3d/arviewer/vr/ArticulationController.kt)。 | Kotlin/SceneView/Filament 与华为 AR Engine 设备实现独立保留；关节节点/动画语义参考上游 walk。当前 `AR_POSE_DRIVES_CAMERA=false`，相机由按键和滑屏控制，AR 只记录观测；Activity 的旧说明不能覆盖此实际常量。 |
| 手势运行时 | 独立页和编辑器 embed 共用 `gesture/src/tracking/tracker-core.ts`，各自注入 Worker 创建与资源 URL。 | 修改被打包源码后同步重建 `web/vendor/gesture`；构建与许可证规则见其 [README](../../web/vendor/gesture/README.md)。不能仅改构建产物。 |

## 5. 共享漫游回归场景

跨语言共享的是输入、坐标语义、状态转换和可观察结果，不要求 JS 与 Kotlin 代码相同。当前坐标约定均为 Y 向上，零朝向前进指向 -Z；网页 yaw 使用弧度，Android heading 使用度。速度/眼高有各自产品默认：编辑器眼高 1.6 m、步速 1.4 m/s；Android 基础步速 1.2 m/s 并有起停平滑；上游独立 walk 眼高 1.4 m。这些差异是现状，不能用同一个绝对位移阈值宣称跨端一致。

固定场景采用网页已有的 4 × 3 m 房间：地面 y=0、墙高 2.5 m、中心 2 × 1.6 m 床。各端适配相同几何与动作描述；结果比对时先排除速度平滑和单位差异。

| 场景 / 操作 | 应观察什么 | 已有证据与缺口 |
| --- | --- | --- |
| 零朝向前进；左转 90° 后前进 | 分别沿 -Z、-X；转身不把历史位移一起旋转 | 网页 `walkDirection` 测试；Android 控制器源码按当前 heading 积分，已有前进测试；Android 90° 和历史位移组合仍需补覆盖。 |
| 前进+侧移；相反方向同时按下 | 斜向单位方向归一化，相反输入抵消；不因键数翻倍速度 | 网页已测；Android 已实现方向归一化，未见对角行为专门测试。 |
| 床前、墙前、斜向靠墙移动 | 编辑器身体半径 0.25 m，停在实体前，保留沿墙分量；地面不阻挡水平步行 | 网页射线/slide 用例已测。Android 当前只有边界内缩 0.3 m 的 AABB 限制，未实现相同家具网格碰撞；不能标为跨端已经通过。 |
| 出生点在床中心；隐藏床；地面缺失 | 编辑器另找有地面且不碰实体的位置，隐藏物体不挡路，空中位置不当安全起点 | 网页 `spots`/`body.free` 已测；上游与 Android 需手工检查，未纳入共同自动验收。 |
| 点击关节、拖动观察、触控轻点 | 点击只触发一个关节，拖动不误开合；编辑器鼠标左键点击对象，中键拖动视角 | 网页 `test_walk.mjs` 覆盖点击/拖动互斥；Android 和上游保留各自触控/指针锁方案，需设备/浏览器验证。 |
| 失焦、退出漫游、恢复应用 | 清理按键/指针状态，不重复注册监听，不在恢复时突然位移 | 网页已有 blur 释放拖动测试；Android lifecycle 已有清理入口，但暂停/恢复组合尚无自动设备证据。 |
| 静止设备产生缓慢 AR 位移和 yaw 漂移 | Android 默认相机不跟随漂移，手动前进/滑屏仍有效 | `VrCameraControllerPoseTrustTest.kt` 已有 JVM 用例；真实设备漂移回归需单独记录，网页无 AR 输入。 |
| 60/120 Hz 相同动作持续相同时长 | 移动按时间积分；按各端速度与平滑规则比较，不要求每帧增量相同 | 三端源码存在时间积分；共同帧率矩阵尚未实现，不能凭源码认定实测通过。 |

## 6. 可复现验证与覆盖范围

在仓库根执行网页行为与现有样例检查：

```bash
node --test web/editor/tests/test_walk.mjs
node web/scripts/check_room.mjs --scene-dir samples/office
node web/scripts/check_room.mjs --scene-dir samples/room3
node web/scripts/check_room.mjs --scene-dir samples/room-3934
```

在 `room-reconstruction/` 使用该模块环境验证配置、共享锁、独立 walk 页面协议、缓存及恢复：

```bash
uv run pytest -q tests/test_env_loading.py tests/test_agent_providers.py tests/test_modal_trellis.py
uv run pytest -q tests/test_gpu_select.py tests/test_gpu_leases.py tests/test_gpu_launcher.py
uv run pytest -q tests/test_walk_viewer.py tests/test_cache_contracts.py tests/test_author_resilience.py
```

GPU 锁用例采用受控设备列表和子进程 FD，证明互斥协议，不证明真实 GPU 模型质量。`test_walk_viewer.py` 校验独立查看器 HTML/资源/路由，不能替代浏览器操控。TRELLIS 冒烟必须另记所用 GPU UUID、图片、seed、decimation、texture size、缓存命中与 force 结果。

Android 验证在 `android-app/` 执行 `./gradlew :app:testDebugUnitTest :app:assembleDebug`，需要 JDK 17 和本机 Android SDK；CI 当前不包含 Android。本文没有把“提供命令”计作“本轮已完成构建或真机测试”。手势按 [CONTRIBUTING.md](../../CONTRIBUTING.md) 及 vendor README 重建验证。

本轮边界：新增共享 GPU 协议、配置表、内容缓存/恢复约束和共享回归场景；保留 legacy、上游独立 walk、Android 与现有示例。未做归档删除、Git LFS 迁移、历史重写、跨端物理碰撞统一、上游生成器重建或 Android 真机验收。

本轮本地验证记录（2026-11-18，套件之间有重叠，数量不相加）：

- 配置、GPU 选择/锁/launcher、独立 walk 协议、pipeline runner 与新增内容缓存/恢复回归组合：61 passed；使用受控设备和子进程，不调用真实模型。
- TRELLIS service、small_objects、articulate、author 恢复及 reconstruction/publish/console 扩展组合：153 passed、1 deselected；仅出现第三方 Dash 的 pytest 弃用提示。
- 网页 `test_walk.mjs`：5 passed，覆盖方向/归一化、墙面滑动、家具射线、出生点、点击与视角拖动互斥。
- 本文 27 个本地链接均已核对存在。Android 构建、真机操作、上游重新 vendor 及真实 GPU 结果不在以上结论内。
