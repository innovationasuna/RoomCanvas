# 网页编辑器内部实现

本页面向修改编辑器、接入新房间或排查渲染差异的开发者。用户操作见[网页编辑器指南](../../web/README.md)。回放事件、任务阶段与续跑见[回放与重建流水线](replay-and-pipeline.md)。

## 模块职责

网页按原生 ES 模块加载，仓库内的 Three.js 核心库与插件对应 r180（`three@0.180.0`），无需前端构建。源码位于 [web/](../../web/)。表中仅写文件名的模块随所属页面存放，工作台、光照和几何模块都在 `editor/`。

| 入口 | 主要文件与职责 |
| --- | --- |
| 首页 | `index.html`、`home.mjs`、`home.css`、`rooms.json` 展示房间卡片和加载状态。`room-reconstruction.mjs` 处理扫描上传、任务进度和重试，`room-trash.mjs` 管理回收站。 |
| 回放 | `replay.html`、`replay/replay.mjs` 装配页面，`timeline.mjs` 换算时间，`room-view.mjs` 管三维视图。服务端 `scripts/room_replay.py` 读取并概括运行记录。 |
| 手机 | `editor/mobile-snapshot.mjs` 生成静态快照，`mobile-share.mjs` 管分享弹窗，`mobile/viewer.mjs` 加载手机页面。 |
| 共用外观 | `theme.css` 定义 `--rc-*` 配色，`icon.svg` 提供图标。深灰框架和黄铜色界面强调色与绿色物品选中反馈分开。 |
| 工作台 | `editor/form-workspace.mjs` 和同名 CSS 组合侧栏、物品库、详情、设置和引导。`workspace-panels.mjs` 管面板互斥，`workspace-motion.mjs` 和同名 CSS 管过渡。 |
| 场景和放置 | `editor/scene-editor.js` 对接场景与交互，`room-catalog.mjs` 解析房间清单。 |
| 放置与布局 | `placement*.mjs` 和 `joystick-ui.mjs` 管放置与控件，`layout.mjs`、`warehouse-drawer.mjs` 管布局和物品库。 |
| 几何与漫游 | `editor/collision*.mjs`、`drop-placement.mjs` 检查碰撞、支撑和掉落。`joints.mjs` 和 `walk.mjs` 管开合、承载和漫游。 |
| 比例与缩略图 | `ground-grid.mjs` 与 `furniture-thumbnail.mjs` 绘制网格及缩略图。 |
| 光照与显示 | `editor/*lighting*.mjs` 管光源、阴影和环境遮蔽，`color-grading.mjs`、`settled-render.mjs`、`render-metrics.mjs` 分别管理调色、静止补绘与计时。 |
| 材质显示 | 显示效果由 `material-layers.mjs`、`wall-visibility.mjs` 协调。 |
| 手势 | `editor/gesture-bridge.mjs`、`gesture-camera.mjs`、`gesture-feedback.mjs` 和 `vendor/gesture/` 连接摄像头、双手输入、状态显示及独立手势页。 |
| 添加物品 | `editor/object-*.mjs`、`imported-objects.mjs`、`add-object*.mjs`、`import-materials.mjs` 管上传、重建、目录、测量与材质。 |
| 服务和测试 | `scripts/serve.py` 是本机代理，`scripts/room_service.py` 提供服务器房间接口。房间清单、发布、封面及模型检查均在 `scripts/`，交互单测见 `editor/tests/`。 |

拉丁字符使用随网页分发的 Manrope，中文使用系统字体。界面过渡最长 220 毫秒，系统启用「减少动态效果」后停用。编辑器最小高度 640 像素，独立手势页的 iframe 高度不足时可能裁掉物品库。[字体许可证](../../web/assets/fonts/manrope-OFL.txt)

## 房间目录与清单

