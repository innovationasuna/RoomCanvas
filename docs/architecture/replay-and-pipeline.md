# 房间流水线与重建回放

网页根据扫描、阶段记录和每次保存的房间模型还原建造过程。排查问题时先确定要查的是服务任务、流水线阶段，还是回放中的一次事件。三者分别有自己的记录。[上传扫描与命令行操作](../ROOM_RECONSTRUCTION.md)

## 任务记录与队列

| 记录 | 写入内容与恢复方式 |
| --- | --- |
| `<任务号>/job.json` | 任务名、状态、创建时间等。上传使用 `X-Upload-ID` 幂等。同一服务串行解包、排队执行。服务重启将排队项重新入队，把中断的运行或整理项标为失败。 |
| `<任务号>/task.log`、`task.lock` | 服务超时默认为 21,600 秒，可用 `--timeout` 调整。任务锁由子进程继承。上次进程仍在工作时，重试会报告占用。扫描、日志、模型留在数据目录，API 只公开约定的文件。 |
| `<场景>/.litereality/pipeline.json` | 记录各阶段结果。重试用原运行目录和阶段输入继续。任务状态另行区分是否可重试、模型是否可用、质量与可开合部件的结果。 |
| `<运行目录>/attempt-NN/` | `run-config.json` 记录代码、命令、路径配置、选中的物理 GPU 和其他进程已占用的显存。`pipeline.log`、`exit` 记录该次执行，`runtime-timing.json` 区分等待显卡与运行。 |

服务独占 `--data-dir`。读不到、JSON 已损坏、ID 与目录不符或关键字段无效的任务会被跳过，日志指出路径，保留原文件，其他任务继续加载。修复普通记录后重启。新登记或修复的回放记录由下一次扫描发现。

运行中登记回放时，先完整写入 `job.tmp` 再原子替换为 `job.json`。常规任务更新也经临时文件替换。服务从任务列表请求和摘要工作线程发现新登记的回放。[任务存储](../../web/scripts/room_jobs.py) · [回放登记](../../web/scripts/room_replay.py)

默认 `server` 运行器调用 `run_room.py --through publish --wait-gpu`，房间重建不依赖物品 API。

已有 uv 环境（如 macOS + Modal）也可使用 `--runner cli --pipeline-dir <模块目录>`，调用 `uv run --no-sync litereality run` 到 publish。两者共享建模阶段，CLI 环境自行协调计算资源。[任务执行器](../../web/scripts/room_executor.py)

## 阶段复用与建模输入

