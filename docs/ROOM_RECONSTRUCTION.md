# 房间重建

用支持 LiDAR 的 iPhone 和 LiteReality Scanner 扫描房间。网页可把完整扫描包重建成按实际尺寸布置的房间，保留纹理、可移动物品和识别到的可开合部件。已有服务时从[网页上传](#从网页重建房间)开始。

## 从网页重建房间

1. 在扫描 App 中导出**一个房间的完整扫描包**。支持 ZIP、TAR、TAR.GZ、TGZ，可直接使用 App 导出的 TAR。
2. 打开[本机房间首页](http://127.0.0.1:7880/web/#reconstruct)，点 **重建房间**，填写房间名称，选择或拖入文件，再点 **上传并开始重建**。
3. 百分比走完表示上传结束。回到首页的 **房间重建任务** 看当前阶段。提交成功后可关页或刷新，服务器继续重建。按钮不可用时检查服务连接和运行模式。

### 扫描包要求

| 内容 | 要求 |
| --- | --- |
| 房间结构 | 一份 `room.usdz`，可位于房间目录或其 `roomplan/` 子目录。可保留外层房间文件夹。 |
| 相机与深度 | 每个 `frame_*.json` 都要有同编号的 `depth_*.png`。相机、深度和图像可在房间目录或 `images/` 中。 |
| 图像与点云 | 同编号的 `frame_*.jpg`，或房间根目录的 `frames.mp4`。可一并上传扫描仪导出的 `pointcloud.pcd`，重建优先使用。 |
| 容量 | 网页显示上传上限 2 GB，展开上限 8 GB、50,000 项。服务按文件内容识别格式。普通照片集或已经生成的场景包无法用于整屋重建。 |

若手里是导出的文件夹，可在本机打包。以下任选其一，把路径和文件夹名替换为实际值。

```bash
tar -cf room.tar -C /path/to/scans room-folder
tar -czf room.tar.gz -C /path/to/scans room-folder
```

### 使用与结果

- 完成后在首页点房间卡片进入布置。网页会检查模型和布局，生成物品清单，自动加入房间列表。新房间和回放下载到本机缓存后可离线打开。[服务器部署与缓存](SERVER_DEPLOYMENT.md)
- 若任务失败，先看任务提示。可以重试的任务会复用已完成阶段。输入有误时重新导出并上传扫描包。日志位置及任务恢复规则见[任务记录与队列](architecture/replay-and-pipeline.md#任务记录与队列)。
- 首页显示“房间预览暂不可用”时仍可进入房间。要补缩略图，在本机连接服务后，从仓库根目录运行下列命令。需安装 Playwright、Chromium 和 Pillow。

```bash
python3 web/scripts/thumbnail.py --url http://127.0.0.1:7880/web/ \
  --room 'scan-<任务号>' --ssh '<SSH 主机>' --server-dir '<服务器数据根目录>'
```

缩略图工具写入 `--server-dir` 下的 `runs/web-room-jobs/<任务号>/assets/thumbnail.jpg`。用自定义 `--data-dir` 时先核对目录布局。

### 查看重建过程

1. 在任务旁点 **实时查看** 或 **查看过程**。左栏按阶段展示文字和缩略图，点图可放大。右侧会从扫描点云、墙线和物品框逐步切换到成形的房间。
2. 重建中约每 5 秒刷新一次。拖动时间轴可回看，点 **回到最新** 恢复跟随。已完成任务从头播放，可逐步查看或选 0.5×、1×、2×、4×。
3. 左栏通常有八个阶段。发布后按意见返修的房间还会显示修改过程。底部时钟表示重建实际工作的时间。结尾会说明检查和修改结果，未完成的任务可回首页查看原因。

<a id="api-与验证"></a>

接口路径和验证命令见 [HTTP 接口与离线检查](architecture/replay-and-pipeline.md#http-接口与离线检查)。旧运行的登记命令见[登记命令行回放](#登记命令行回放)。阶段顺序、图文和模型如何对齐见[回放与流水线](architecture/replay-and-pipeline.md)。

<a id="运行环境"></a>

## 安装

在有 NVIDIA GPU 的 Linux 服务器上，从仓库根目录运行 `sh scripts/setup_server.sh rooms`。安装前先设置 `ROOMCANVAS_HOME`，加 `--dry-run` 可预览步骤。[服务器准备与安装](SERVER_DEPLOYMENT.md#安装环境)

| 房间配置 | 设置方法 |
| --- | --- |
| 图像生成 | 在 `$ROOMCANVAS_HOME/.env` 配置 `OPENAI_API_KEY`，或为 Gemini 设置 `GEMINI_API_KEY` 和 `LR_IMAGE_PROVIDER=gemini`。建模另需登录 Codex CLI。 |
| 扫描来源 | 默认扫描父目录为模块的 `scans_uploaded`。用 `LR_SCANS_DIR` 指向其他父目录，或在命令中给出扫描绝对路径。 |
| 本地推理 | 设置 `LR_DINO_BACKEND=local`。保持 `.env` 和启动终端中的 `MODAL_TOKEN_ID`、`MODAL_TOKEN_SECRET`、`MODAL_PROFILE` 为空。解释器及 Blender 路径由运行器设置。 |

<a id="启动服务"></a>

只安装房间环境时，可直接启动独立房间服务。服务器和本机分别从各自仓库的根目录运行。要一并提供物品重建与默认单网关入口，见[启动与连接](SERVER_DEPLOYMENT.md)。

```bash
# 服务器，监听 127.0.0.1:7866
"$ROOMCANVAS_HOME/runtime/litereality-env/bin/python" web/scripts/room_service.py \
  --data-dir "$ROOMCANVAS_HOME/runs/web-room-jobs"

# 本机，只转发房间服务。让这个 SSH 终端保持打开。
ssh -N -L 127.0.0.1:7866:127.0.0.1:7866 '<SSH 主机>'

# 本机，另一个终端，先按运维指南将服务凭证保存到仅本人可读的文件
python3 web/scripts/serve.py --room-backend http://127.0.0.1:7866 --token-file '<本机凭证文件>'
```

## 运行

**标准完整重建。** 扫描已在服务器时可直接运行。扫描仍在本机时，先用下列命令传到服务器上已有的扫描父目录。`<SSH 主机>` 可用 SSH 配置别名或 `user@host`。

```bash
scp -r '<本机扫描目录>' '<SSH 主机>:<服务器扫描父目录>/'
```

服务器上在仓库根目录执行。每次新开 Bash 终端先设好以下变量。把示例中的路径替换为绝对路径。这里显式选用建模模型和思考程度，并以发布为终点。

```bash
export ROOMCANVAS_HOME='<环境与数据根目录>'
PY="$ROOMCANVAS_HOME/runtime/litereality-env/bin/python"
RUNNER=room-reconstruction/server/run_room.py
SCAN='<服务器扫描目录>'
RUN='<运行目录>'
MODEL=(--set LR_CODEX_MODEL=gpt-6-astra --set LR_CODEX_EFFORT=high)
"$PY" "$RUNNER" "$SCAN" "$RUN" --through publish --check "${MODEL[@]}"
"$PY" "$RUNNER" "$SCAN" "$RUN" --through publish "${MODEL[@]}"
```

`--check` 在取得 GPU 前检查当前代码的加载路径并打印配置。正式运行才会使用模型和 GPU。网页会等待可用卡，命令行要等待时加 `--wait-gpu`。[GPU 分配与锁](SERVER_DEPLOYMENT.md#分配-gpu)

| 要确认的结果 | 查看位置 |
| --- | --- |
| 是否成功退出 | `$RUN/attempt-*/exit`、同目录 `pipeline.log`。中断后使用原输入与运行目录续跑。 |
| 发布的房间 | `$RUN/pipeline/<场景>/realism_authoring/room_preview/` 中的 `Room.glb`、`Room.blend`、`room_layout.json`。场景名取含 `scene.json` 的实际目录。 |
| 小物品、门与抽屉 | 在 `realism_authoring/small_objects/` 和 `articulate/` 下查看。关节在 `articulate/room/Objects/`。发布清单和检查报告见[检查与发布](architecture/replay-and-pipeline.md#检查与发布)。 |

<a id="给建模-agent-的补充材料"></a>

### 给建模会话补充说明

在材料目录中写一份 `README.md`。例如列明要做成贴图的墙面海报、要能单独移动的桌面物品。可附近照、贴图或旧房间素材。缺少说明文件时建模阶段会停止。

首次重建时，将材料目录作为参数加入前面的 Bash 命令。

```bash
"$PY" "$RUNNER" "$SCAN" "$RUN" --through publish \
  --set LR_AUTHOR_EXTRA='<材料目录>' "${MODEL[@]}"
```

### 发布后按意见修改

房间已发布时，把本轮修改要求写入材料目录的 `README.md`，用下列命令发起返修，并保留上一次使用的其他 `--set` 配置。

```bash
"$PY" "$RUNNER" "$SCAN" "$RUN" --from author --through publish --revise \
  --set LR_AUTHOR_EXTRA='<材料目录>' "${MODEL[@]}"
```

`--revise` 在现有房间上开新会话。只改补充材料或模型目录不会自动触发已完成的 author 阶段。要从初版重新建模，可换一个运行目录。模块 CLI 的 `--force author` 与服务器包装器支持的选项见[阶段复用与建模输入](architecture/replay-and-pipeline.md#阶段复用与建模输入)。

### 路由偏好与沿用已有模型

同一房间重新扫描时，可指定物品的建模方式，或沿用一次旧重建中的物品。以下参数通过 `--set` 传入。重建开始后，保持各阶段参数和来源文件一致。

| 参数 | 作用 |
| --- | --- |
| `LR_ROUTE_POLICY=trellis-first` | 优先用 TRELLIS。储物类和判为普通矩形的桌子保留程序化建模。默认由分类模型判断。 |
| `LR_ROUTE_OVERRIDE=Table0=trellis,Storage1=procedural` | 针对本次参与路由的物品或椅子组显式选路。仅接受表中示例的两种路线。 |
| `LR_PROVIDED_MODELS=<目录>` | 放入同编号的静态 GLB 或程序化目录。目录含一个 GLB、`object.py`、`object.md`，可含 `previews/` 和 `textures/`，内部可沿用旧文件名。 |
| `LR_PROVIDED_TURN=Table0=90` | 已有静态 GLB 绕竖直轴转动指定角度，从上方看逆时针为正。若日志提示长边将落在短边，先核实朝向。 |

1. 在服务器 Bash 中运行到输入整理阶段，再查看本次物品编号。
2. 打开场景的 `scene_init/obj_stage/object_init/`。在此目录内核对物品、椅子组和门窗的编号。

   - 单个物品见 `object_refs/<场景>/<编号>/reference_1024.png`。
   - 椅子组见 `chair_clusters/<场景>/chair_clusters.json`。
   - 门窗见 `opening_refs/<场景>/`。

3. 按编号放好已有模型，必要时补上覆盖参数，接着跑到发布。未知编号会报错并列出可用编号。

```bash
SETS=("${MODEL[@]}" --set LR_ROUTE_POLICY=trellis-first --set LR_PROVIDED_MODELS='<已有模型目录>')
"$PY" "$RUNNER" "$SCAN" "$RUN" --through ingest "${SETS[@]}"
# 对照编号准备好模型后执行
"$PY" "$RUNNER" "$SCAN" "$RUN" --from reconstruct --through publish "${SETS[@]}"
```

<a id="小物件"></a>

### 小物品与可开合部件

完整重建会在检查前先处理小物品，再处理门、抽屉和盖子等部件。新任务加 `--no-articulate` 可略过开合处理。下表的变量也可用 `--set` 传给完整任务或独立补跑。标记的写法见[小物品标记、判断与恢复](architecture/replay-and-pipeline.md#小物品标记判断与恢复)。

| 变量 | 适合的情形 |
| --- | --- |
| `LR_SMALL_OBJECTS_PHOTOS=<目录>` | 按 `<目录>/<物品编号>/*.jpg` 补充近照。扫描中看不清但有近照也可判断。近照加入参考底图前几格。 |
| `LR_SMALL_OBJECTS_POLICY=trellis-first` | 优先重建手工搭建的小物品，仅在所有图均不可辨认时删除，形状规整到无需 TRELLIS 时沿用。占位标记自有判断规则。 |
| `LR_SMALL_OBJECTS_FORCE=TissueBox0=trellis` | 可用逗号分隔逐件指定 `trellis`、`procedural`、`drop`。编号须属于本次候选。 |
| `LR_SMALL_OBJECTS_MODELS=<模型目录>` | 优先采用 `<编号>.glb`，其次用去掉尾部数字的 `<种类>.glb`。供建模会话直接摆入房间，或在独立补跑时替换占位。 |

<a id="预先做好小物件模型"></a>

**预制小物品。** 在 `<近照目录>/<种类>/` 放 JPG 或 JPEG，同类物品可共用模型。可加一行 `description.txt` 描述物品。缺省按种类名称生成描述。若已有抠好的干净参考图，放 `reference.png` 即可，深色物品宜用透明底。

```bash
"$PY" "$RUNNER" --premake-small-objects '<近照目录>' '<模型目录>' --check
"$PY" "$RUNNER" --premake-small-objects '<近照目录>' '<模型目录>'
```

仅制作部分种类可加 `--only TissueBox WaterBottle`。每类输出一个 `.glb` 和同名 JSON，再用上表的模型目录变量交给重建。失败项会在终端报告。来源、摆放和缓存规则见[预制模型](architecture/replay-and-pipeline.md#预制模型)。

<a id="可动部件"></a>

**独立补跑。** 输入是已有的场景目录。以下命令分别列候选、重做小物品、处理可开合部件。可先给相应命令加 `--check` 核对配置。单独补跑不自动触发整屋检查。关节文件的位置及旧版房间的处理见[开合部件与旧房间](architecture/replay-and-pipeline.md#开合部件与旧房间)。

```bash
SCENE="$RUN/pipeline/<实际场景名>"
"$PY" "$RUNNER" --small-objects "$SCENE" "$RUN/small-objects" --through evidence
# 按 candidates.md 中的编号准备近照后执行
"$PY" "$RUNNER" --small-objects "$SCENE" "$RUN/small-objects" --set LR_SMALL_OBJECTS_PHOTOS='<近照目录>'
"$PY" "$RUNNER" --articulate "$SCENE" "$RUN/articulate" "${MODEL[@]}" \
  --set LR_ARTICULATE_SOURCE="$RUN/small-objects/room_preview"
```

`--through evidence` 列出候选编号、建模名称、类别、证据数和目录，仅整理证据。单独只做开合部件时省略 `LR_ARTICULATE_SOURCE`。如需串接两步，该来源必须是从当前房间完整生成的小物品结果。

两个输出目录各有 `room_preview/`。`overview.jpg` 可对比替换前后或开合状态。若需核查独立结果，从仓库根运行只读几何检查，可加 `--json '<文件>'` 保存报告。退出码 0 为通过、2 为检查不通过、1 为未能检查。

```bash
PYTHONPATH=room-reconstruction/src "$PY" -m litereality_agent.pipeline.realism_authoring.passes \
  "$SCENE/realism_authoring" "$RUN/articulate/room_preview"
```

### 接入网页

网页提交的任务自动发布。手动重建的房间可复制到本机仓库并加入房间首页。下面以新目录 `samples/my-room/` 为例，已有同名目录时另取名称。

1. 本机准备 Git、Python 3、SSH。已有仓库时直接进入仓库根目录。首次获取先运行 `git clone https://github.com/innovationasuna/RoomCanvas.git`，再 `cd RoomCanvas`。
2. 从选定结果复制预览目录，需开合部件时再复制关节文件。以下 `<结果目录>` 通常是服务器场景的 `realism_authoring`。
3. 生成物品清单，核对输出的物品数、可移动组数、关节数及 `joint left out` 提示。脚本用 Python 标准库读取布局、校验 GLB 节点并写出清单。

```bash
mkdir -p samples/my-room
scp -r '<SSH 主机>:<结果目录>/room_preview' samples/my-room/
mkdir -p samples/my-room/articulate/room
scp -r '<SSH 主机>:<结果目录>/articulate/room/Objects' samples/my-room/articulate/room/
python3 web/scripts/room_objects.py samples/my-room/room_preview
```

独立开合结果的 `<结果目录>` 是 `$RUN/articulate`，其关节在 `room/Objects`。此时去掉复制命令中相对结果目录和相对样例目录的 `articulate/`。其他布局可用 `--joints '<本机 Objects 目录>'`。

`scp -r` 会跟随符号链接。换用其他复制工具时应确保目标含实际文件。缺少关节源文件仍可浏览和移动物品，但无法恢复对应开合。

在本机 `web/rooms.json` 的 `rooms` 数组中追加条目。目录相对 `web/`。启动 `python3 web/scripts/serve.py` 后，打开[新房间](http://127.0.0.1:7880/web/editor/?room=my-room)核对布局、移动与开合。

```json
{"id": "my-room", "name": "我的房间", "dir": "../samples/my-room/room_preview", "note": "手机扫描重建的房间"}
```

照片添物还需连接[物品重建服务](OBJECT_RECONSTRUCTION.md)。房间清单、缩略图见[网页指南](../web/README.md#房间文件)。

### 登记命令行回放

服务器上从仓库根目录登记含一个场景的运行。记录会出现在任务列表供回看，服务运行中也可发现。默认登记原目录的链接。如要保留精简副本，追加 `--slim-to '<新目录>'`。

```bash
"$PY" web/scripts/room_replay.py --data-dir "$ROOMCANVAS_HOME/runs/web-room-jobs" \
  --run "$RUN" --name '<房间名>'
```

`--until <Unix 时间>` 可指定截止时间。登记仅添加回放，若还要在编辑器里布置，按[接入网页](#接入网页)操作。副本内容、旧任务兼容及接口见[回放与流水线](architecture/replay-and-pipeline.md)。