1. 将 `Room.glb` 与 `room_layout.json` 放在同一目录。在仓库根目录执行 `python3 web/scripts/room_objects.py "<房间目录>"` 生成 `room_objects.json`。
2. 在 [rooms.json](../../web/rooms.json) 增加 `id`、`name`、`dir`、`summary`。启动网页后执行 `python3 web/scripts/thumbnail.py --room "<id>"`。需要 Python Playwright、Chromium 和 Pillow。
3. `thumbnail.jpg` 来自编辑器整体视角。服务器发布的房间将封面存到对应发布目录，使用 `thumbnail.py` 的 `--ssh` 和 `--server-dir`。[房间重建指南](../ROOM_RECONSTRUCTION.md)
4. `editor/?room=<id>` 按列表定位，`editor/?scene=../../samples/room3` 相对于 `editor/` 解析目录。
5. 发布到仓库之外可用 `python3 web/scripts/publish.py --scene-dir "<房间目录>"`，输出在该目录的 `preview/editor/`。

**分组。** 清单将桌子连同桌面物品、书架连同书等一起管理。

清单区分结构、门窗、插座、灯、窗帘、暖气等固定设施以及可移动物品，并记录墙面归属和支撑关系。标有 `rebuilt` 的物品独立成组，放在其他物品上时随其移动。

**名称。** 默认名称按类别和编号生成，例如「柜子 1」。可给 `groups` 中的组设置 `"name": "钢琴"`，再次生成清单时会按组 ID 保留。打开房间时，编辑器还会从椅子网格推求座面。

**可开合部件。** 生成器在运行目录优先找 `articulate/room/Objects`，再找 `room/Objects`。搜索起点为 `room_preview` 的父目录。

用 `--joints "<Objects 目录>"` 可覆盖搜索路径。部件来自其下匹配 `*/*/sim/*.urdf` 的转动与滑动关节。

GLB 子节点必须唯一、隶属布局中的物品并与关节原点相合（容差 1 厘米），自身须无附加旋转和缩放。生成器把通过校验者转换到 Y 向上坐标，写入 `joints`，其余逐一输出跳过原因。[清单生成器](../../web/scripts/room_objects.py)

| 示例 | 清单中的可开合部件 |
| --- | --- |
| 卧室 | 10 个，包括 6 扇柜门、房门、推拉窗及钢琴的琴键盖和顶盖。 |
| 办公室 | 4 个，包括房门、两扇平开窗和升降桌。 |

开合按世界坐标合页线转动，可容纳不均匀缩放的柜体。滑动部件沿轴平移，动画耗时约 0.45 秒。关闭时预先在组内向下检查 6 厘米内的接触，识别部件直接承托及层层叠放的物品。返回布置会恢复关闭姿态，开合状态不持久化。

## 本机页面与重建服务

首页读取静态 `rooms.json` 与房间服务已发布的目录，合成响应。示例条目的 `scan` 可关联同一任务以避免重复卡片。页面从房间文件读取物品数与模型大小。已有缓存时，临时断线仍可显示离线目录。

| 功能 | 本机代理与数据流 |
| --- | --- |
| 房间 | `/web/#reconstruct` 打开上传弹窗，`/room-reconstruction/` 仅转发许可列表中的健康、任务、目录、回放与发布文件。扫描上传分块转发，上限为 2 × 1024³ 字节。 |
| 回放 | `replay.html?job=<任务号>` 定位运行中或已完成的任务。删除房间仅写入本机 `.roomcanvas/deleted-rooms.json`，不改扫描、模型或任务状态。回收站入口随悬停、键盘聚焦和打开状态高亮。 |
| 物品 | `/viewforge/assets/` 读目录、尺寸和模型，`/viewforge/objects/` 处理上传、抠图、重建与进度，`/viewforge/dimensions/<结果>` 写实测尺寸。代理限制可写路径和跨站请求。 |
| 手机 | 首次分享启动只读端口，默认 7881，可用 `--share-port` 改。静态快照存于 `.roomcanvas/shares/`，默认保留 7 天，可用 `--share-days` 改。修改启动配置后重启本机网页服务。[手机指南](../MOBILE_HANDOFF.md) |