完整流程依次执行 `ingest → reconstruct → seed → author → publish`。服务器包装器不传 `--through` 时沿用模块 CLI 的阶段选择，可继续尝试可选的 simulate。网页明确以 publish 为终点。[命令入口](../../room-reconstruction/server/run_room.py) · [模块用法](../../room-reconstruction/README.md#run)

| 阶段或输入 | 在何时复用或重算 |
| --- | --- |
| reconstruct | 输入指纹包含参考图、椅子分类输入、路由策略、逐件覆盖、已有模型内容和静态模型转角。变更会强制重跑此阶段及重新计算下游。漏传来源目录可能导致物品重新生成。 |
| 生成路线 | 缺省由分类器决定，椅子组、有机物等有 TRELLIS 优先规则。仅指定 `trellis-first` 时，储物类（含 storage、cabinet、shelf、bookshelf、wardrobe）及普通矩形 table/desk 走程序化，门窗仍走门窗分支。 |
| 路由优先级 | 已有模型优先，随后是按编号指定的路线，再用策略。分类依据写到 `object_init/routing/<场景>/routing.json`。参考图、策略及该物品的覆盖条件相同可复用分类。 |
| 沿用静态或程序化模型 | 复制到 `reconstructed_objs/`，来源记入 `provided.json`。生成和椅子形状检查跳过已提供的模型，即使强制重跑。内容相同无需重拷。长短边疑似互换时 `[provided] WARNING` 列出两组尺寸。 |
| author | 输入指纹含初版房间与本次扫描。补充材料与预制小物品目录未计入此指纹。更换它们本身不会作废断点或触发已完成的会话。 |
| 再次建模 | 发布后 `--from author --through publish --revise` 在现有房间继续。模块 CLI 提供 `--force author` 从头建模。服务器包装器如需从头运行可用新目录。 |

直接使用模块 CLI 时，在 `room-reconstruction/` 下可运行以下命令，从已有场景强制重做 author 至发布。这会替换该次建模结果。服务器包装器的参数表中只有 `--revise` 用于追加会话，未提供 `--force`。

```bash
uv run litereality run '<含 scene.json 的场景目录>' --from author --through publish --force author
```

阶段选项变更或上游重跑会影响下游复用，但只有本阶段被强制或其输入指纹变化才按强制模式执行。[阶段运行器](../../room-reconstruction/src/litereality_agent/pipeline/runner.py) · [指纹](../../room-reconstruction/src/litereality_agent/pipeline/fingerprint.py) · [逐件路由](../../room-reconstruction/src/litereality_agent/pipeline/scene_init/reconstruct/classify/classify_complexity.py)

### 补充材料和会话预算

1. `LR_AUTHOR_EXTRA` 指向含 `README.md` 的目录，可自由附补充照片和旧房间。各 provider 都可从 `realism_authoring/evidence/operator/` 访问。建模和修复说明都要求先读其中的要求。
2. 从旧房间复用材质、贴图和部件代码时，使用新扫描的世界坐标。无位姿的照片可用 `evidence/helpers/` 中的 `rectify.rectify_image(照片, 四角像素, 输出, 尺寸)` 拉正为海报或画框纹理。按正常显示方向选角，HEIC 先转 JPEG。
3. `session_start` 记录补充材料目录和内容哈希。显式 `--set LR_CODEX_SESSION_SECONDS=<秒>` 可覆盖 `.env` 中的时限，默认 3,600 秒。用 `--set AUTHOR_STEPS=<次数>` 可调整工具调用预算，open 配置默认 300 次。
4. 会话因限额提前结束时，已保存的 `Room.py` 与检查点可供下次接续。在阶段报 `needs_repair` 后以原输入、目录和参数重新运行。检查点的有效性与质量验收分别判定。[配置与恢复契约](../refactor/contracts.md)

## 检查与发布

1. author 编译房间后，在 `realism_authoring/small_objects/` 处理小物品，再在 `articulate/` 处理开合部件。按当前可用的完整房间检查支撑关系，并由独立模型对照照片给出通过与否。
2. 检查不通过时默认修复一次。修复会话编辑 `Room.py` 后重新编译，再运行两步处理，各自复用未变物品。新版本可构建时以修复结果发布，无第二次视觉复查。构建失败会回退并标记需修复。
3. `--repair-rounds 0` 只检查，失败会停在 `needs_repair`。新建任务可用 `--no-articulate` 略过开合处理。对已完成的 author，单改此开关不会自动重做。
4. 发布沿用检查或修复所得的房间，放进 `realism_authoring/room_preview/`，烘焙材质。结果未变时复用已有构建。结果见 `author_acceptance.json`、发布的 `acceptance.json` 中的 `passes`。
5. 单项增强失败时流程仍可使用其余成果继续。读 `realism_authoring/logs/small_objects.log`、`articulate.log` 及报告中的 `warnings`、`left` 核对缺件。网页还校验 `Room.glb`、布局和物品清单后才把房间加入目录。

[质量检查与修复](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/acceptance.py) · [两步增强和独立几何验证](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/passes.py) · [网页发布](../../web/scripts/room_executor.py)

### 小物品标记、判断与恢复

simulation 和 open 建模说明要求将照片中散放的杯子、纸巾盒等逐件标记。书架上一整排作为家具本身的书仍随家具建模。用描述性的驼峰名加编号，声明所落的桌面或地面。也可用 `group_fixture` 把特殊手工物品建成独立组。

```python
scene.mark_small(
    "TissueBox0", "tissue_box", bottom=(x, y, z), size=(width, depth, height),
    yaw_deg=yaw, rests_on="Table0", description="a white cardboard tissue box", color=(r, g, b),
)
```

| 处理 | 约定 |
| --- | --- |
| 外观 | `description` 用一行写明物品是什么、颜色和材质，供判断模型参考。`color` 填物品主色的 sRGB 值。 |
| 位姿 | 方块涂成主色，`bottom` 为世界坐标的底面中心，`size` 为转动前宽深高，`yaw_deg` 为相对正面 −Y 的有向角。 |
| 导出 | `room_layout.json` 记录 `small_marker: true`、`description` 和 `marker_pose`。随支撑移动后更新实测位姿。 |
| 候选 | 标记总是候选。已有重建网格、墙/天花板固定装置、可放物品的支撑家具通常跳过。手工小物品须单独命名并声明 `rests_on`。作为柜面设施、`panel`、`socket`、固定 `light` 或挂在结构上的物品会被过滤。 |
| 叠放 | 命中单件预制件时逐件替换（如两本书分别用 `Book.glb`）。其余同为标记或同为手工几何且互相支撑的候选，上件覆盖至少自身面积的 60%、其面积至少为下件的 30% 时可合成一摞。 |
| 类别与支撑 | 一摞取数量最多的类别，平票按自下而上的稳定顺序。分开判断仍保留上下关系。要删的下层仍支撑存活物件时保留下层并记录原因。 |
| 判断 | 有预制模型则直接替换。没有预制模型且没有扫描视图或近照的标记会被删除，即使强制重建。有照片可问判断模型一次，给出作者描述或重建提示。 |
| 策略 | 占位标记只能重建或删除，其 `procedural` 判定转为 `trellis` 并记 `coerced: true`。生效的显式覆盖记 `decision.override`。只改强制来源、结果仍为重建时可复用模型。 |
| 放回 | 单标记用实测局部尺寸判断和做参考图，用世界包围盒投影照片。导入根有旋转仍按标记三轴缩放。转动 180° 会使放置缓存失效。成摞候选及旧布局缺位姿时按整体足迹拟合。 |
| 碰撞与可移动性 | 同一支撑上两个标记相互穿插可能超出原碰撞器检查范围。替换后散放物品带 `movable: true`，包括桌面台灯。移动支撑家具时随之移动。固定墙灯和顶灯仍归设施。 |

逐件判断、参考图、TRELLIS 或网格处理失败会留下原标记。成功替换和删除的其他物品仍生效。开合处理跳过仍带 `small_marker` 的方块。

原因见 `summary.md`、`small_object_done.reason` 和 author 的 `partial`、`left.small_objects`。

重跑先检查成品。丢失时可从干净网格、原始网格或预制来源恢复。材质失败从干净网格继续。近照和策略逐件入缓存，更改一件的近照只重做该件。旧房间缺标记方法、索引或正确的底面绕序时，建模提示指向对应模板。[候选筛选](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/small_objects/candidates.py) · [分项重建](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/small_objects/run.py)

### 预制模型

| 环节 | 数据与结果 |
| --- | --- |
| 制作 | 同类近照拼成底图，由 `.env` 配置的图像模型生成参考图，再由 GPU 上的 TRELLIS 重建。已有透明或黑底 `reference.png` 时直接采用，可省去近照与图像模型。避免深色物品与黑底混淆。 |
| 去碎块与校色 | 保留最大连通块、立在模型底面上的块及与它们接触的块，去掉其他悬空块。这样既保留同排立物，也保留书堆和书上花瓶。按参考图修正色相，非金属类金属度归零。 |
| 复用 | `<种类>.json` 记近照/参考图哈希、描述、模型设置与输出摘要。输入和输出匹配则跳过，换图只重做该种类。失败项不发布可用 GLB，整条命令以非零退出。 |
| 运行记录 | 终端报告每类的图片数、路径和用时。包装器写 `<模型目录>/attempt-NN/`，任务结束释放 GPU。独立预制没有场景回放事件。 |
| 引入房间 | 建模会话前逐个去碎块，准备 `Models/<种类>.glb`。可用来源的哈希写入 `Models/.sources.json`，未变且可读的副本复用。逐个记录错误，保留旧房间已经引用的副本。 |
| 位置与说明 | 任务说明列出描述、宽深高比例、`<模型目录>/work/<种类>/reference.png`。建模会话按照片位置用 `place_model` 直接摆放，单独的近照准备无需在补充材料里重复交代。 |

```python
scene.place_model(
    "TissueBox0", "Models/TissueBox.glb", bottom=(x, y, z),
    size=(width, depth, height), yaw_deg=yaw, rests_on="Table0",
)
```

`bottom`、`size`、`yaw_deg` 与占位标记一致。只给一个尺寸表示沿高度等比缩放。直放或替换时，按求值后的世界顶点测量三轴和底面中心，再按有向角旋转。首次登记、重新索引、`top_surface` 及布局均沿用实测边界。

直放后带 `source_glb`，后续小物品处理跳过。独立摆放的台灯也可移动。无预制件时仍用 `mark_small`。同名手工物品或占位只在模型本次已准备且源哈希一致时替换，按编号优先于种类匹配。

预制替换会按目标尺寸去碎块、拟合原位姿。已有来源时无需逐件判断、生成参考图或请求 TRELLIS。决定记录带 `forced` 和 `source`，完成事件带 `source`。更换来源只重做受影响物品。

不存在的来源目录会报错，无匹配的来源模型在日志里列一次。单一来源不可读则仅跳过这一项。每轮对同一文件只计算一次来源哈希。

旧 `Room.py` 缺少 `RoomScene.place_model`，或旧实现用 `world_bbox(meshes)` 八角拟合时，按会话提示从模板补齐方法、顶点测量函数、`_register` 的 `rebuilt` 参数与存储、`index` 对其转发。[预制](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/small_objects/premake.py) · [引入房间](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/small_objects/ready.py) · [编译模板](../../room-reconstruction/src/litereality_agent/room_ops/compile/build_room.py)

### 开合部件与旧房间

开合步骤识别门、抽屉和盖子等，切分网格、设置关节，再检查开合。按 5 mm 接触距离检查连通性。与支撑簇断开且面积小于总表面积 5% 的可移除碎块记入 `apply.json` 的 `cut[].loose`。[切分与碎块规则](../../room-reconstruction/src/litereality_agent/pipeline/realism_authoring/articulate/blender_ops.py)

| 输出 | 怎样使用 |
| --- | --- |
| 集成增强 | 两步依次生成 `realism_authoring/small_objects/`、`articulate/`，关节在 `articulate/room/Objects/`。发布的 `room_preview/` 包含成功应用的增强。 |
| 旧版发布后单独补跑 | 从 `small-objects/room_preview` 取 `Room.blend`、`Room.glb`、`room_layout.json` 与网格。用 `LR_ARTICULATE_SOURCE`，来源必须与当前 author 房间一致。更换源房间会使该步重做。 |
| 独立开合 | 建议输出到 `<运行目录>/articulate` 以兼容回放的默认路径。关节文件在该次处理的 `room/Objects/` 树。完整成功时记录启动、结果和模型保存事件。部分 `--through`、`--only` 不宣布整屋完成。 |
| 旧执行器 | `articulate-exit` 用于识别发布后另跑的增强。成功时用 `<运行目录>/articulate/room_preview/`，失败时查找唯一可用的已发布房间。 |

手动生成编辑器清单时，脚本先找预览旁的 `../articulate/room/Objects/`，再找 `../room/Objects/`，也可传 `--joints`。它将 `*/*/sim/*.urdf` 中可用的关节与 GLB 节点对应。[物品清单生成器](../../web/scripts/room_objects.py)

## 回放记录与阶段

场景在 `scene_init/obj_stage/traces/` 追加 `trace.jsonl` 和 `authoring_trace.*.jsonl`。检查来自 `realism_authoring/acceptance/`。流水线状态供续跑，回放按有时间的事件排布模型与配图。[事件写入](../../room-reconstruction/src/litereality_agent/telemetry.py) · [时间线生成](../../web/scripts/room_replay.py)

每条新版事件有 `kind`、Unix 秒 `t`、`schema_version=2`、`event_id` 和 `sequence`。显式重发同一事件 ID 时不会重复写入。

上下文包括 `job_id`、`run_id`、`attempt_id`、`stage`、`outcome` 和可选文件摘要 `artifact_digest`。

| 事件 | 在回放中的含义 |
| --- | --- |
| `trace_start`、`object_done` | `run` 标识本次 attempt。AI 重建或程序建模每做好一件即记录。已有模型（`method: provided` 或同时有 `reused`、`source`）也显示成形一次。同一任务重试时仅 `reused` 的物品沿用原成形时刻。 |
| `chair_qc_retry`、`chair_qc_restored` | 椅子形状检查失败后的重新生成、恢复原模型。过程错误保留在日志。网页筛除失败尝试。 |
| `room_built`、`model_saved` | 前者记录编译出现的部件。后者以 `seed`、`round`、`final`、`small_objects`、`articulated` 区分保存版本。持续改写最终文件不会提前触发“导出最终房间”。 |
| `review_done`、`repair_start`、`repair_done` | 展示通过、需修复或已尝试修改。`changed: false` 表示此次未改变房间。修复过程另存 `authoring_trace.repair.jsonl`。旧记录无 changed 时沿用旧文案。 |
| `small_objects_start`、`small_object_done`、`small_objects_done` | 逐件结果 `method` 为 `trellis`、`procedural`、`dropped`、`kept`。复用时 `reused: true`，时间仍属于本次运行。结尾汇总重建、删除和保留数。 |
| `articulate_start`、`articulate_done`、`artifact_published` | 开合处理开始和结果。只有具备关节计数证据才说“装好”。旧流程单独处理的模型需有匹配该模型摘要的发布记录，才能声称已发布。 |

### 实时、重试与兼容阶段

- 正常流程有读取手机扫描、整理房间布局、整理物品图片、制作物品模型、搭建完整房间、处理可开合部件、检查房间、按检查修改八个阶段。建模会话的调整、自查合入搭建。旧流程的修后复查合入按检查修改。
- `stage: "author"` 的小物品归入搭建，开合处理排在检查之前。修复后重跑的两步归入按检查修改。小物品逐件列成功重建，删除和保持原样只作汇总。修复重跑跳过已显示的复用项。
- 集成小物品按保存记录切换整房模型；修复覆盖原文件时，用保存摘要匹配当前或留存的快照。找不到匹配快照时只展示记录。开合模型按可用保存记录切换。独立补跑优先读记录中的 `path`，须实际位于运行目录内，否则回到对应默认路径。
- 一次运行正常退出（`attempt-NN/exit` 为 0），后一次自然续接。上次失败或旧运行无 `exit` 时标“重新开始重建”，检查轮次按尝试分别计数。独立小物品、开合步骤有自己的编号，按事件先后区分同名 attempt。
- 独立补跑的小物品按成功记录合成一张卡片，紧随“搭建完整房间”的搭建记录，随后显示处理汇总。事件及图片保留采集时间，展示位置单独计算。实时跟随仍定位到最近收到的记录，截断回看只使用截止时已保存的成果。
- 独立补跑的保存事件用 `overlay_model` 指定照片模型来源。从搭建起，三维视图在当前版本里查找同名占位，隐藏它自己的网格，并从来源 GLB 只取该物品及其世界变换。缺少占位的版本跳过该件。照片模型与占位包围盒的底面中心相距超过 3 厘米时，平移到该版占位的底面中心，保留照片模型的朝向和尺寸。开合版中已包含的照片网格沿用原件和关节。
- 有独立小物品记录且需要推算搭建动画时，优先采用返修前首次检查的房间快照。缺少该快照的返修任务沿用已保存的早期版本。检查各轮和最终阶段使用各自的整房模型、原图和结论。独立开合成果仍随对应版本展示，底部显示回放时长。
- 某次独立开合后若还有其他运行或后续增强，该次开合尝试及失败记录不会占据结尾。之后再开始小物品或开合时，之前的开合房间也不再代表最终版。没有独立小物品记录时不额外生成照片卡片。
- 记录 final 后另开建模会话，会增加“按意见修改”。其后的建模、集成增强、检查、修复和重新导出均归此阶段，保留原检查编号与模型。发布前的续跑仍归原阶段。
- 返修之前从旧房间另跑的增强不再占时间线。文件仍可在可用模型列表中找到。返修后按实际新运行的记录显示。
- 模型保存已有事件时用记录时间。旧任务缺少相关事件时根据模型修改时间、检查文件与会话记录推断并标注来源。新版摘要失配标 `external_change`，缺应有摘要标 `missing_digest`，置信度为 `unknown`。[文件证据](../../web/scripts/replay_history.py)

### 摘要与会话编号

流水线阶段用固定中文说明。建模与修复分别按批概括为中文，缓存到 `<任务号>/replay/summary.json` 的 `batches` 和 `repair`。重看复用已有概括。每批限同一会话，修复记录独立编号。

| 情形 | 处理 |
| --- | --- |
| 概括尚未生成 | 按时间合并简要说明，从记录里取物品编号、地板/灯光/材质等对象以及检查方式。只描述当时做的事。 |
| 选择模型 | `LR_REPLAY_MODEL` 优先，其次 `LR_CODEX_MODEL`，最后 `gpt-6-astra`。思考程度 `LR_REPLAY_EFFORT` 默认 `low`。 |
| 调用与失败 | 命令按 `LR_REPLAY_CODEX`、`$ROOMCANVAS_HOME/runtime/bin/codex`、PATH 中的 `codex` 依次选择。服务启动加 `--no-replay-summary` 只用规则文案。失败写 `replay-error.log`，5 分钟后才重试。 |
| 新会话 | 旧记录移入 `traces/history/authoring_trace.<author或repair>.run_NNN.jsonl`，历史与当前会话顺序拼接，编号累加。按会话内步号命名的图若被后续会话覆盖，不配回旧记录。 |
| 老摘要 | 缺 `"numbering": "sessions"` 时按每批第一条说明的时间定位所属会话，整体加上此前会话记录数。末批之前当时未概括的记录继续省略。工作线程写回标识，之后无需再次对齐。 |

### 图文卡片

| 输入 | 页面上的组织规则 |
| --- | --- |
| 一般记录与检查 | 行文左侧、小图右侧。缩略图通常 72 px，窄栏或双图时 56 px。检查结论下方显示 1–3 张当轮的渲染与实拍对照。失败时按摘要采用的前四条有效问题选图，优先覆盖多条问题和涉及的物体，必要时补充互补视角。检查程序将按文件名排序的图从 1 编号。通过或旧问题缺少视角时沿用首图；引用的图全部缺失时只显示结论。点击放大，连续相同文字折叠并显示次数。 |
| 同类逐件操作 | 连续的参考图、模型、形状检查或小物品重建按同类工作合并。依物品 ID 去重计数，显示名字和小图，每排三张，全部列出，不再逐条列出每件的原记录，缺图只列名字。 |
| 建模和修复 | 同一会话的连续动作最多六条，相邻间隔超过三分钟另起卡。显示首尾两条，折起中间内容，最多取这段确实看过的两张图。阶段开始、重启、检查结论等会分隔卡片。 |
| 滚动与定位 | 拖动时只显示截至当前的件数、图和记录。新增记录或等长但文案/图片变更时刷新，保留展开状态。上翻阅读会暂停自动滚动，回底部继续。单步、拖动、点记录时定位当前行。 |
| 配图时间 | 清晰图使用当时的参考图，模型尚未完成时不预用成品图。摘要选的图必须来自其覆盖记录，否则在该段实际看过的图中取图，缺图保持纯文字。 |

小物品用了预制模型时，按记录的 `source` 找 `<模型目录>/work/<种类>/reference.png`。只公开这张参考图，映射为 `small-objects/reference/<物品>.png`，精简副本保持同样路径。

没有预制参考图时使用 `small-objects/evidence/<物品>/view0.jpg`。若该图拍的是整面书柜，用相机投影求 `media.crop` 裁出物品。生成 `pair_after.jpg` 后，放大可看实拍与重建对照。[图文卡片](../../web/replay/log.mjs)

### 三维镜头与时钟

| 时刻 | 镜头与图像 |
| --- | --- |
| 读取扫描 | 点云从中央向外展开。用深度与照片投影判断遮挡并取色，找不到颜色则按高度渐变。出现墙线和物品框时点云约一秒淡出。 |
| 制作物品 | 墙和地面先出现，未完成物品保留线框。完成时选择少遮挡、与墙保持距离的视角，必要时抬高镜头。当前位置已看清则保持。相邻物品间直接平移。 |
| 成形 | 同色表面点亮起，蓝色线框自下往上扫过，再填入实体，约三秒。成批出现时从低到高错开，四秒内全部开始。后来编译出现的部件使用同样的成形效果。 |
| 切换房间 | 随证据切换初版、小物品、开合、检查快照与最终模型，新模型约两秒淡入。实时建模时工作模型以 300 秒时间桶更新，最终记录写入后切到 final。模型加载失败的冷却时间为五秒。 |
| 辅助功能与光照 | 拖动时间轴直接显示目标状态，尊重“减少动态效果”。结束时复用编辑器物理光照，按节点名找室内灯具，回拖则还原回放光照。[光照实现](../../web/editor/time-lighting.mjs) · [灯具识别](../../web/editor/room-luminaires.mjs) |

读取扫描阶段至少显示 6 秒。物品首次成形留 4.5 秒，一组物品的最后一件最多延后 4 秒。模型切换 2 秒，阶段首条至少 1.5 秒，普通事件 0.1 秒，结尾至少 3 秒。已出现物品重做不重复占用成形时间。

总播放时长主要随首次成形的物品数量变化，常见场景约两分钟。加速时移向物品仍按 1×，成形和模型淡入按所选倍速的平方根（2× 约 1.4，4× 为 2），其他时段按所选倍速。

按实际顺序播放时，时钟以 `attempt-NN/run-config.json` 和 `exit` 还原工作区间，缺退出记录时可取日志最后写入时间。相隔超过两分钟的空闲段、被后续替代且没有展示内容的尝试会扣除。结尾显示检查结果或未完成提示，分数和过程错误留在日志。[时间轴](../../web/replay/timeline.mjs) · [镜头](../../web/replay/room-view.mjs) · [成形](../../web/replay/materialize.mjs)

## 登记与缓存

`room_replay.py --run` 查找一个包含 `scene_init/obj_stage` 的场景，登记为仅回看的 completed 任务，并将任务目录中的 `run` 链至源运行。默认截止时间取最后的检查、相关模型或匹配发布记录中最晚时间加 120 秒，`--until` 可显式指定。

`--slim-to` 复制回放实际读取的历史会话、检查、点云与布局、白名单图片和模型、各次执行的 `run-config.json` 与 `exit`，尽量保留时间戳，然后让登记指向副本。若需继续重建或保留完整取证数据，请保留原运行。[历史样本测量](../history/ROOM_RECONSTRUCTION_VALIDATION.md)

已完成任务由本机 `serve.py` 后台下载到 `runs/room-cache/`，全部缓存后可离线访问。实时目录/时间线优先询问服务，离线用上次响应。文件 HEAD 只传大小与 `X-RoomCanvas-SHA256`，已有同内容模型时建立链接。

摘要缓存以路径、设备、inode、大小、修改和状态变化时间识别文件版本。新服务的下载会核验哈希，版本对不上稍后重试。[本机缓存](../../web/scripts/room_cache.py) · [服务端文件读取](../../web/scripts/room_service.py)

## HTTP 接口与离线检查

以下是房间服务接口，均以 `/room-reconstruction` 为前缀。本机网页通过 `serve.py` 转发任务、目录、回放和已发布文件的 GET 请求。写请求检查 Origin，扫描包经暂存文件分块转发。

样例下载器和缓存同步器直接访问后端的样例与 HEAD 接口。凭证、监听与网关配置见[服务器部署指南](../SERVER_DEPLOYMENT.md)。

| 方法与路径 | 返回或提交内容 |
| --- | --- |
| `GET /health` | 连通性、上传上限与预览模式。模型依赖、权重和 GPU 推理需另行验证。 |
| `POST /jobs` | 单个原始扫描包。请求头 `X-Room-Name` 为 URI 编码名称（最多 80 字符），`X-Upload-ID` 为 32 位小写十六进制幂等 ID。上传和解包分别限 2 × 1024³ 和 8 × 1024³ 字节，最多 50,000 项。 |
| `GET /jobs`、`GET /jobs/<id>` | 任务列表、执行与质量状态。 |
| `POST /jobs/<id>/retry` | 重新排队可重试的失败任务。 |
| `GET /catalog`、`GET /assets/<id>/<文件>` | 可使用的房间，以及已发布的 `Room.glb`、`room_objects.json`、可选 `thumbnail.jpg`。 |
| `GET /samples/<room>/Room.glb` | 只读取示例清单内、服务器已有的模型。 |
| `GET /jobs/<id>/replay` | 阶段、排序后的事件、模型、成形安排、空闲时间段与模型证据，供 `web/replay.html?job=<id>` 使用。 |
| `GET /jobs/<id>/replay/scaffold/<文件>` | `points.bin`、`layout.json`、`colors.bin`。颜色首次按需生成。缺可用图像时返回 404，网页用高度渐变。 |
| `GET /jobs/<id>/replay/files/<相对路径>` | 白名单模型与图。小物品证据仅开放各件的 `view0.jpg`、`pair_before.jpg`、`pair_after.jpg` 及映射后的预制参考图。其他路径返回 404。 |
| `HEAD` 文件路径 | 响应不带正文，返回大小与摘要。请求指定图片版本时，内容已经变化则返回 409。 |

从仓库根目录运行离线接口与提交表单测试，无需 GPU、模型或建模会话。

```bash
python3 -m unittest discover -s web/scripts
node --test web/scripts/test_room_reconstruction.mjs
```