**照片导入。** 浏览器按内容识别格式，按需加载 HEIC／HEIF 解码器，即使后缀误改也能本地转 JPEG。JPEG／PNG 保留原编码。前端显示转换进度，预览可读后才允许上传，出错时显示文件名。[解码器来源与许可](../../web/vendor/heic-to/README.md)

BiRefNet 生成抠图，DA3 与 MV-SAM3D 重建模型，COVER 提供补拍方向。照片、抠图、模型与标定存在物品服务的数据目录。前端可跨刷新续查，服务重启后内存任务状态丢失。已落盘的结果可重新导入。[物品重建流水线](../OBJECT_RECONSTRUCTION_PIPELINE.md)

显示使用完整模型，碰撞和支撑优先用同坐标的 `collision.glb`，缺失时依次尝试 `preview.glb` 与完整几何。完整落点检查可在后台运行。房间原有物品与导入实例使用相同的落下约束。[物品导入](../../web/editor/object-import.mjs)

## 示例模型的读取与发布

[模型清单](../../samples/models.json) 为每个示例指定 `path`、release 的 `tag`、附件名 `asset`、`bytes` 与 `sha256`。Git 内包含清单和封面，完整模型在 [sample-rooms release](https://github.com/innovationasuna/RoomCanvas/releases/tag/sample-rooms)。

当前三个示例合计 369.4 MB（369,432,388 字节）。

| 读取时机 | 行为 |
| --- | --- |
| 后台预取 | 本机服务先补缺少的示例，随后（通过 SSH 连接且启用预取时）补房间与回放缓存。两边同大小、同 SHA-256 的文件可复用。目录锁使下载、复用和清理协调进行。 |
| 打开缺模型的示例 | 只对清单中的文件响应 GET，先查本地缓存，再读房间服务。有 `scan` 的读对应已发布任务，无关联的读服务端准备好的 `samples/<房间>/Room.glb`。服务端仅开放清单文件。 |
| 未关联示例的后备来源 | 房间服务不可达或无法提供文件时，使用已有 GitHub 登录下载对应附件。若服务器返回的文件版本或大小不符，直接报错。有 `scan` 的示例不自动转 GitHub。 |
| 写入与重试 | 下载先写同目录独立的 `.Room-*.part`，字节数和哈希一致后再替换。按需获取只补缺文件。首页与 HEAD 不触发下载。修复来源后刷新只重试该房间。 |

示例和房间缓存可互相硬链接，跨文件系统则复制。硬链接共享底层数据，更新单个模型应以新文件原子替换，避免原地改写其他副本。启动、独立下载及全部清理会回收可识别的残留，回收会跳过在写目录、符号链接和完整模型。

**发布一份新模型。** 在仓库根目录设置房间目录名和新的附件名，如下。用新附件名可以保留旧提交的可复现性。发布者需有该 release 的写权限。

```bash
room='office'
asset='office-Room-v2.glb'
cp "samples/$room/Room.glb" "/tmp/$asset"
gh release upload sample-rooms "/tmp/$asset" -R innovationasuna/RoomCanvas
wc -c < "samples/$room/Room.glb"
shasum -a 256 "samples/$room/Room.glb"
```

将附件名、实际大小和哈希更新到对应清单条目。要恢复清单版本，用 `python3 scripts/fetch_samples.py --verify office`。加 `--verify` 才能发现长度相等、内容不同的文件。[下载与缓存维护](../SERVER_DEPLOYMENT.md#示例模型与本机缓存)

**清理接口。** `GET /web/cache` 返回条目。向 `POST /web/cache/clear` 提交 `application/json`，使用 `{"ids":["sample:office"]}` 或 `{"all":true}`。

服务校验本机 Host、Origin 和跨站标记，响应含 `freed_bytes`、`removed_files`、`errors` 与最新 `cache`。

预计空间按设备号与 inode 去重。只有选中该数据的全部硬链接才算可释放，目录外仍有引用时同样不计。清理建立 `.roomcanvas/cache-downloads-paused`。单个示例的按需读取不会解除暂停。[缓存管理实现](../../web/scripts/cache_manage.py)

## 近侧墙与材质层

背向镜头或近乎侧向的墙与其门窗、插座、窗帘、挂画同步隐藏或淡化。墙角短墙跟随相连的长墙。遗漏墙面归属的窗帘按位置匹配前方墙。地面以上高达 1.6 米的物品，背靠近侧墙或位于靠镜头半区时也参与处理。

支撑查询把柜内物品、墙架上的物品一同处理，靠镜头半区的判断有 10 厘米缓冲。半透明不透明度为 0.08，隐藏可用零不透明度。两者均允许鼠标及手势穿透。摆放预览始终实心，碰撞和支撑仍按原几何。

材质从原材质逐层组合，优先级由低到高为 `timeExterior`、`seeThrough`、`wallChoice`、`editingWall`、`selected`、`preview`。移除某层会重新组合，因此退出选择可正确还原近侧墙与物品材质。[材质层](../../web/editor/material-layers.mjs)

普通光照下淡化层关闭投影和接影。其他时段与物理光照会恢复原来可投影的不透明墙体遮光，淡化表面仍不接影。窗玻璃允许直射光通过。[近侧墙](../../web/editor/wall-visibility.mjs) · [时段遮挡处理](../../web/editor/time-lighting.mjs)

地面网格按主墙方向铺在真实地面之下，线宽按屏幕像素绘制，远处细格逐渐淡出。网格只提供视觉比例，独立于选择、支撑与碰撞查询。

## 时段照明与夜窗

普通光照使用半球光与两盏平行光。其余日间时段依据最大窗户所在墙面推算相对日照方向。缺少窗时用固定方向。窗边天光向室内衰减，初始化时生成一次 RoomEnvironment 贴图用于 PBR 环境反射。

| 计算环节 | 参数与分配 |
| --- | --- |
| 找灯具 | 从清单识别装在顶面的 `light`、`light_fixture`、`luminaire`。按发光部件的世界坐标拟合矩形，保存长度、宽度与方向。缺发光面时采用灯具网格。 |
| 顶灯亮度 | 基础强度随房高变化。有灯具时再乘 `max(1, 地面面积 / 20 m²)^0.75`。无灯具时在天花板下用带小球标记的中央聚光灯。开关同步控制灯具原材质的自发光。 |
| 日间补光 | 每约 3.5 米灯带对应一盏聚光灯，每件 1–3 盏，全屋最多 6 盏。早晨、中午、下午的室内灯系数为 0.25。日间主要阴影来自太阳和窗边天光。 |
| 夜间直射 | 每件保留的灯具底面生成一盏向下的 RectAreaLight，最多 6 盏，超限时按发光面积选取并把其余份额并入最近灯具。矩形面光源照亮 Standard／Physical 材质，自身不生成阴影图。 |
| 夜间投影 | 从一件代表灯具的轴向强度中分出 40%，交给底面下方 2 厘米的聚光灯。三根等面积灯带约 87% 的轴向总强度由矩形光源提供，如 Activity Classroom。静态 AO 补接触暗部。 |
| 关灯与反光 | 暖半球光强度 1.05，环境反射强度 0.08，均随夜间室内灯关断。夜间停用太阳、窗边天光及模型内嵌灯。这里的强度用于预览，实际照度受灯具光通量、配光与饰面影响。 |
| 光锥与分辨率 | 60°–170° 为完整光锥角，默认 160°，夜间只调有投影的聚光分量。夜间最多生成一张阴影图。模型灯具的分辨率为 1024²，中央后备灯为 2048²，手机网页查看器为 512²。 |

夜空面使用深度偏移以免背板穿出。主窗墙上的共面玻璃共享 512 × 256 的反射图，观察方向与折射率控制倒影。只在开灯且能见玻璃时按需捕获，转动镜头可复用缓存。

反射用同一深度平面近似室内景物，因此近物可能有视差误差。其他方向的窗保留薄透明层。编辑器与手机网页共用时段灯光和玻璃材质。[灯具分配](../../web/editor/room-luminaires.mjs) · [夜窗实现](../../web/editor/night-window.mjs)

## 物理光照

网页与 Android 漫游的 PhysicalRoomLighting 共用房间流水线 `lighting="physical"` 的参数口径。编辑器默认仍是中午。物理档可单独比较固定太阳、房间灯具与天花板后备灯。[物理照明实现](../../web/editor/physical-lighting.mjs)

| 光源或参数 | 规则 |
| --- | --- |
| 相机 | f/0.7、1/125 秒、ISO 100，EV100 ≈ 5.94，曝光 ≈ 0.0136。`preExposure` 从曝光和原渲染曝光换算并预乘光强，保留窗外照片、网格和摆放预览的原亮度。 |
| 太阳与环境 | 2500 lux、6500 K，固定仰角 40°、方位 35°。用 RoomEnvironment 折算手机端 0.25 绝对环境强度（约为顶灯照度的 1%），无需额外 HDR。 |
| 模型顶灯 | 每盏取发光面积 × 100 W/m² 与长度 × 30 W/m 中较大者，限 10–250 W。长度项让细长灯带获得足够光通量。按面积估算可能仅为长度项的约三分之一。 |
| 功率分配 | 在最多 6 盏 4700 K 聚光灯间分配。合计不足 60 W 则按比例补到 60 W，例如 room3 的四个筒灯各 15 W。光锥变宽时坎德拉降低，光通量保持不变。 |
| 无模型顶灯 | 每块天花板下 5 厘米放置 60 W、4700 K 点光源，约 382 cd。可开关，光锥角只作用于聚光灯。 |
| 窗光 | 从窗户向室内偏移 8 厘米并略朝下，20 W、6500 K、约 279 cd，内外锥半角为 45°／85°。 |
| 模型自带灯 | glTF 内嵌灯光时优先使用嵌入灯，无需生成配套太阳和局部灯。 |
| 投影预算 | 局部投影最多 4 盏，加太阳后适配多贴图材质的 16 个纹理单元预算。无顶灯时按天花板、窗户顺序取前 4 盏并全部投影。 |
| 有顶灯时 | 顶灯最多 3 盏产生投影，另按面积选最多 2 盏窗灯。剩余投影名额按窗大小分配。点光阴影图为 1024²，Android 为 512² 配 PCSS。 |
| 阴影偏移 | 优先使用深度偏移，法线偏移保持很小，避免墙面条纹和线管等薄部件自遮挡。 |

**识别房间表面。** 先按房间标签区分天花板与窗户，避免把吊顶格栅、灯具、窗帘、窗外景误计。没有标签时按节点名前缀。天花板高度优先来自自身网格，以排除悬挂物。回放保留层级，地板与墙体取其自身表面高度。

**外侧天光。** ShaderChunk 的 `lights_pars_begin` 与 `lights_fragment_end` 注入 `ROOM_EXTERIOR` 分支，按材质传入墙朝向、内侧平面、天花板及灯高度。

外侧表面用 `exteriorLight` 的均匀漫射天光，避免强直射使墙外过曝、柜顶全黑。

应用范围包括墙外面、门框、窗框、踢脚线与线管等贴墙物的外面，墙厚端面和洞口侧面，以及高于灯具的朝上表面和天花板以上部分。房间内面沿用物理光照，室内主要在洞口侧面可见差异。

## 静态遮蔽、调色与导入材质

- 默认 GTAO 补接触处和缝隙的暗部。拖动、转动镜头及部件开合时暂停。静止约 350 毫秒后以半分辨率（长边最多 960 像素）补算一次。静止时不持续请求帧。
- 玻璃、透明虚影、编辑指示及碰撞网格不参与遮蔽。增强图形功能或插件不可用时，对应效果停用，仍可使用编辑器。
- 调色范围为曝光 −2 至 +2 EV、白平衡 −1 至 +1、对比度 0.6–1.4、饱和度 0–1.6。滑条只触发一次全屏合成，可复用已有模型、阴影与 AO。
- 导入受光默认开启，保留贴图、补缺失法线并接收阴影。仅旧顶点色模型可切换到原显示，标记为 PBR 的 MV-SAM3D 烘焙结果始终保持原材质并受光。

## 几何索引与后台检查

`scene-entities.mjs` 维护实体分组和世界矩阵，`import-entity.mjs` 构建导入实体，`warehouse-row.mjs` 构建物品库行。

`scene-geometry.mjs` 管放置、碰撞、漫游索引及 Worker 生命周期，`collision-client.mjs` 管增量传输、索引代次及请求取消。

| 环节 | 保持的行为 |
| --- | --- |
| 建立索引 | `entity-geometry.mjs` 提供稳定的原始几何。`triangle-index.mjs` 用 Float64 保存三角形边界、法向和节点边界，Uint32 保存面编号与树结构。 |
| Worker 几何 | 直接保留传入的 Float64 顶点和 Uint32 面索引，构建和查询不再把整个房间展开为点／三角形数组。顶点身份与原面序保持不变，局部查询按需读取坐标。 |
| 安装与复用 | Worker 完成首次构建，主线程安装传回的紧凑数组，供同步碰撞及 `ray-queries.mjs` 复用。各端保有一份紧凑数组，无需跨域隔离或 SharedArrayBuffer。 |
| 射线 | 公共边同距命中依原遍历顺序选面。漫游按实时世界矩阵查询开门、抽屉及承载姿态。地板索引参与射线查询，不作为物品碰撞障碍。 |
| 增删物品 | 只传变更几何并复用原有 BVH、支撑采样与静态索引。需要建索引时暂缓编辑，镜头和渲染可用。纯删除可直接复用剩余索引。 |
| 异步与回退 | 过期回复不能安装索引或确认新布局，最新一代补齐缺项。Worker 创建、运行或消息处理失败后，回退到主线程构建与查询。 |
| 可见性 | 隐藏、透明及裁切分别按具体查询过滤。原始扫描可显示、重置、撤销和原地确认。编辑显示效果不改变碰撞几何。 |

**原有交叠。** 只对扫描中真正相交的一对连通部分保留原始穿入深度，加 5 毫米容差。深度依双方各自凸包面计算，不依赖拖动哪件。移开、抬起后原地放下、不加深的旋转均允许，加深则在越界处停止。其余部分走普通碰撞检查。

## 网址参数与调试工具

在 `editor/?room=<id>` 后用 `&` 添加下列参数。控制台的 `roomEditor.snapshot().lighting` 可查环境、阴影和 AO 状态。

| 参数 | 比较项目 |
| --- | --- |
| `time` | 可选 `balanced`、`morning`、`noon`（默认）、`afternoon`、`night`、`physical`。 |
| `indoor=off` | 本次打开时关闭室内灯，保留房间已存设置。 |
| `lighting=off`、`lighting=initial` | 完整原始光照或早期增强配方。 |
| `ao=off`、`ao=n8ao` | 关闭遮蔽或换用 N8AO。 |
| `env=off`、`shadows=original` | 关闭环境反射或沿用原始阴影参数。 |
| `materials=pbr`、`materials=original` | 对比旧顶点色模型的受光。原生 PBR 结果始终受光。 |
| `lightingLab=1` | 加载 `roomLightingLab`，用于固定布局保存／恢复、材质检查、镜头回放、编辑器阶段和 GPU 计时。 |

`lighting.time.luminaires` 给出发光面尺寸，`lights` 给出类型、位置、份额与强度，`windowReflection` 记录反射图尺寸和捕获次数。物理档中的 `physical.shadowCasters` 列出投影灯。

## 测试与性能采样

**单元与模型。** 网页单元测试命令见[网页指南](../../web/README.md#测试)。模型检查使用 Node 24、Python 3 和本地完整模型。CI 根据模型清单缓存 GLB。在仓库根目录运行以下检查。

```bash
python3 scripts/fetch_samples.py --verify
node web/scripts/check_room.mjs --scene-dir samples/room3
node web/scripts/check_room.mjs --scene-dir samples/office
node --max-old-space-size=5120 web/scripts/check_room.mjs --scene-dir samples/activity-classroom
for c in collision wall_mount seat_support gravity; do
  node "web/scripts/check_$c.mjs" --scene-dir samples/office
done
```

**浏览器检查。** 在一个终端启动本机网页，另一个终端从仓库根目录运行。以下命令把 Playwright 和含房间截图的报告放到仓库外。默认用 Playwright 的 Chromium，可传 `--browser "<浏览器路径>"`。

```bash
npm install --prefix /tmp/roomcanvas-lighting-tools playwright
npx --prefix /tmp/roomcanvas-lighting-tools playwright install chromium
PW=/tmp/roomcanvas-lighting-tools/node_modules/playwright
for c in lighting import_lighting lighting_stability time_lighting; do
  node "web/scripts/check_$c.mjs" --output "/tmp/roomcanvas-$c" --playwright "$PW"
done
node web/scripts/check_ground_grid.mjs --playwright "$PW"
node web/scripts/check_object_photos.mjs --playwright "$PW"
node web/scripts/check_replay_resources.mjs --playwright "$PW" --output /tmp/roomcanvas-replay.json
```

| 脚本（位于 `web/scripts/`） | 检查范围 |
| --- | --- |
| `check_lighting.mjs` | 固定镜头与布局，截整体／近景图并逐帧记录 CPU、GPU 耗时。支持 `--rooms`、`--variants`、`--frames`。加 `--asset-edits` 可在采样后导入并删除示例椅子。 |
| `check_import_lighting.mjs` | 用合成模型检查导入、摆放、受光与原显示切换。 |
| `check_lighting_stability.mjs` | 悬停／移出画布不重绘，近侧墙显示前后一致，移动后按需更新。 |
| `check_time_lighting.mjs` | 五种非物理预设、灯具定位与后备灯、衰减、角度、开关、房间设置、调色一次合成、窄屏和键盘。 |
| `check_ground_grid.mjs` | 108 组投影、距离、仰角、小幅旋转和合成管线的像素对比。地面遮住内部网格，外部网格仍清晰。 |
| `check_object_photos.mjs` | 模拟接口验证合成 HEIC、误改后缀、预览尺寸及颜色、损坏提示和实际上传编码。 |
| `check_replay_resources.mjs` | 24 次 draft 替换的真实 WebGL 资源稳定性，覆盖成形中替换、回拖、1／2／8 倍速、灯光切换及迟到的 load、warm、prefetch。 |

**对照射线与 Worker。** 给 `check_lighting.mjs` 同时加 `--asset-edits --editor-queries` 可验证物品增删、开合、承载、漫游及真实 Worker。

开启调试后可在控制台执行 `await roomLightingLab.queryBenchmark()`。

基准用同一批射线做 5 轮 Three.js 原生与 BVH 对照，临时打开全部部件复核并恢复。报告包含耗时、差异数及三角形访问计数。仅在开启调试且调用基准时才加载射线基准模块。

**读取性能报告。** 每个档位的 `report.json` 记录最近 128 个 `editorStages` 样本，包括操作名、阶段、页面内起点、耗时（毫秒）与可编辑物品数。旧版页面无此接口时为 `null`。

| 阶段 | 计时边界 |
| --- | --- |
| `modelReadAndParse`、`placement`、`collisionGeometry` | 模型读取与解析总耗时、支撑构建、碰撞几何提取。 |
| `collisionWorkerSubmit`、`collisionIndexInstall` | 主线程准备或复用 Worker 到打包提交结束。收到紧凑索引后安装的耗时单列。 |
| `collisionMainBuild` | 正常路径连接已有索引并准备射线，`roomLightingLab.geometryStatus().collision.builtMeshes` 应为 0。Worker 失败时此处才实际构建。 |
| `thumbnails`、`rebuild`、`floorSearch` | 缩略图、资产增删总耗时（含等待 Worker）、导入后落点搜索。 |

启用 `--asset-edits` 时，显示与碰撞使用仓库中同一把椅子模型，可用报告的 `conditions.assetEditModelSha256` 核对输入。解释耗时前可先看[旧指南的体验耗时记录](../history/WEB_EDITOR_VALIDATION.md)。

**Worker 保留几何对照（2026-11-24，#108）。** 基线为 `47cf0279d389a9db6abec8962beddeeefab0501a`，候选让 Worker 直接使用传入的紧凑几何，并延后边界查询中的坐标读取。测试使用当前 `activity-classroom` 模型（SHA-256 `60fa27d2cce5fb3acfa675f9e39509b844f53551ad4712b6c1e239d6468ae5e6`），共 2,433,884 个三角形，含 32 个仅用于射线的地板面。

同一台 Apple M5、16 GB 机器，Node 24.14.1 的真实 Worker 与 Chromium 分别做三轮基线／候选对照，以下为中位数。浏览器每次启动独立进程，窗口 1440×1000、DPR 1，关闭增强光照、AO 和环境，使用 SwiftShader；这些结果不代表手机或真实 GPU 性能。内存为强制 GC 后的 JS 堆和缓冲区保留量，MB 按 1,000,000 字节计算，不是进程 RSS、加载峰值或显存。

| 指标 | 基线 | 紧凑几何 |
| --- | ---: | ---: |
| Node Worker 构建处理（含原有解包和索引回复准备） | 1348.9 ms | 1131.8 ms |
| Node Worker 构建后保留量 | 703.55 MB | 376.23 MB |
| 浏览器 Worker 构建后保留量 | 520.48 MB | 371.45 MB |
| 浏览器页面 + Worker 构建后保留量 | 1893.26 MB | 1744.23 MB |
| 浏览器提交构建到收到回复 | 1659.0 ms | 1359.1 ms |
| 浏览器最重可编辑物体 `CardboardBox0` 原地确认 | 251.0 ms | 237.1 ms |
| 浏览器 `Chair0` 沿 X 移动 20 m 的完整检查 | 772.4 ms | 727.2 ms |

Node 24 的 `arrayBuffers` 不包含收到的转移缓冲区，因此 Node 内存数据额外计入候选仍持有的 110.42 MB 输入，不能只比较 `heapUsed`。浏览器使用主线程和 Worker 各自的 CDP `usedSize + backingStorageSize`；六次查询后仍保留约 7.9% 的合计节省。两种运行环境的 Worker 内存降幅不同，应分别解读。

查询按固定顺序执行 `Chair0` 的 X/Z/Y 各 5 cm、旋转 0.5°、X 方向 20 m，再确认 `CardboardBox0` 原姿态；计时覆盖 Worker 的接触和连续移动检查，不含主线程准备。六类查询的全部输出与基线一致，另有 104 项真实布局对照通过。Node 中纸箱查询为 260.1→243.6 ms，长距离检查为 787.1→791.6 ms；浏览器普通椅子平移／抬高相差约 0.1–2.9 ms，没有发现首版那样的明显查询退化。

这是分阶段优化：主线程仍保留原始几何和转换后的点数组，首次打包仍在主线程执行，双方也各自保有一份紧凑索引；复杂连续移动仍需数百毫秒。后续可分别测量主线程几何重复、打包高峰和复杂查询热点。进一步调整存储或遍历时，仍须保持 Float64、原面序、公共边命中以及扫描交叠的 5 mm 边界规则。

**回放资源释放。** 单个 `RoomView` 复用点云与线框 shader 池，纹理材质裁切副本随模型释放。替换 draft 时先取消异步上传、移除成形与墙体淡出引用，再等待已开始的 shader 编译完成，最后释放模型。过期 GLTF 加载结果不能重新进入场景。

销毁视图要 `await view.dispose()`，同时清理观察器、动画帧、环境贴图与 shader 池。脚本做 24 次替换，去掉前 4 次后，几何、纹理、程序等计数的最大值与最小值最多相差 1。[资源验收脚本](../../web/scripts/check_replay_resources.mjs)
