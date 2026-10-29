# 开发记录

这里汇集 RoomCanvas 开发过程中的计划、调研、验收和代码整合记录，按主题归档，内容保持记录当时的状态，只供追溯。现行用法和接口以 [README](../README.md) 及各模块文档为准；当前进行中的工作见 [交接](HANDOFF.md)。

| 记录 | 原位置 |
| --- | --- |
| [代码审查与重构计划（2026-10-27）](#代码审查与重构计划2026-10-27) | `docs/REFACTOR_PLAN.md` |
| [网页光照：实现说明与调研（2026-10-19）](#网页光照实现说明与调研2026-10-19) | `web/README.md` 第 28–464 行 |
| [手势模块开发日志（2026-10-09 起）](#手势模块开发日志2026-10-09-起) | `gesture/LOG.md` |
| [手势模块工程计划（2026-10-09）](#手势模块工程计划2026-10-09) | `gesture/docs/plan.md` |
| [手势模块本机验收记录（2026-10-09）](#手势模块本机验收记录2026-10-09) | `gesture/docs/acceptance.md` |
| [手势接入 RoomCanvas 的双手操作更新（2026-10-23）](#手势接入-roomcanvas-的双手操作更新2026-10-23) | `gesture/docs/gesture-updates.md` |
| [手势 Mac mini 远程识别测试（2026-10-10）](#手势-mac-mini-远程识别测试2026-10-10) | `gesture/docs/macmini-test.md` |
| [ViewForge 与手势代码的历史整理（2026-10-17）](#viewforge-与手势代码的历史整理2026-10-17) | `object-reconstruction/docs/HISTORY_INTEGRATION.md` |
| [ViewForge 原运行说明与部署验收（2026-09 – 10）](#viewforge-原运行说明与部署验收2026-09--10) | `object-reconstruction/docs/VIEWFORGE_RUNTIME.md` |

## 代码审查与重构计划（2026-10-27）

> 原 `docs/REFACTOR_PLAN.md`。

用户 2026-10-27 要求审查整个仓库（“有点屎山，可能要重构”）。审查基于 main `038f568`，分房间重建、物体重建、网页 / 手势 / 安卓 / 整体布局三块，只读，没有改代码。下面的 bug 都对照代码核实过；标 * 的是按执行顺序推断。

**进度（2026-10-27 晚）**：第 1 批 12 个 bug 全部修好，各开 PR 等合并（见表最后一列）。#6 修前修后都在浏览器里对比过（旧代码可复现）；#7、#8、#10 只有单测，没有真人摄像头或拖动复现。第 3 批的“`?v=` 发布时统一盖版本号”（#43）和第 4 批的“统一的换材质模块”（#45）为修 bug 提前做了。

### 总体判断

- 最大、最难读的几块大多是照搬的上游代码，不该改：`object-reconstruction/` 有 155 个文件和上游 MV-SAM3D `abb04b5` 一字不差（含 4090 行的 `run_inference_weighted.py`），只有 `.gitignore`、`README.md`、`requirements.inference.txt`、`scripts/run_da3.py`（3 行）改过。
- 真正乱的地方：
  - **房间重建**：127 个环境变量散在 66 个文件里直接读，`settings.py` 只在约 11 处用；找 Blender 的代码 8 份；`articulate/run.py` 和 `small_objects/run.py` 基本复制粘贴；约 800 行死代码；`mujoco_scene.py`（1814 行，`export()` 945 行）、`build_room.py`（1334 行）、`author.py`（约 400 行提示词写在代码里）太大；可动部件和小物件两步由 `server/run_room.py` 另外串起来，不在 `PipelineRunner` 的续跑状态里。
  - **物体重建**（我们自己的 `scripts/` 约 2400 行）：写 JSON、GPU 锁、名字校验各有 3–4 份且规则不一；三个手写 ASGI 中间件重复；BiRefNet 参数写了三处；`scripts/` 平铺，接口、任务、工具、上游文件混在一起。
  - **网页编辑器**：`web/editor/scene-editor.js` 2343 行，约 60 个模块级变量；5 套代码各自给同一批模型换材质（`materialRestore`、`ghostMaterials`、`editingWallMaterials`、`wallMaterialRestore`、`wall-visibility.mjs` 的 `userData.solid`），会互相覆盖；各处手写的 `?v=` 版本号不一致，同一模块被加载两三份。
  - **整体**：3 个漫游查看器（`room_ops/walk/app.js`、`web/editor/walk.mjs`、安卓），Three.js 3 个版本（0.168 / r180 / 0.186.1）；手势协议在 `gesture/src/integration/protocol.ts` 和 `web/editor/gesture-bridge.mjs` 各写一份；安卓 `MainActivity.kt`（871 行）、`ArGestureHandler.kt` 没有入口；`object-reconstruction/legacy/`（5 MB）、空的 `object-reconstruction/viewer/`；`object-reconstruction/data/example` 152 MB 示例图和视频在 git 里，`.git` 619 MB。
  - **CI**：没有安卓；物体测试是手写列表，`test_preview_glb.py` 没跑；`gesture/backend/test_server.py`、浏览器光照检查没跑；没检查 `web/vendor/gesture` 是否和 `gesture/src` 一致。
  - **文档**：`room-reconstruction/ARCHITECTURE.md` 说 publish 在 `realism_authoring/publish`（实际 `pipeline/room_qc/publish`）、默认 provider 是 claude（实际 codex），漏了 simulate、articulate、small_objects、live。

### 确认的 bug

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

### 重构计划（按收益和风险排，每批一个或几个小 PR）

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

### ZCode 找 bug（未完成）

用户想再用本机 ZCode 找一遍。命令行版（`/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`）用不了账号额度（报 “Select a model before sending a message”，账号额度只有桌面版能用），改为用户在桌面版（模型选 GLM-5.3）里对 main 的一份副本跑，提示词要求只读、只报读过上下文确认的真实 bug（文件:行号、问题、触发场景，最多 20 条，跳过上游和 vendor 目录）。跑完后从 `~/.zcode` 的本地记录读结果，逐条核实后补进上表。

## 网页光照：实现说明与调研（2026-10-19）

> 原 `web/README.md`。

### 通用光影增强

“普通光照”的基础配置保留原有半球光和两盏平行光，不按房间名称选灯：主光位于房间中心偏移 `(-3.5, 地面高度 + 8, +4)`，照向地面中心，第二盏平行光位于 `(-5, 4, -4)`。工具栏“光照”可选择此配置或早晨／中午／下午／夜间，并控制中央顶灯的开关与照射角度。正常打开页面默认使用下方的“中午”时段，窗光主导、顶灯微亮。

| 档位 | 半球光 | 主光 | 补光 | ACES 曝光 | 环境强度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 基础 `balanced`（普通光照） | 1.1 | 3.0 | 0.65 | 1.1 | 0.35 |
| 第一版增强 `lighting=initial` | 2.5 | 2.4 | 1.4 | 1.15 | 0.18 |
| 完整原始 `lighting=off` | 2.5 | 2.4 | 1.4 | 1.15 | 0 |

基础 balanced 档减少填充光、增加环境贡献，使深色和光滑表面更容易显示层次；它是统一的展示校准，不代表从照片恢复了真实照明。下方的时段预设会覆盖表中的光强／环境强度；表中数值通过 `time=balanced&indoor=off` 复现，表格不含独立控制的顶灯。

基础日光档按同一规则启用三项增强；时段窗光及独立室内灯具另见下方“时段与调色实验”：

1. **环境光与反射**：使用 Three.js 自带的中性 RoomEnvironment，初始化时生成一次 128 像素立方体面的 PMREM 贴图，补充 PBR 材质的环境受光与反射。没有外部 HDR 下载，也不随相机或物体变化重新生成；它代表通用环境，不是扫描房间的真实反射。
2. **静态 GTAO 环境遮蔽**：补充家具接触处和缝隙的暗部，操作期间暂停，停止后低分辨率补算。
3. **现有阴影校准**：维持 2048² PCFSoft 和原有光源方向，以完整房间包围盒在主光坐标中自动收紧阴影范围及近远裁面，按阴影像素的世界尺寸设置偏移，减少分辨率浪费和接触处偏离。规则不含房间名称，过大房间跨过固定主光平面时沿用原配置；阴影贴图仍按原有变化事件更新。没有追加 PCSS、接触阴影层或渐进累积渲染。

已增加固定画面／布局重放与整帧 CPU/GPU 计时，两个房间完成首轮同条件对照。GTAO 保持默认，`ao=n8ao` 可比较固定版本的 N8AO；两者都只在静止后做有限补算，不开持续累积。两份房间原有材质均为受光的 Standard / Physical。更多工具中的“**导入物体随光照变化（实验）**”为 ViewForge 导入显示网格启用可回退的 PBR 材质：保留已有 PBR，转换 unlit 时保留贴图／顶点色，补齐缺失法线并接收阴影；默认关闭，避免拍摄颜色再次受光导致变暗。碰撞代理不变。细节见 [光影调研](#1-当前优先级已实现范围与下一步)。

静态 AO 的调度与开销：

- 拖动物体、鼠标／手势调整视角、长按微调、家具掉落、门柜动画期间暂停 AO；停止约 **350 毫秒**后补算一次，完全静止后不再请求帧。鼠标仅悬停、跨过家具或离开画布时只更新光标，不重绘、不清除已完成的 AO。
- 交互帧、静态 AO 帧及 `ao=off` 共用线性颜色空间的透明混合、同一屏幕采样数的 MSAA 和一次 ACES / sRGB 输出。避免半透明近墙在普通帧和静态帧之间忽深忽浅；交互时额外保留一次全屏合成，不做 AO 深度／法线、遮蔽或降噪计算。AO 缓冲仍等静止后才分配。`lighting=off` 保留完整原始路径。
- AO 按绘图缓冲区的半宽、半高计算，长边最多 960 像素；AO 和降噪各使用 8 个采样参数，混合强度 0.35。作用半径按房间水平短边的 2.5% 取值，限制在 0.08–0.20 米，沿用所有房间的米制尺寸。
- 玻璃、透明虚影、编辑指示和只用于碰撞的网格不参与 AO 遮挡。切到后台暂停补算。截图保留当前静态效果，仓库卡片缩略图继续使用原渲染。
- 使用与引擎一致的官方 r180 插件，资源随仓库离线提供，在编辑器能正常工作后按环境、AO 的顺序加载。AO 需要浮点颜色缓冲支持；插件缺失、不支持或运行异常时停用相应增强，继续使用已有渲染。重新发布已有预览时，`publish.py` 也会更新插件文件。

本机启动仍是 `python3 web/scripts/serve.py`，无需启动额外后端。对比入口：

- 默认：[卧室](http://127.0.0.1:7880/web/editor/?room=room3)、[办公室](http://127.0.0.1:7880/web/editor/?room=office)。
- 完整原始效果：加 `&lighting=off`，例如 [卧室原始光照](http://127.0.0.1:7880/web/editor/?room=room3&lighting=off)。任意 `?scene=…` 房间同样适用。
- 分步对比：`&ao=off&shadows=original` 仅加环境；`&shadows=original` 加环境与 AO；默认启用全部三项。`&env=off` 可单独关闭环境。

分步开关使用当前校准档的灯光；要只比较某个算法，应在两边明确使用相同 `lighting=balanced` 或 `lighting=initial`。`materials=pbr` 可在页面打开时预选导入物体受光实验。

#### 时段与调色实验

**实验功能范围：时段光照预设、顶灯照射角度，以及曝光／白平衡／对比度／饱和度调色。上述功能仍在验证和调整，当前默认参数不视为最终方案；界面分别标注“实验”。**

工具栏“**光照**”提供时段选择、中央顶灯的**照射角度滑条**及“**开灯／关灯**”按钮。时段只有普通光照、早晨、中午、下午、夜间五项，室内照明统一由一盏中央顶灯承担。“**调色实验**”仅提供曝光、白平衡、对比度、饱和度四个独立滑条与重置。

默认“中午”和中性调色，刷新后恢复（URL 的 `time` 可指定时段）。顶灯角度和电源状态独立于时段，按房间保存在当前浏览器中；切换时段保留角度和开关，关灯不改变窗外光照。切换房间读取各自的设置，不写入模型文件或布局存档。已有室内灯设置沿用原电源状态，缺少角度时使用 160°。切换时段也保留四项调色偏移，“重置四项调色”仅清除偏移。

| 时段 | 照明规则 |
| --- | --- |
| 普通光照 | `time=balanced`，中性的展示照明，沿用原有光源位置；中央顶灯也可独立开启 |
| 早晨 | 较低角度、略暖太阳光，窗边天光较弱，顶灯微亮 |
| 中午（默认） | 较高角度、较中性的太阳光，窗边天光最强，顶灯微亮 |
| 下午 | 改变太阳方位、降低高度并增加暖色，窗边天光减弱，顶灯微亮 |
| 夜间 | 关闭两盏日间平行光，将半球光降至 0.07、环境强度降至 0.018；中央顶灯为主照明，也可关灯 |

日间方位参考模型清单里最大的窗户所在墙面；没有窗户信息时使用房间坐标轴。没有地理朝向、地点、日期的输入，因而这些是通用的时段氛围预设，不是真实钟点的太阳模拟。入口支持 `&time=morning`、`noon`、`afternoon`、`night`，例如 [卧室夜间](http://127.0.0.1:7880/web/editor/?room=room3&time=night)。

顶灯按原始房间的世界坐标轴对齐包围盒定位：X／Z 为 `(min + max) / 2`，高度取包围盒顶部与房间天花板高度中较低者，再向下留出小段间隙。光线垂直朝向地面中心；不读取现有灯具位置、不按房间名称适配，也不随家具移动改变位置。采用暖色 SpotLight，距离平方衰减 `decay=2`，带一个小型发光标记。普通光照及白天保持夜间顶灯光强的 **7%**，只是局部补光；这不是室内总照度的百分比。早晨／中午／下午另有太阳直射和主要窗户内侧的宽角天光近似，后者在窗边较强、深入室内后衰减，随时段改变强度和冷暖。这三个时段关闭原来的全局平行补光，将半球光／IBL 降低，只保留少量无法真实计算的间接光近似。

顶灯照射角度默认 **160°**，滑条范围 **60°–170°**，步长 1°，表示完整光锥角度；引擎使用一半角度，例如 160° 对应 `SpotLight.angle = 80°`。阴影相机同步使用完整角度，并按角度与阴影分辨率调整深度／法线偏移，控制宽角墙面自阴影条纹。保留距 180° 的余量，避免透视投影奇异；亮度按距离衰减，扩大角度扩展覆盖范围，不用全局补光代替顶灯。

白天有太阳 2048² 和窗边天光 1024² 两张 PCFSoft 阴影图，室内微亮顶灯不追加阴影图；夜间关闭这两种窗外光，仅在开启顶灯时使用一张 2048² 顶灯阴影图。开灯时调整角度会重绘场景，夜间同步更新顶灯阴影，白天复用窗外阴影；AO 在停止调整 350 ms 后补算。关灯时调整角度只保存参数，不重绘场景。静止和鼠标悬停不持续计算。窗玻璃／窗外景自发光按早晨／中午／下午分别缩放为 0.65／0.95／0.5，夜间降至 0.025，普通光照恢复为 1；显示器等其他自发光不改。材料副本与临时灯光独立管理，不改模型文件。

半透明近墙只是观察辅助，不是光线入口。时段预设中，半透明实墙及高家具继续挡光，但不在淡化表面上接收阴影；窗玻璃放行直射光。隐藏的天花板用共享几何的遮光副本挡住屋顶日照，副本不写入画面颜色／深度，不参与选择、碰撞或 AO。窗边天光是低成本局部灯近似，不是窗户积分、玻璃透射求解或 GI；少量 IBL 仍不计算室内遮蔽。普通光照沿用原有展示照明规则。`&indoor=off` 可在打开页面时关闭室内灯，供固定算法对照使用，不覆盖房间已保存的设置。

| 实验滑条 | 范围／中性值 | 作用 |
| --- | --- | --- |
| 曝光 | −2～+2 EV／0 | 在预设曝光基础上乘以 `2^EV`，调整画面明暗 |
| 白平衡（冷暖） | −1～+1／0 | 负值偏冷、正值偏暖；保持中性亮度的 RGB 冷暖校正，不是标定后的 Kelvin 色温 |
| 对比度 | 0.60～1.40／1 | 调整输出层次 |
| 饱和度 | 0～1.60／1 | 0 为灰度，1 为原色，较高值增强颜色 |

曝光和白平衡在线性场景颜色上应用，再做原有 ACES；饱和度调节色调映射后的线性颜色，对比度作用于显示颜色。所有步骤合入交互／静态共用的 `lighting-composite.mjs`，仅作用于三维物体画面，不染色网页按钮、仓库卡片或外部预览。拖滑条复用最近的 beauty／AO 缓冲，每次只呈现一个全屏绘制，不重算模型、阴影或 AO；切换光照预设才标记场景／阴影变化，AO 仍在停止 350 ms 后补算，静止和悬停无渲染循环。

`lighting=off` 保留完整原始对照，实验控件停用；图形功能或插件不可用时调色停用，编辑器仍可继续使用。调色不能移除照片纹理里已有的光影，也不能代替真实间接光／反照率恢复。没有新增烘焙 GI 或持续太阳动画。

控制台的 `roomEditor.snapshot().lighting` 可查看环境、阴影参数、AO 状态、补算次数与分辨率。AO 是屏幕空间近似，无法计算屏幕外遮挡、真实反弹光或修正重建贴图里已有的光影；静态补算仍有一次法线／深度渲染和额外显存成本，不能等同于零开销。新房间直接沿用此档，不需要单独配置。选型与后续候选见 [光影调研](#光影调研)。

固定基线验收（仅开发时需要 Playwright，正常启动不需要 Node 依赖）：

```bash
# 另一个终端先运行 python3 web/scripts/serve.py。
# 临时安装浏览器验收依赖；不改仓库的依赖配置。
npm install --prefix /tmp/roomcanvas-lighting-tools playwright
node web/scripts/check_lighting.mjs --output /tmp/roomcanvas-lighting-results \
  --playwright /tmp/roomcanvas-lighting-tools/node_modules/playwright \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node web/scripts/check_import_lighting.mjs --output /tmp/roomcanvas-import-results \
  --playwright /tmp/roomcanvas-lighting-tools/node_modules/playwright \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node web/scripts/check_lighting_stability.mjs --output /tmp/roomcanvas-lighting-stability \
  --playwright /tmp/roomcanvas-lighting-tools/node_modules/playwright \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
node web/scripts/check_time_lighting.mjs --output /tmp/roomcanvas-time-lighting \
  --playwright /tmp/roomcanvas-lighting-tools/node_modules/playwright \
  --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

其他平台可换 `--browser` 路径，或安装 Playwright 的 Chromium 后省略该参数。基线脚本保存模型 SHA256、相机／布局、整体与近景截图、逐帧数据及 CPU/GPU p50/p95，支持 `--rooms office`、`--variants original,balanced`、`--frames 90`。GPU 计时扩展不可用时明确记为不可用；CPU 提交时间不冒充 GPU 时间。结果必须放在仓库外，含私人房间截图，不提交。导入验收使用合成顶点色 GLB 走真实导入／放置流程，无需服务器已有物体。

稳定性回归另检查两个房间的 GTAO、N8AO 和关闭 AO：反复跨家具悬停／移出画布后零重绘、零 AO 更新且截图不变；实际移动相机／家具后更新，拖动期间暂停 AO。合成 16% 不透明度墙用于隔离透明混合与接触 AO 的差异，并检查 MSAA、异常恢复与移动／静止的像素一致性。

时段验收使用同一平面测试夜间近／远位置的真实像素亮度，并对比 60°／100°／160°／170° 的覆盖范围；合成房间单测覆盖平移、狭长／大尺寸及现有灯具缺失或偏心的定位。浏览器检查五个预设、包围盒中央定位、日／夜投影灯数量、所有时段下角度调整和开关、关灯不改变窗外光照、按房间保存及隔离、光照／调色两个入口、独立滑条、重置恢复、相机／布局不变、调色只有一次全屏合成及零 AO 更新；另检查反复切换不重复创建灯、空闲零帧、窄屏与键盘可操作、图形插件失败回退和原始对照控件停用。旧的光影算法基线脚本固定 `time=balanced&indoor=off`，避免把新时段与室内顶灯混入算法对照。

仅在 URL 加 `lightingLab=1` 时启用 `roomLightingLab`，提供固定状态保存／恢复、材质审查、有限镜头回放和异步 GPU 计时；普通用户页面不开放这些测试操作。`metrics()` 分别报告交互、静态 AO 和截图，整帧跨 pass 汇总绘制调用，静止时不会为了统计 FPS 而持续渲染。

如果更新前已开着本机 `serve.py`，重启一次服务以采用较大的静态请求队列；旧版 Python 的默认小队列在浏览器并行加载模块时可能重置连接。

#### 光影调研

原 `docs/LIGHTING_RESEARCH.md`（lyk，2026-10-19）：RoomCanvas 光影改进调研与接入任务。

调研与实现日期：2026-10-19。基线：`main@7b4377b`。当前分支已完成可重放画面、整帧 CPU/GPU 计时、通用光源校准、可回退导入 PBR 实验以及 GTAO / N8AO 的首轮对照，操作说明见 [web/README.md](#通用光影增强)。下面区分已测结果与未验收边界；烘焙 GI 不在当前范围。

##### 1. 当前优先级、已实现范围与下一步

目标是**通用场景的光影增强，优先低运行开销**。保留半球光与两盏平行光的类型和位置，不按房间名称或单个模型写视觉补丁；新场景沿用共同规则。在两个房间固定画面对照后，默认采用 `balanced`：半球光 1.1、主光 3.0、补光 0.65、IBL 0.35、ACES 曝光 1.1。`lighting=off` 保留完整旧效果，`lighting=initial` 保留第一版增强参数。此校准改善展示层次，不代表恢复了真实房间的光照。

| 优先级 | 工作 | 理由 | 当前进度与缺口 |
| --- | --- | --- | --- |
| P0 | 建立固定画面与性能基线 | 确定改进是否真实有效 | 已保存两房间、五档位的模型 SHA256、相机／布局、整体／近景截图和完整渲染帧 CPU/GPU 数据；真人手势及更多设备仍待验收 |
| P1 | 光源校准 + PMREM / IBL | 低成本，改善整体照明 | 已完成统一 balanced 档与原始／第一版对照；光源类型与位置不变，PMREM 仍只生成一次 |
| P1 | 导入物体的 PBR 材质适配实验 | 解决光照系统对部分物体不生效的问题 | 已有界面开关、原显示回退、已有 PBR 保留、缺失法线补算、受光阴影；合成物体走真实导入／放置路径并验证像素响应，真实目录为空，尚无真实新增物体的视觉验收 |
| P2 | GTAO 与 N8AO 对比 | 强化物体接触与空间层次 | 固定 N8AO 1.10.2，与 GTAO 在共同低分辨率／半径／合成流程下完成比较；保持 GTAO 默认，N8AO 供显式对照 |
| P2 | 原有实时阴影优化 | 改善动态家具的投影效果 | 已收紧阴影范围与偏移，并做原阴影近景对照及移动／放置更新检查；用户截图中的细小黑点未在固定镜头稳定重现，不宣称已消除所有伪影 |

**已实现的具体内容：**

- `lighting-profiles.mjs` / `environment-lighting.mjs`：统一 original / initial / balanced 档；RoomEnvironment 初始化一次生成 128 面尺寸的 PMREM。没有识别真实窗光，也不是房间局部反射或 GI。
- `static-lighting.mjs` / `settled-render.mjs`：共同低分辨率的 GTAO / N8AO，长边上限 960；混合强度 0.35，采样档位 8。停止约 350 毫秒后补算一次，移动／开合期间暂停，静止后不继续请求帧；透明预览和碰撞代理不参与 AO。N8AO 不启用时域累积与额外透明 pass，并补充其资源释放。
- `render-metrics.mjs`、显式 `lightingLab=1`、两个 `check_*lighting.mjs` 脚本：固定状态重放、材质审查、整帧跨 pass 统计、异步 GPU query、原始／校准／无 AO／N8AO 对照。正常页面不开放测试变更操作，不为了测 FPS 常开渲染。
- `import-materials.mjs`：导入受光实验默认关闭；保留合格 PBR 参数／贴图，unlit 转换保留颜色，缺失法线在独立几何上补算，支持受光阴影并能切回原显示，不修改碰撞代理。
- `lighting-settings.mjs`：以完整房间范围自动收紧原有主光的阴影相机，按像素世界尺寸调整偏移；保持 2048² PCFSoft，没有增加新的阴影算法。
- 接入与运行保障：整体／分项关闭对比、当前效果截图、可选插件失败回退、旧预览发布时更新插件、修复本机服务的并行模块加载队列。

**首轮效果差别较小的原因与本轮变化：**第一版保留 2.5 / 2.4 / 1.4 的旧光强、曝光 1.15，IBL 仅为 0.18，AO 主要覆盖小接触区域。本轮固定画面对照后减少填充、增加环境贡献，深色钢琴和窗帘的层次更易辨认；材质受光与可完全重新打光仍是两件事，见 2.2。床面黑点和墙柜条纹已列为近景检查项；对照中没有稳定复现用户截图的黑点，不能直接归因或宣称完全修好。

本轮不继续叠加算法。下一步是用户视角／真人手势验收、真实导入物体和更多场景的视觉确认。PCSS／额外接触阴影、烘焙 GI、路径追踪、高成本 GI 和照片反推光照仍为候选资料，当前不实施。GPU 重建后端、SSH、手势识别和碰撞算法不变。

下文保留了 29 个候选能力或路线，包含同一开源项目的不同组件、离线工具、研究实现和资源。它们不是 29 个可同时安装的插件。部分条件不符的方案仍列出，说明可参与的环节及适用边界。

##### 2. 调研基线的代码与资产情况

###### 2.1 渲染基础

以下来自本仓库代码检查，入口为 [scene-editor.js](../web/editor/scene-editor.js)、[编辑器 import map](../web/editor/index.html)、[发布脚本](../web/scripts/publish.py)。

| 项目 | 现状 | 对选型的影响 |
| --- | --- | --- |
| 引擎 | 本地 vendor 的 Three.js r180，原生 ES modules，WebGLRenderer | 不必迁 React/R3F；Three.js 官网最新示例不一定兼容 r180 |
| 相机 | OrthographicCamera | 必须核验正交投影，不能只看透视相机 demo |
| 帧调度 | `requestRender()` 按需请求帧 | 时域累积效果需要有限的补帧与明确的失效机制，不能默认永久循环 |
| 阴影 | PCFSoftShadowMap，2048² 主光阴影，手动标记更新 | 已有阴影；优化要先判断遮挡、偏移和更新时机，而不是重复加一层 |
| 灯光 | HemisphereLight 强度 2.5，加两盏平行光 2.4 / 1.4 | 光照相对通用，没有按窗户方向和房间配置；是否过亮要通过固定视角对比确认 |
| 显示 | sRGB 输出，ACESFilmic，曝光 1.15，DPR 上限 1.5 | 后处理接入后要保证只做一次色调映射和输出转换 |
| 环境光照 | 当前没有设置 `scene.environment` | 可先尝试低分辨率 IBL，改善金属、光滑表面和整体受光一致性 |
| 交互材质 | 选择、虚影、透明墙会临时替换材质 | 深度/法线 pass 与材质修改需要兼容；操作指示不能被 AO 弄脏 |
| 墙体显示 | 相机变化会隐藏部分墙体、固定设施和家具 | 被隐藏的墙也可能失去投影/遮挡作用；剖视展示和物理闭合房间应分别定义 |
| 图片输出 | 主场景 `captureFrame()` 直接调用 renderer；家具缩略图另用 renderer | 接后处理后要统一截图入口；缩略图的环境光照也需要明确是否沿用主场景 |

一个可以直接确认的问题：当前代码设置 `sun.shadow.radius = 4`，但 **r180 的 PCFSoftShadowMap 不使用这个参数**。继续增加它不会得到期望的柔化效果；应比较阴影投影范围、贴图密度或其他过滤方式。[r180 LightShadow 源码](https://github.com/mrdoob/three.js/blob/r180/src/lights/LightShadow.js)

RectAreaLight 可帮助表现窗户或灯板，但 r180 原生实现不提供阴影，不能单独解决窗户投影。[r180 RectAreaLight](https://github.com/mrdoob/three.js/blob/r180/src/lights/RectAreaLight.js)

###### 2.2 资产检查

重新解析两个示例 GLB 的材质定义、网格属性与贴图引用，并核对本地 r180 GLTFLoader 和导入代码；没有导出或上传私人贴图。

| 资产 | 材质定义数 | unlit 材质 | BaseColor 贴图材质 | 金属／粗糙度贴图材质 | 法线贴图材质 | 缺少几何法线的 primitive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| room3 | 50 | 0 | 25 | 18 | 8 | 98 / 185 |
| office | 84 | 0 | 58 | 49 | 44 | 0 / 1239 |

两个文件均使用 glTF 的 PBR 材质路径，没有 `KHR_materials_unlit`。r180 GLTFLoader 对普通材质创建 MeshStandardMaterial，对清漆、透射、特定高光等扩展创建 MeshPhysicalMaterial。因此，**房间壳体和原有家具可以响应直接光与 IBL，并不需要全量换成 PBR 材质**。材质定义数不是渲染时材质实例数或绘制调用数；Loader 可为网格属性生成派生材质。

本机 Chrome 实际加载核对如下（原始布局、未选择物体、静态增强完成后；只读临时诊断，不修改资产）：

| 场景 | 渲染材质实例 | Standard / Physical 实例 | 对应网格数 | 加载后缺法线网格 | 可接收阴影网格 |
| --- | ---: | ---: | ---: | ---: | ---: |
| room3 | 58 | 54 / 4 | 185 | 0 | 185 |
| office | 84 | 74 / 10 | 1239 | 0 | 1239 |

运行时两场景均没有房间显示网格使用 Basic 材质；也确认了 room3 的法线补算已执行。此结论只适用于当前两份房间资产，不意味着今后导入的任何 GLB 都能未经审查重新打光。

兼容性与质量还应分别检查：

- room3 的 98 个 primitive 缺少几何法线，现有加载代码会补算法线。这使其可受光，但不保证重建表面平滑或高光连续；几何法线与法线贴图不是同一项数据。
- 白墙、布料、木地板多为非金属或高粗糙度表面，环境的可见变化与金属、钢琴漆面不同。room3 里钢琴黑漆的底色很暗、粗糙度约 0.075，并有清漆扩展；整块显黑不能直接判定为 unlit，需要固定近景观察反射与光源响应。
- room3 有 2 个带非零 emissive 的材质，office 有 4 个；自发光部分不随直接光同步变化，玻璃也应单独检查，不能按普通不透明墙面验收。
- BaseColor 贴图或重建顶点色可能包含拍摄时的阴影／高光；JSON 属性不能证明它们是纯反照率。PBR 类型正确不等于能完全重新打光。
- 两个房间均无独立 Occlusion 贴图。room3 无 TEXCOORD_1，office 有 21 / 1239 个 primitive 带 TEXCOORD_1；不影响当前直接光与 IBL，但不能据此认定可直接烘焙 lightmap。

| 材质路径 | 直接光／暖光 | 当前 PBR IBL | 普通受光阴影 | 当前处理 |
| --- | --- | --- | --- | --- |
| 房间与原有家具的 Standard / Physical | 支持 | 支持 | 不透明表面可接收 | 保留，校准光照后再评价具体参数 |
| ViewForge 导入的原显示模式 | 不响应 | 不参与当前受光路径 | 可投影，表面不显示普通受光阴影 | 保留为默认与回退 |
| ViewForge 导入的受光实验 | 支持 | 支持 | 可投影与接收 | 保留已有 PBR 或转换 unlit，检查明暗是否重复 |
| 移动过程的彩色虚影 | 故意不响应 | 不参与 | 不作为真实物体评估 | 保持当前交互表现 |
| 仅用于碰撞的 preview 网格 | 不显示 | 不参与 | 不参与 | 保持隐藏 |

**导入物体的旧路径有明确缺口。** 基线中的 `importRun()` 无条件换成 Basic 材质，不保留原贴图／PBR，也未设置 receiveShadow。Basic 可以参与投影，但不会因直接光重新着色，不自动使用 `scene.environment` 的 PBR 受光路径；被 AO 压暗不等于正确受光。本轮将此显示保留为默认／回退，增加独立的受光实验，原有 PBR 与贴图不再在实验路径中被丢弃。[当前导入逻辑](../web/editor/scene-editor.js)、[材质 adapter](../web/editor/import-materials.mjs)、[Three.js Basic 材质说明](https://threejs.org/docs/pages/MeshBasicMaterial.html)、[Standard 材质说明](https://threejs.org/docs/pages/MeshStandardMaterial.html)

验收用同一件合成 unlit 顶点色物体，经真实导入、摆放、确认后比较：原显示的中心区域亮度在开灯／关灯下均为 192；PBR 约为 173.82 / 0；切回原显示又恢复 192 / 192。缺失法线已补齐，碰撞代理未修改。已有 Physical 参数、贴图与共享几何的保留另有单测。当前真实物体目录返回 0 项，不能把合成实验当作真实重建颜色已完全适配；因此保留默认关闭，不批量重建粗糙度／金属贴图。

###### 2.3 几种“更真实”不能混为一谈

- **动态阴影**：某个光源被物体挡住形成的投影。
- **AO**：近邻几何的遮蔽和接触暗部；只使某些区域变暗，不产生真实反弹光。
- **IBL / 环境贴图**：给材质提供环境受光和反射；单张环境贴图不自动产生局部遮挡、窗户日照或多次反弹。
- **GI**：间接光、色彩反弹和更合理的室内明暗层次；可通过烘焙、屏幕空间近似或路径追踪实现，限制不同。
- **色调映射**：把 HDR 亮度显示到屏幕；不能修复错误光源方向或缺失的阴影。

##### 3. 前端直接接入或小范围适配的候选

“轻量”分别评价新增依赖、每帧 GPU/CPU 工作量、接入点和数据改造。下面的低/中/高是工程预估，不是 room3 或 Mac 的性能测试结果。

| 编号 / 项目 | 参与光影的方式 | 相对开销与耦合 | 当前接入建议与边界 |
| --- | --- | --- | --- |
| A1 [Three.js PMREM / RoomEnvironment](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/environments/RoomEnvironment.js) | 为 PBR 材质提供环境受光和反射 | 初始化有预过滤成本；运行低，配置耦合低 | 第一批。用程序化环境或小型 HDRI；RoomEnvironment 是通用环境，不是当前房间真实 GI |
| A2 [N8AO](https://github.com/N8python/n8ao) | 墙角、家具底部和物体相接处 AO | 中；需要深度和额外 pass，渲染层耦合低至中 | 第一批 A/B。明确支持正交相机和半分辨率；透明材质有额外成本。移动物体时禁用或重置静态累积，避免残影 |
| A3 [Three.js GTAOPass](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/postprocessing/GTAOPass.js) / [SSAOPass](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/postprocessing/SSAOPass.js) | 官方 AO 方案 | 中；增加 composer、深度/法线与降噪 | 第一批 A/B。使用 r180 文件及同版依赖；GTAO 源码区分正交/透视。可作为不引入第三方 AO 包的备选 |
| A4 [@pmndrs/vanilla 的 pcss](https://github.com/pmndrs/drei-vanilla#pcss) | 模拟接触处较硬、远离遮挡物较软的投影 | 中；ShaderChunk 注入影响同一 Three.js 实例 | 第二批。无需 React；锁版本、测试编译和恢复功能，避免影响虚影、导入材质和其他 renderer |
| A5 [Three.js Contact Shadows 示例](https://github.com/mrdoob/three.js/blob/r180/examples/webgl_shadow_contact.html) / [drei ContactShadows](https://github.com/pmndrs/drei/blob/master/src/core/ContactShadows.tsx) | 近似底部接触阴影 | 低至中；额外深度渲染与模糊 | 可针对地面试验；官方示例可保持原生 JS。一个地面接收平面不能覆盖床面、层架、墙面等所有接触面 |
| A6 [vanilla AccumulativeShadows](https://github.com/pmndrs/drei-vanilla/blob/main/src/core/AccumulativeShadows.ts) / [Three.js ProgressiveLightMap](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/misc/ProgressiveLightMap.js) | 多次采样并累积柔和阴影 | 收敛期间中至高，静止后可低；需要重置状态 | 适合停止拖动后的展示；拖动、开门、清空房间时要失效。不能把累积阴影当成完整多次反弹 GI |
| A7 [Three.js LightProbe / LightProbeGenerator](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/lights/LightProbeGenerator.js) | 用球谐系数近似漫反射环境光 | 运行低，捕获时有额外成本 | 可与 IBL 同阶段试验。单个探针不提供精细位置变化或遮挡，不能解决柜底接触阴影 |
| A8 [Three.js Reflector](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/objects/Reflector.js) / [vanilla MeshReflectorMaterial](https://github.com/pmndrs/drei-vanilla#meshreflectormaterial) | 平面镜面/模糊反射 | 中至高，通常需额外渲染场景 | 仅对真正需要反射的局部平面使用；大量家具、高粗糙度地板不值得默认打开；替换材料要保留原贴图 |
| A9 [Three.js SSRPass](https://github.com/mrdoob/three.js/blob/r180/examples/jsm/postprocessing/SSRPass.js) | 从屏幕深度和颜色估算反射 | 中至高，受分辨率与步数影响 | 作为高质量档独立验证。屏外物体信息缺失、边缘断裂和相机适配需要测试；IBL 可承担反射回退 |
| A10 [realism-effects](https://github.com/0beqz/realism-effects) | SSGI、SSR、AO 与时域处理 | 高于单独 AO，涉及速度/法线/深度等 pass | 保留为实验。README 明确当前不支持 OrthographicCamera，且部分 PhysicalMaterial/透明能力仍列为 TODO；需透视独立预览或自行适配，不宜直接替换主编辑器 |
| A11 [three-good-godrays](https://github.com/Ameobea/three-good-godrays) | 从阴影贴图估计体积光束、窗边光路 | 中至高，光线步进增加片元计算 | 演示增强项。现有主光阴影可复用，但正交相机要实测；清晰可见的光束意味着介质散射，不应给所有房间常开 |
| A12 [pmndrs/postprocessing](https://github.com/pmndrs/postprocessing) | 组织多种后处理及合并部分全屏效果 | 视启用效果而定，管线耦合中 | 它是基础设施，不会自动改善光照。若只选官方 AO，可先用同版 Three.js EffectComposer；避免两套 composer 混用 |

建议初次比较 **A2 与 A3 二选一**。AO、接触阴影、原贴图暗部都可能叠加变黑，是否叠加需要看固定视角结果，不能以开启效果数量作为质量指标。

`drei` 本体需要 React/R3F，原生项目优先使用 `drei-vanilla` 已有实现，或按照 Three.js 官方示例组织自己的小模块。不能为了一个阴影组件顺带迁移整个编辑器。[drei](https://github.com/pmndrs/drei)、[drei-vanilla](https://github.com/pmndrs/drei-vanilla)

##### 4. 离线加工或静止高质量预览候选

| 编号 / 项目 | 可交付什么 | 相对开销与耦合 | 对 RoomCanvas 的接入方式 |
| --- | --- | --- | --- |
| B1 [Blender Cycles Bake](https://docs.blender.org/manual/en/latest/render/cycles/baking.html) | 静态间接光、AO、独立 lightmap | 烘焙重，网页运行轻；资产流程耦合中 | 已有 Room.blend 与 Blender 环境，可在重建完成后作为独立加工步骤。先烘焙静态房间壳体，保留家具实时光影；新增 UV/贴图不要破坏节点、关节和碰撞数据 |
| B2 [The Lightmapper](https://github.com/Naxela/The_Lightmapper) | 自动 UV、Cycles 光照烘焙和降噪 | 烘焙重，运行轻；工具流程耦合中 | 减少人工烘焙操作。插件与当前 Blender 5.1.2 的兼容性未验证，可用独立工具环境验证后输出 sidecar，不改重建算法 |
| B3 [Ibrahim-3d/three-lightmap-baker](https://github.com/Ibrahim-3d/three-lightmap-baker) | 浏览器中烘焙漫反射 GI、生成 UV | 烘焙重，挂贴图后轻；资产耦合中 | 现有版本要求 Three 0.185.1，不能直接装到 r180。可放独立烘焙页研究其导出/应用接口；顶点色、透明/透射及部分贴图的传输能力有明确限制 |
| B4 [lucas-jones/three-lightmap-baker](https://github.com/lucas-jones/three-lightmap-baker) | 早期浏览器烘焙示例与思路 | 原型，兼容与完善成本高 | 保留为架构参考；README 的 GI、导出、API 等仍有 TODO，且未发现明确许可证，不能当作可直接纳入 vendor 的成熟包 |
| B5 [three-gpu-pathtracer v0.0.24](https://github.com/gkjohnson/three-gpu-pathtracer/tree/v0.0.24) | WebGL 路径追踪、多次反弹、软阴影及材质反射 | 高，场景整理/BVH/采样有成本 | 适合“高质量预览/截图”独立模块：复制视觉场景，交互停止后渐进收敛。此历史版本 peer 支持 r180；不要直接安装最新版本替代它 |
| B6 [DiffusionLight](https://github.com/DiffusionLight/DiffusionLight) / [Turbo 项目页](https://diffusionlight.github.io/turbo/) | 从照片估计 HDR 环境光 | 离线 GPU 较重，消费 HDR 的前端耦合低 | 可给每个房间生成候选环境贴图，人工检查方向与曝光后缓存。它是估计，不是测量，也不会自动解决局部遮挡或还原家具的真实反照率 |
| B7 [NVlabs/nvdiffrec](https://github.com/NVlabs/nvdiffrec) | 从图像反求网格、材质与光照 | 高，涉及训练数据、相机及资产变化 | 针对新导入物体研究去除颜色中已有光照；是重建后处理/逆渲染课题，不是浏览器加一个 pass。采用 NVIDIA 专用源码许可，不能按 MIT 项目处理 |
| B8 [Intel Open Image Denoise](https://github.com/RenderKit/oidn) | 烘焙/路径追踪图像降噪 | 离线或原生加工；没有直接 Three.js pass | 可服务 B1/B2 的贴图和离线成图；它不产生光照，也不应默认放进每帧浏览器主链 |

烘焙的关键边界：把可移动家具的阴影烘进地板，家具移动后就会留下“旧阴影”。第一轮只烘焙静态结构的间接光，家具投影和接触暗部实时处理；如果需要烘焙全布局，必须用布局/灯光/资产指纹管理缓存与失效。

不应把 r180 当前 GLTFLoader 视为能自动读取任意工具导出的 lightmap 扩展。需验证格式，或独立加载贴图、UV 和节点映射；同一份直接光不能同时由贴图与实时灯光重复计算。

##### 5. 不够轻或不直接匹配，但值得保留的候选

| 编号 / 项目 | 保留它的原因 | 当前不作为主方案的具体原因 |
| --- | --- | --- |
| C1 [Three.js SSGINode / WebGPU 示例](https://threejs.org/examples/webgpu_postprocessing_ssgi.html) | 官方屏幕空间间接光方向，可作为长期 GI 对照 | 使用新的节点/渲染管线，不是当前 WebGL EffectComposer 可直接加载的 pass；需要单独验证渲染器迁移 |
| C2 [新版 LightProbeGrid](https://github.com/mrdoob/three.js/blob/dev/docs/pages/LightProbeGrid.html) | 空间变化的漫反射光，比一个全局探针更贴近室内 | r180 没有该 addon；不能从最新文档推断当前可用，需版本升级或独立验证/回移 |
| C3 [Surfel GI / Webgiya](https://github.com/DGFX/three-surfel-based-global-illumination) | 研究动态间接光，可能弥补屏幕空间信息不足 | WebGPU，涉及 G-buffer、surfel 分配、空间索引、BVH 和多个 compute pass；属于渲染架构实验 |
| C4 [Relightable3DGaussian](https://github.com/NJU-3DV/Relightable3DGaussian) | 在 Gaussian 路线上研究材质分解和重光照 | 当前主编辑器与碰撞都依赖 GLB mesh；转换、训练和集成成本高，许可证也有研究/非商业范围限制 |
| C5 [Babylon.js](https://github.com/BabylonJS/Babylon.js) | 已弃用的 ViewForge 查看器曾使用 Babylon；其代码现归档于 `legacy/viewer/` | 不能直接改进主编辑器的 Three.js 画面；不再是当前前端的依赖，RoomCanvas 继续使用 Three.js |
| C6 [PlayCanvas](https://github.com/playcanvas/engine) | 运行时 lightmap、PBR 和阴影流程可作方案参考 | 另一个完整引擎，迁移主编辑器耦合高；若借鉴离线工具，要单独验证产物能否被 Three.js 消费 |
| C7 [Filament](https://github.com/google/filament) | PBR、环境光照和 cmgen 等工具可作校准或离线处理参考 | 引擎和资源格式不同；cmgen 预过滤结果不等于 Three.js PMREM 纹理，不能直接替换当前输出 |
| C8 [model-viewer](https://github.com/google/model-viewer) | 提供成熟的单物体 IBL、接触阴影、曝光与色调映射参考 | 可用于独立物体 A/B；Web Component 不直接承接当前整屋编辑器的碰撞和手势。Unlit 物体仍不自动变成受光 PBR |
| C9 [Poly Haven](https://polyhaven.com/license) | CC0 HDRI / PBR 资产，可支持 A1 的环境光照实验 | 是素材来源，不是渲染算法；选图需匹配室内光源，不能以高分辨率或“好看”替代方向正确性 |

##### 6. 版本、许可与维护快照

依据项目自身 README/源码、公开 GitHub 元数据及 npm 注册表，于调研日读取。`pushed_at` 只表示最近推送，不能单独证明代码质量或仍在维护；依赖范围包含 r180 也不等于已通过 RoomCanvas 实测。源码主分支、npm 发布包和在线文档可能不一致。

| 候选 | 核对版本 / 兼容性 | 许可与维护线索 |
| --- | --- | --- |
| Three.js addons | 使用与现有内核一致的 `r180` | MIT；不要混装最新版 addon 与旧内核 |
| N8AO | npm `2.0.1`；peer：Three ≥0.137，postprocessing ≥6.30；README 推荐较新 Three，支持 WebGL2 / 正交相机 | 仓库 LICENSE/README 为 CC0，npm 元数据写 ISC，纳入固定发布包前需核对并保留实际许可文件；最近推送 2026-08-10 |
| postprocessing | npm `6.39.5`；Three ≥0.168 且 <0.187，覆盖 r180 | Zlib；最近推送 2026-10-05 |
| @pmndrs/vanilla | npm `1.25.0`；Three ≥0.137 | MIT；最近推送 2026-02-20；包里还有不相关功能，需选用具体模块并测包体 |
| realism-effects | npm `1.1.2` 的 peer 为 Three ≥0.148；GitHub main 的同版本 package.json 却写 `^0.151.3`；README 明确不支持正交相机 | MIT；最近推送 2024-02-04。不能以宽泛 peer 范围作为 r180 可用的保证 |
| three-good-godrays | npm `0.12.1`；Three ≥0.125 且 ≤0.182，声明范围覆盖 r180 | LICENSE 为 zlib 风格条款，GitHub 机器识别为 NOASSERTION；最近推送 2026-08-06 |
| three-gpu-pathtracer | **`0.0.24`** 为 WebGL2，peer Three ≥0.180；npm 最新 **`0.0.27`** peer ≥0.185，主 README 已转向 WebGPU | MIT；仓库最近推送 2026-10-12。应固定旧版独立验证，不能使用 `@latest` |
| lightmap-baker | npm `1.0.0`，GitHub main `1.1.0`；两者 Three 范围均为 ≥0.185.1 且 <0.186；WebGL2 + 浮点颜色缓冲 | MIT；最近推送 2026-09-29。新版本对材质输入的限制需按实际使用版本再核验 |
| The Lightmapper | 当前插件版本与本项目 Blender 5.1.2 的组合未验证 | GPL-3.0；最近推送 2026-09-24；保持为独立加工工具，网页只读取结果 |
| lucas-jones baker | 示例依赖 Three 0.161.x，多个功能仍为 TODO | 未发现明确许可证；最近推送 2024-03-14；仅保留为研究线索 |
| Surfel GI | 示例依赖 Three 0.182.x，WebGPU | MIT；最近推送 2026-04-09，研究实现 |
| DiffusionLight | Python / CUDA / SDXL 路线，输出 HDR | 项目代码 MIT；使用时另核对所用基础模型、权重许可 |
| nvdiffrec / Relightable3DGaussian | CUDA 逆渲染 / Gaussian 研究路线 | 分别为 NVIDIA 专用源码许可、Gaussian-Splatting 研究许可；不将其列为已确认可任意商用的宽松许可库 |
| OIDN / Filament / model-viewer / Babylon / PlayCanvas | 分别为降噪、渲染工具或独立引擎/组件 | 前四者 Apache-2.0，PlayCanvas MIT；按实际使用版本和传递依赖保留许可 |

版本核对可直接复查这些发布者注册表：[N8AO 2.0.1](https://registry.npmjs.org/n8ao/2.0.1)、[postprocessing 6.39.5](https://registry.npmjs.org/postprocessing/6.39.5)、[vanilla 1.25.0](https://registry.npmjs.org/@pmndrs%2Fvanilla/1.25.0)、[realism-effects 1.1.2](https://registry.npmjs.org/realism-effects/1.1.2)、[pathtracer 0.0.24](https://registry.npmjs.org/three-gpu-pathtracer/0.0.24)、[pathtracer 0.0.27](https://registry.npmjs.org/three-gpu-pathtracer/0.0.27)、[lightmap-baker 1.0.0](https://registry.npmjs.org/lightmap-baker/1.0.0)。

##### 7. 怎样保持和现有任务低耦合

###### 7.1 接入边界

建议新增 `web/editor/lighting/`，把具体库放到 adapter 内。下面是建议接口，不是当前已实现的 API：

```js
const lighting = createLighting({renderer, scene, camera, requestFrame});
lighting.registerRoot(room, {kind: 'room'});
lighting.resize(width, height, pixelRatio);
lighting.invalidate('geometry'); // camera / geometry / visibility / light / material
lighting.render(delta);
lighting.dispose();
```

主要接入位置：`load()` 初始化和模型注册、`requestRender()` 的最终绘制、ResizeObserver、场景变化的失效通知，以及截图入口。手势与鼠标仍修改同一份 layout，光影模块只观察视觉场景变化；不让它反向控制抓取、碰撞、关节或重建任务。

```text
鼠标 / 手势 / 开关门 / 物体导入
              ↓ 现有场景变化
      光影 adapter：统一失效、绘制、缩放
              ↓
   原生灯光 + 环境光 + 可选 AO / 软阴影
              ↓
       单次色调映射与 sRGB 输出
```

初期按配置选一种 AO，不引入库的每个效果；GPU/渲染器不满足条件或 addon 加载失败时回到现有 renderer 路径。第三方库和必要的 r180 addons 在开发时构建/收集后放入 `web/vendor/`，运行时继续由 `serve.py` 提供本地文件，不强制使用者安装 Node 或联网加载 CDN。

调研基线的 `publish.py` 只在目标没有 vendor 时复制；当前分支已改为发布时更新 vendor，补齐新插件与模块，避免旧预览缺少依赖。

###### 7.2 统一配置与文档连接

当前 P0–P2 使用统一默认参数和测试档位，不增加逐房间必填配置，不按房间名称调整光源。若未来确需记录真实朝向或光照资产，再讨论可选 `lighting.json`，独立于 `room_objects.json` 和布局存档；以下只是后续候选字段：

- schemaVersion、适用模型指纹和坐标约定；
- 主光方向/强度/色温、填充光强度、曝光与 tone mapping；
- 可选环境图及旋转；
- AO、阴影、效果质量档；
- 导入物体材质策略；
- 可选静态 lightmap / 探针数据及稳定节点映射。

没有该文件时始终使用统一默认效果，不给旧房间增加必填项。不凭空推断房间真实朝向、太阳时间或窗外环境；当前也不实施窗户驱动的逐房间配光。

将最终用户操作写入 [web/README.md](#通用光影增强)，资产契约写入 [ROOM_RECONSTRUCTION.md](ROOM_RECONSTRUCTION.md)，导入材质策略写入 [OBJECT_RECONSTRUCTION.md](OBJECT_RECONSTRUCTION.md)。本调研记录方案取舍、来源和待验证项目，避免把研究假设写成已经上线的能力。

###### 7.3 必须验证的相互作用

1. **剖墙**：编辑模式的隐藏墙和物理预览的遮挡墙分别处理；若需代理遮挡物，只用于视觉计算，不加入原碰撞/选择目录。
2. **虚影和手指指示**：避免把半透明候选、地面指示、轮廓渲染进错误的 AO/反射。可用视觉层或最后单独绘制；库的排除功能也需要算性能成本。
3. **阴影更新**：移动家具、落下动画、导入、清空/还原、开门及显隐变化都标记失效。不能只监听相机，也不能把按需渲染无条件变成常开循环。
4. **时域历史**：相机和物体变化都应重置；N8AO 的静态累积不会自动发现所有物体运动。SSGI/渐进阴影/路径追踪需要各自的收敛预算。
5. **色彩**：保持 GLTFLoader 对颜色贴图和数据贴图的处理；法线、粗糙度、金属度贴图不能统一改成 sRGB。原生与第三方 composer 的 tone mapping / gamma 约定分别核验。
6. **材质还原**：选择、高亮、虚影、导入与光影适配都可能改材料。保存并恢复原材质，避免改动共享材质影响其他物体。
7. **烘焙**：静态壳体与动态家具分离；生成 UV 时保留稳定映射，不依赖每次加载都会变化的 runtime UUID，也不改变关节引用节点。

##### 8. 可以独立承担的任务清单

这些任务都可单独审阅。执行顺序以第 1 节 P0–P2 为准，L 编号仅用于标识任务。

| 任务 | 工作内容与交付 | 接触的范围 | 验收重点 |
| --- | --- | --- | --- |
| L0 基线与参照（P0） | 固定相机、布局、灯光、曝光和 DPR，记录截图与完整帧性能；区分房间 PBR、导入颜色、玻璃和金属 | 独立可重放的验收记录 | 同条件 A/B，可复现；既看全景也看黑点、接触和高光近景 |
| L1 光影 adapter（已有基础） | 已接通用环境、静态 GTAO、原生阴影配置、截图与回退；补 P0 所需诊断 | 现有模块 + 少量诊断调用 | 保持按需渲染；统计整帧而非末个 pass |
| L2 环境和主光（P1） | 保留光源结构，校准主光／填充光、环境与曝光比例，优先现有 RoomEnvironment | 通用 lighting 配置与 adapter | 同一组规则在两房间及未来场景有效，避免白墙过曝、黑色家具失去层次；不为每个房间手配光 |
| L3 AO 对比（P2） | N8AO 与 r180 GTAO 选一，比较关闭/低/高及半分辨率 | 后处理 adapter | 角落和接触感提升，透明墙/虚影无明显伪影；记录帧耗与显存增量 |
| L4 原有实时阴影（P2） | 在已收紧的 shadow camera 上验证并调整偏移、投影密度与更新时机；暂不扩展其他算法 | 阴影 adapter + 变化通知 | 排查黑点／条纹、床脚漂浮与漏光；动态家具和开门后更新正确 |
| L5 导入物体融合（P1） | 保留已有合格 PBR；对一件顶点色物体试 Standard 与受光阴影，保留原显示回退，审查法线与色彩 | 视觉材质 adapter、模型注册点 | 同一物体确实响应灯光和环境，避免二次明暗，不改变碰撞代理 |
| L6 静态 GI 样板 | 用 Blender 或独立 baker 为一个房间壳体生成间接光，定义贴图/UV/节点映射 sidecar | 独立加工脚本和资产加载 | 移动家具后没有旧阴影；保持节点、原布局与关节数据可用 |
| L7 高质量预览 | 固定 v0.0.24 路径追踪，使用视觉场景副本，暂停交互后采样；处理材质转换 | 独立预览模块 | 编辑器主链可继续使用；明确收敛时间、内存、镜头和几何变化后的重置 |
| L8 光束演示 | 对明确窗光场景试验 godrays | 可选后处理 | 正交相机可用；不把体积光当 GI；可随时关闭 |
| L9 后续研究 | 照片估计 HDR、反照率恢复或 WebGPU GI | 独立工具/研究分支 | 先得到可复用资产或可对照结果，再评估接主线，不与日常布置绑定 |

当前顺序为 **L0 → L2 与 L5 → L3 与 L4**。L6–L9 暂不执行。

##### 9. 实验与验收方法

###### 9.1 场景矩阵

至少覆盖：room3 全景、钢琴与琴凳近距离接触、床上枕头、书架层板、office 桌底、金属部件、一件 ViewForge 导入物体、柜门开合。每项比较静止、相机移动、家具拖动、松手、清空/还原、剖墙/天花板显隐。

每次只改变一个候选效果，保留原始、灯光校准、IBL、AO、软阴影和组合的结果。记录所有质量参数，不能把不同曝光、不同 DPR 或不同截图时刻混在一起比较。

###### 9.2 性能指标

- 明确本机型号、浏览器、硬件加速状态、画布尺寸和 DPR；编辑器与 MediaPipe 同时运行。
- 分别记录首帧/加载成本、稳定帧 GPU 时间、主线程时间、p50/p95 帧耗、交互响应及内存/显存估计。
- 记录停止交互后的收敛帧数和时间，静止后是否停止请求帧；关闭摄像头时不应继续保留无用推理。
- 记录新增本地资源的实际压缩后体积、传递依赖和网络请求。npm 包压缩包大小不等于最终网页 bundle 大小。
- 在目标 Mac 上先以 30 FPS 的 33.3 ms 总帧预算作保底评估，再评估 60 FPS；这是建议验收目标，不是已测表现。超预算时降低效果分辨率、阴影质量或回到基础档。

本调研没有把上游 demo 的毫秒数、加速倍数或截图效果当成本项目结论。

###### 9.2.1 P0 验收标准与当前边界

1. 固定模型版本、浏览器／渲染设备、画布尺寸、DPR、完整相机姿态／缩放／投影、布局、灯光状态、墙体与天花板显隐。统一无选中、无预览、无临时高亮，保存可重放配置；截图前等待静态增强真正完成。
2. 两个房间均保存整体画面，以及墙角、家具接触、深色光滑表面、床面／柜面伪影近景；再加入同一件导入物体的原显示和 PBR 版本。区域规则按材质／用途选择，不以房间名称写渲染补丁。
3. 拆分原始、仅环境、仅 AO、仅阴影与组合。当前 `lighting=off` 为完整原始；`ao=off&shadows=original` 为仅环境；`env=off&shadows=original` 为仅 AO；`env=off&ao=off` 为仅阴影。固定光照参数再比较算法，曝光不能一起变化。
4. 性能分别记录静止、有限时长的同轨迹视角移动／家具移动、停止后的补算；记录完整帧 CPU 提交耗时、GPU 时间（扩展可用时）、p50/p95、绘制调用、三角形、纹理／目标缓冲分配估计。手势关闭与识别开启分开测；扩展不支持的 GPU 指标明确记为不可用，不能用 CPU 时间替代。
5. 已修复先前 `renderCalls=1` 只反映末个全屏 pass 的问题：统一禁用自动逐 pass 重置，在交互／静态 AO／截图各阶段开始时重置并汇总全部绘制，输出带阶段标签的数据。`performance.now()` 只记录 CPU 提交；GPU 使用异步 query，不可用／disjoint 结果不会被伪装成零耗时。静止时不永久开动画循环。
6. 输出固定截图、配置和性能结果，对比是否改善白墙层次、深色材质反射、接触关系、导入物体受光与可见伪影。像素差异只能证明画面变化；真实性需参考照片或明确的物理／视觉判断，不能仅以“变化更大”验收。

本轮已实现上述基线的核心部分并记录两场景对照。真人手势、更多设备、真实新增物体、实际显存字节数和用户截图视角仍是后续验收项；单测数量不能替代这些结论。

###### 9.3 与现有检查连接

实现后先运行已有网页单测、Python 检查和真实模型检查；针对新增 adapter，只补有意义的失效、资源释放和配置回退测试。光影正确性仍需要固定相机截图和真人手势操作验证，单测不能证明视觉提升。

```bash
node --test 'web/editor/tests/*.mjs'
python3 -m unittest discover -s web/scripts
node web/scripts/check_room.mjs --scene-dir samples/room3
node web/scripts/check_room.mjs --scene-dir samples/office
```

已有离线网页入口为 `python3 web/scripts/serve.py`。第一轮光影实验可在此入口完成，不需要建立新的端口映射、模型服务或付费 API。

###### 9.4 第一版基础实现验证（2026-10-19，历史记录）

已按 1–3 的基础范围接入通用环境、静态 AO 与原生阴影校准，未接入表中其余候选：

- 前端单测 **157/157**，Python 检查 **12/12**；编辑器与脚本的 28 个 JS/MJS 模块语法检查通过。
- 真实模型检查：room3 **23/23**、office **18/18**。原有模型交叠提示仍保留，没有改几何或布局。
- 本机 Chrome 无头浏览器分别打开两个房间，比较默认增强与 `lighting=off`，确认三盏灯的类型、位置、强度一致；检查静止不再补算、视角保持拖动时暂停、松手后更新、暖光切换和窗口缩放。
- 实际选择办公室家具并操作移动摇杆，保持期间 AO 补算次数维持 2，松手后变为 3。此检查验证调度，不代表 GPU 帧耗测量。
- 人为阻断 GTAO 插件加载，编辑器仍能读取房间与物体，通用环境继续可用；新建及再次发布预览能更新插件和编辑器模块。

本机 Python 3.12 默认静态服务队列太小时，浏览器并行导入模块曾出现连接重置；扩大请求队列后完成上述浏览器检查。已有 `serve.py` 进程需重启才能采用此项修复。真人手势操作、GPU 时间与显存实测仍待后续验收，不能据此宣称达到特定 FPS 或真实全局光照。

###### 9.5 本轮 P0–P2 实现与测量（2026-10-19）

- 当前前端单测 **166/166**、Python **12/12**、33 个 JS/MJS 模块语法检查通过；room3 **23/23**、office **18/18** 的真实模型检查通过。新增测试覆盖材质回退、共享几何／原 PBR 保留、整帧跨 pass 统计、异步 GPU 与 disjoint 数据剔除。
- 固定浏览器画面 1440×1000、DPR 1，实际画布 1414×704；Three.js r180，Chrome 无头，ANGLE Metal / Apple M5，未打开手势识别。两个房间均比较 original、initial、balanced、balanced-no-ao、balanced-n8ao，模型 SHA256 与可重放相机／布局一同保存。
- 每档 60 次同轨迹镜头请求与 5 次停止后的有限静态补算，记录 CPU 提交与 GPU p50/p95，另记加载至 ready/settled 的墙钟时间、首次初始化统计及实际纹理数量。独立闲置 650 毫秒时所有档位均记录到 **0** 个新渲染帧。CPU 提交与 GPU 执行可以重叠，表中两列不能相加成端到端帧耗。

完整五档基线中的默认 balanced 静态补算（预热后）：

| 场景 / AO | CPU 提交 p50 / p95（ms） | GPU p50 / p95（ms） |
| --- | ---: | ---: |
| room3 / GTAO | 5.70 / 6.20 | 12.16 / 14.06 |
| room3 / N8AO | 5.80 / 6.20 | 12.43 / 12.83 |
| office / GTAO | 13.90 / 16.10 | 9.01 / 9.11 |
| office / N8AO | 14.50 / 15.50 | 8.98 / 9.19 |

这是单机、短序列、共同低预算下的观察，不是稳定 FPS 承诺或库的普遍性能排名。N8AO 使用外部半分辨率目标，不开启其时域累积、深度感知上采样或额外透明渲染，因此也不是两库最高质量模式的比较。当前没有观察到值得替换默认方案的稳定优势，保留 GTAO，并提供 `ao=n8ao` 对照。

完整报告与私人截图保存在仓库外 `/tmp/roomcanvas-lighting-final/`；追加透射玻璃 AO 排除回归位于 `/tmp/roomcanvas-lighting-glass-check/`，原阴影近景对照在 `/tmp/roomcanvas-lighting-shadow-check/`。临时目录不是永久存档，需要保留结果时由使用者保存到仓库外的稳定目录；脚本本身可重跑。未把私人房间截图或生成物加入 Git。

`check_import_lighting.mjs` 用不含法线的 unlit 顶点色 GLB，通过真实导入、落点检查、确认放置及界面开关验收；中心 16×16 区域的平均 RGB 强度，原显示为开灯 192 / 关灯 192，PBR 约 173.82 / 0，切回原显示恢复 192 / 192。正在摆放时切换会保留草稿并提示先完成摆放。结果在 `/tmp/roomcanvas-import-lighting-final/`。合成物体证明受光与回退路径生效，不证明所有真实重建颜色都适合二次打光；本机隧道物体目录本轮只读查询为 0 项。

保留的限制：用户截图中的小黑点未在当前固定镜头稳定重现；已有贴图明暗未做反照率分离；未进行真人手势并行测量、更多硬件测试、显存字节数测量或真实新增物体的视觉验收。不进行烘焙 GI。

## 手势模块开发日志（2026-10-09 起）

> 原 `gesture/LOG.md`。

### 2026-10-17 · 随 ViewForge 整合进 RoomCanvas

- ViewForge 完整历史通过合并提交 `670a8bf` 导入 RoomCanvas；原哈希、作者和时间保持不变。
- 本工程从 `object-reconstruction/gesture-furniture-demo/` 提升为 RoomCanvas 根目录的 `gesture/`。Root 启动脚本相对定位本目录，ViewForge 模块内保留兼容入口。
- 手势动作、浏览器内识别、postMessage 协议、Babylon 场景和服务器校验逻辑保持原有实现；后续由 RoomCanvas 整合分支维护本目录。
- 原 RoomCanvas 的房间重建、Three.js 编辑器和示例文件保持不变，两个前端模块各用自己的锁文件和依赖目录。
- 新结构下手势 74 项、ViewForge 前端 34 项及后端 71 项、原编辑器 122 项与 6 项 Python 测试通过，类型/资源检查和两个前端构建通过；临时服务已确认新场景路径和原有 catalog。未切换既有服务，未推送或合并 main。

### 2026-10-17 · 合并 Git 历史与保存迁移

- ViewForge 先按功能依赖补齐五批阶段提交，作者和提交者日期依据文件修改日期及项目记录推定，并在提交说明中注明整理日期。
- 合并提交 `bc44718` 保留原手势仓库五个提交的哈希、作者及作者/提交者时间，原 `32082a3` 的源码树完整放入当前子目录；迁移适配另作一次提交。
- 当前分支为 ViewForge 的 `codex/gesture-integration`；后续只维护本仓库内的手势工程。来源、阶段哈希和日期依据见 `../docs/HISTORY_INTEGRATION.md`。
- 不推送原 MV-SAM3D 上游；历史与源码核对完成后按用户要求清理原本机独立手势目录，不另做备份。

### 2026-10-17 · 随 ViewForge 仓库提供手势入口

- 从原手势仓库 `32082a3` 导入源码、测试、锁文件和识别资源至 ViewForge 代码仓库的 `gesture-furniture-demo/`，原独立仓库保留。
- ViewForge 增加相对目录启动脚本 `scripts/gesture.sh`，不再依赖独立工程的本机绝对路径。依赖仍需首次安装，环境和构建输出不提交。
- 默认场景地址改用 `/viewforge/layouts/viewer`；后端按当前源码路径定位布局页，并保留 origin/会话参数。部署位置变化无需修改手势源码。
- 摄像头、Worker 识别、postMessage 和 Babylon 场景仍在用户浏览器执行；服务器继续执行原物体重建、承托/碰撞校验及保存，没有修改手势动作或操作映射。
- 资源校验允许克隆后不存在被忽略的 outputs 目录；原演示、可选后端和依赖版本保留。
- 新目录独立安装依赖后，74 项手势测试、TypeScript/双入口构建和资源校验通过；从仓库外执行相对定位启动脚本也通过。服务器 15 项布局测试通过，覆盖迁移路径包含空格时的入口及会话参数保留。
- 在临时端口验证服务后，确认无重建/蒙版/COVER 任务，更新原 ViewForge 服务。新入口及 catalog 可用，保留 3 个房间、26 个重建结果。此次未提交、推送，未重新进行真人摄像头验收。

### 2026-10-09 · 工程骨架与选型

- 在总目录下创建独立的“手势家具布置演示”，未复制或修改平级工程。
- 固定 TypeScript、Vite、Three.js、MediaPipe 和 Vitest 版本，生成 package-lock；来源和许可记录在 docs/sources.md。
- 当前机器没有系统 Node/npm，使用已有 Codex Node runtime；提供 scripts/run.sh，其他机器按 README 用 npm ci。
- 模型与 WASM 本地化，清单包含来源、字节数与 SHA-256。

### 2026-10-09 · 鼠标与场景闭环

- 自制 GLB 房间、沙发、茶几、椅子，采用米制约束、地板射线抓取偏移、15°旋转、高度、相机与每场景撤销。
- 建立 XYZ 光标、近/中/远 20 个目标、驻留计时、地面投影和深度标尺。
- 完成响应式界面、鼠标备用输入、指南、菜单、复位确认与场景状态保留。

### 2026-10-09 · 摄像头与手势

- 用户点击开启摄像头，推理在 Worker 串行执行，默认不录制、不上传。
- 捏合归一化、100ms 确认、迟滞、1€ Filter、600ms 张掌菜单、单双手控制及角色交换。
- 追踪即时冻结、200ms 中断、恢复松手、交叉歧义冻结；辅助手丢失不误提交。未确认预览按场景隔离并可撤销。
- XYZ 以投影尺度对数变化控制相机前后方向，侧转冻结，重新朝向时重建尺度参考。
- 修正模块 Worker 的 WASM loader，使用 forVisionTasks(path, true)。真实本地模型对合成黑帧完成推理。

### 2026-10-09 · 自动检查与权限处理

- 18 项合成单元/集成测试通过，TypeScript 检查和生产构建通过。
- Chrome 场景截图检查通过，所有家具加载，页面无异常；检查输出仅存临时目录。
- 自动审批拒绝新增 Playwright 依赖，理由是现有本机工具足够、该新增依赖超出此次授权。未安装该依赖，改用已有测试工具完成浏览器检查。
- 浏览器、断网替代检查和资源最终结果追加在 docs/acceptance.md。真人精度、稳定性、物理断网和 Safari 待人工验证，未标记达标。
- 生产页面 12 项操作/生命周期检查通过；非本地请求被阻断，实际外部请求为 0；无页面异常。合成摄像头短测 60 FPS / 23Hz，停止后视频轨道全部 ended；390px 布局无横向溢出。
- 模型、WASM、GLB、固定依赖版本与许可清单最终校验通过。outputs 保持为空。
- 最终补充单手/辅助手中断隔离测试，共 19 项通过；修正滤波导数使用连续原始样本，深度标尺随相机朝向更新，交换角色后菜单提示同步。
- 最终浏览器检查 13 项通过，合成视频 60 FPS / 22Hz；家具约束包围范围覆盖偏心靠背和坐垫，避免边缘越出房间。

### 2026-10-09 · 指尖与中点可视化

- 按用户要求，在主场景和摄像头预览添加半透明天蓝色的拇指/食指指尖点、连接线和中点。双手均显示，辅助手稍淡；捏合状态仍保持天蓝色并加深圆环。
- 指尖对跟随已滤波中点整体平移，连线中点与实际控制指针对齐；标记不拦截输入，丢失或停止摄像头时隐藏。
- 19 项现有测试及 TypeScript/生产构建通过。Chrome 合成关键点检查确认双手显示、颜色透明度、中点对齐、菜单命中及丢失后隐藏，无页面异常。临时截图已目视检查，未访问真实摄像头。

### 2026-10-09 · 固定右手控制

- 按用户修订，固定右手两指控制，删除交换操作手入口。主场景和预览只突出右手指尖连线；左手仅保留普通骨架、张掌菜单及双手操作辅助。
- 修复抓取期间按腕部位置选择候选却未核验左右手的接管风险。候选必须标为 Right 且分类分数 ≥0.8；低置信度、多个右手候选、标签翻为 Left 或交叉歧义均冻结，不能以位置接近覆盖右手要求。
- 新增左手单独入画、双手顺序、附近左手接管、低置信度和重复右手候选的回归验证；共 24 项测试通过，TypeScript 与生产构建通过。
- Chrome 合成关键点检查验证仅一组右手指尖、左手单独出现隐藏指针、抓取时左手不能接管、左手辅助保留、交换入口移除，无页面异常。真实摄像头左右手分类仍需本机体验，不将模型分类当作绝对身份保证。

### 2026-10-09 · 左手环绕与浅绿色反馈

- 按用户修订增加左手两指捏合拖动环绕场景：任意模式可用，左右水平环绕、上下俯仰，松开固定；主场景与摄像头预览显示浅绿色指尖、连线和中点。右手物体控制保持天蓝色，两手角色不交换。
- 左手独立计时与身份连续性检查，右手缺席超过 200ms 不再重置左手捏合。左手丢失立即冻结，长中断后需松手重抓。
- 物体拖动和视角拖动互斥，先开始者优先，普通模式同时开始时右手优先；观察/XYZ 缩放模式双手操作优先，结束不自动退回单手。菜单/暂停停止视角控制；XYZ 环绕时不累计目标驻留。
- 增加独立左手、互斥、丢失恢复、暂停、双手优先和身份锁定回归检查，33 项测试通过；TypeScript、生产构建和资源校验通过。
- Chrome 合成帧经真实 App/Three.js 链路确认左手单独持续旋转相机、不改物体或撤销历史、双手颜色与中点对齐、菜单冻结及停止后隐藏；无页面异常，截图目视检查通过。未访问真实摄像头，真人手感仍待体验。

### 2026-10-09 · 快速松开与指尖显示上限

- 将捏合释放阈值从 0.35 调至 0.30，释放确认独立设为 40ms；抓取保持 0.25 / 100ms，减少松开需要的距离与等待。补充释放计时、短暂噪声及左右手释放回归验证。
- 增加 `fingerGuideMaxRatio: 0.8`，两手分别在指尖距离/掌部尺度达到上限时隐藏场景指尖、连线及中点，低于上限恢复。仅改变反馈，不影响手势与菜单逻辑，摄像头预览保留。
- 35 项测试、TypeScript 和生产构建通过。Chrome 合成显示检查确认精确 0.8 边界、两手独立显示、全部隐藏及重新靠近恢复。检查脚本使用 SVG hidden 属性判定，未开启真实摄像头。实际松开手感及显示上限仍需真人体验。

### 2026-10-09 · 张掌打开、握拳关闭菜单

- 保留左手张掌 600ms 打开菜单，增加左手四指收拢握拳 200ms 关闭当前菜单，包括复位确认。提示文字和操作文档同步更新，确认时长集中配置。
- 握拳与普通两指捏合区分，只有可信左手响应；中断或松拳重置确认，持续握拳仅发出一次请求。关闭时中断控制并阻止同帧场景执行，需松手再抓取。
- 38 项测试、TypeScript 与生产构建通过。Chrome 合成帧经真实 App 链路验证张掌打开、捏合保持菜单、握拳关闭、场景物体与视角不变及再次张掌打开。未访问真实摄像头，真人识别体验待验证。

### 2026-10-09 · 双手同时控制物体与视角

- 按用户修订取消普通物体操作与左手环绕之间的互斥，支持任意先后或同时开始；各自松开仅结束各自操作。观察模式双手视角缩放、XYZ 缩放模式双手模型缩放继续优先。
- 相机改变时，以最后有效右手位置重建家具地板交点基准及 XYZ 相机平面基准，静止右手不因投影改变拖走物体；保留最初撤销快照。左右手长追踪中断分别冻结对应会话，整体中断仍停止全部。
- 更新原互斥测试，加入并行释放、相机相关地板映射、XYZ 坐标轴和独立中断验证。41 项测试、TypeScript 与生产构建通过。Chrome 合成控制输入在真实 Three.js 场景验证相机旋转、静止物体不跳变、右手继续移动、右手提交后左手继续及撤销。未开启真实摄像头，真人双手手感待验证。

### 2026-10-09 · 松手防漂移

- 修复释放确认期间仍应用指尖中点变化的问题：越过释放阈值首帧输出 releasing，冻结控制中点与掌尺度；张开样本不进入位置滤波器，确认释放后提交最后稳定结果。抓取/释放阈值及 40ms 确认时间保持不变。
- 控制层阻止释放待确认时的物体/相机更新；左右手独立冻结、另一只手仍可控制。双手缩放在任一手开始释放时冻结，确认后只提交一次。短暂张开后恢复捏合仍可继续。
- 新增两手中点锁定、滤波不受张开噪声污染、升高物体与视角冻结、两手独立释放和双手缩放提交回归验证。46 项测试及 TypeScript/生产构建通过。Chrome 合成关键点经 App→手势→控制→真实 Three.js 验证松手突发上移的首帧、待确认和结束帧物体/相机均不变，正确产生一次提交。未开启真实摄像头，真人手感待体验。

### 2026-10-10 · 操作工具栏移出三维画面

- 将移动/旋转/高度/观察/缩放/菜单工具栏移到三维画面上方的独立区域，不再浮在房间内。保留场景容器与摄像头坐标映射。
- 46 项现有测试及生产构建通过；本地 Chrome 在 1440、850、390px 宽度确认工具栏不与画布重叠、页面无横向溢出、旋转按钮可用，桌面截图目视检查通过。未开启摄像头。

### 2026-10-10 · Mac mini 可选远程识别与多客户端准备

- 增加 Python 标准库 HTTPS 后端，MediaPipe Python 0.10.32 CPU / IMAGE 推理，复用既有模型并校验 SHA-256；画面和关键点只在内存处理。
- 增加远程 tracking 适配器、计算位置选择、明确发送画面的开启按钮、推理与往返耗时。默认保持本地 Worker；远程令牌只在内存，停止与切换取消请求，旧帧不应用，失联冻结且需松手重抓。
- 多客户端使用默认两个独立推理实例，无画面队列；忙时 503 丢帧重试，各客户端控制与房间独立。新增证书生成工具和局域网测试说明，Python 全部依赖锁版本及发行包哈希记录在来源文档和 vision 清单。
- 本机 50 项前端测试、5 项后端测试通过（含真实模型空白图、双客户端合成并发、授权、忙时恢复），TypeScript/生产构建及资源校验通过。生成的测试证书通过 OpenSSL 信任链校验；真实跨设备摄像头未验收。
- 用户指定通过 ssh macmini，确认目标为 Apple Silicon、10.40.14.82；按用户要求保存至 Mac mini 桌面/3D视觉设计/手势家具布置演示，不覆盖同级两项现有工程。远程环境安装与运行测试另记。

### 2026-10-10 · 保存到 Mac mini 并启动局域网测试

- 按用户明确指示，将完整工程保存到 Mac mini /Users/awhy/Desktop/3D视觉设计/手势家具布置演示，原有两个平级工程未修改。
- 使用已有 uv 0.12.22 创建工程内 Python 3.12.15 环境，严格按哈希锁文件安装 18 项依赖。证书/私钥在 Mac mini 工程内生成，有效 30 天；仅复制公开 CA 到本机 outputs/macmini-ca.pem。
- Mac mini 上 5 项后端测试通过，临时 SSH 会话运行 HTTPS 8843、两个推理实例。当前电脑验证测试 CA 后访问健康接口返回 200；两条并发合成空白帧请求流各 5 帧成功，平均推理 16.2/14.9ms，平均往返 39.4/41.0ms。为无手小样本协议检查，不代表真人性能。
- Chrome 无障碍树确认远程模式和发送画面按钮；截图接口报 ScreenCaptureKit 捕捉失败，未完成截图视觉 QA。未启用真人摄像头，客户端证书信任和真人验收待执行。未设置开机启动，未提交或推送。

### 2026-10-12 · GitHub 同步准备

- 用户授权仅同步本工程，仓库根不包含两个平级工程。参考 Three.js / Vite 的 README 组织方式，重写功能、快速开始、手势表、参数、架构、可选后端、验证范围和许可说明。
- 忽略依赖、构建、输出、虚拟环境、证书/私钥及环境文件；保留本地模型与 WASM，克隆后无需再下载模型。
- 50 项前端测试、TypeScript、生产构建及资源校验通过；未重新进行真人摄像头验收。用户指定新建私有仓库，已创建 `AWHYhuh/gesture-furniture-demo`；初始提交 `b6b787a` 已推送，远端 main 提交校验一致且 isPrivate=true。62 个项目文件纳入版本管理，未包含平级工程、依赖、构建、输出和证书。

### 2026-10-13 · ViewForge 右手移动与旋转接入

- 在 `codex/viewforge-integration` 分支新增 viewforge.html 和 integration 模块；复用既有摄像头、Worker、GestureEngine，不创建 Three.js 演示场景。原演示与识别阈值保持原实现。
- 本机联调页嵌入 ViewForge，使用 viewforge-gesture-v1 传右手镜像指针与捏合状态；来源、会话、序号、新鲜度和状态反馈均有校验。无原始关键点或视频上传。
- ViewForge 配套分支 codex/gesture-integration 共用鼠标/手势候选事务，松手后异步承托及完整网格碰撞校验；自由旋转不吸附。丢手不提交，明确取消可恢复并使旧结果失效；已松手提交后丢手不取消校验。
- 类型检查、55 项测试、资源校验和双入口构建通过。Chrome 合成摄像头/关键点经实际状态机与 Babylon 链路验证移动、旋转、全量替换、释放提交、拒绝回退、丢手、停止资源释放和鼠标操作。布局 API 为内存夹具，未保存服务器测试布局。
- 左手、菜单、高度、缩放和自然深度接口暂未接入；真实摄像头手感、真实模型新摆放和长时间性能待验收。未提交、推送或重启 ViewForge 服务。
- 最终不替换 Worker 的检查确认真实 MediaPipe/WASM/模型可处理 Chrome 合成摄像头帧、真实服务三个房间正常加载、摄像头默认关闭并可释放；无页面异常，未使用物理摄像头或保存布局。

### 2026-10-13 · 保存首版并更新左手数字与观察计划

- 用户实际试用并认可当前版本；已将首版识别接入代码及说明本地提交为 ee685b6，分支 codex/viewforge-integration。按本次提交范围未推送；ViewForge 依用户要求暂不提交。
- 下一阶段确定左手 1/2/3 对应移动物体、旋转物体、仅观察，右手捏合执行操作。数字需稳定确认与去抖，忙碌期忽略切换，切换后松手重抓。
- 用户确认观察视角同时需要平移和环绕，切换手势后续再约定；本轮没有实现数字识别、相机接口或新的操作映射。
- 更新下一阶段文档和 README/计划链接；记录两仓库职责、现有协议复用、相机会话、回归与真人验收要求。文档变更无需重跑未改变的实现测试，沿用首版 55 项手势测试与完整构建/联调结果。

### 2026-10-13 · 左手数字切换与右手观察操作

- 用户明确手型：左手 1 为食指，2 为食指＋中指，3 为食指＋中指＋无名指；右手观察两指（拇指/食指）捏合环绕，三指（拇指/食指/中指）合拢平移。
- 新增独立数字特征与稳定模式选择器：400ms 确认、重复抑制、空闲直接换数字、忙碌忽略不重放、失效后中性手型恢复、左右手和歧义保护。原演示不消费新数字指令。
- 新增观察捏合识别和动作锁定，沿用原捏合/释放阈值与滤波；在接入页复用 mode，右手观察帧增加 orbit/pan，使用能力回执兼容旧布局页。
- ViewForge 新增独立相机会话与视平面平移/环绕，观察不修改布局或调用碰撞；释放首帧冻结、丢手保留最后视角、明确取消恢复原视角并清除惯性。物体事务继续保持原行为。
- 手势 70 项测试、类型检查、资源校验、构建通过；ViewForge 32 项测试、类型检查、构建通过。Chrome 合成输入验证新增动作及物体回归，无异常、无服务器布局保存。真人识别与手感尚待用户验收。
- 手势仓库当前分支为 viewforge-integration，本轮沿用当前分支，没有切换、提交、推送或重启 ViewForge 后端。

### 2026-10-13 · 水平环绕反向与左手检测反馈

- 按用户反馈反转仅观察水平环绕方向，上下、平移与物体旋转不变。
- 修正数字识别对自然收拢手指的判断：近端折回且末端仍直也识别为收拢；保留左右手/置信度/歧义保护。
- 添加绿色左手场景指针、检测状态、数字确认进度，以及先松开右手/等待当前操作/张掌恢复等说明。左手单独入画可选模式，原右手蓝色指针保留。
- 协议只增加可选左手显示坐标，不传原始关键点、不驱动物体；右手缺席仍显示左手，停止或超时清除。
- 手势 74 项、ViewForge 34 项测试及类型/构建和资源校验通过；Chrome 合成真人式收拢姿态与左右手链路通过，没有页面异常。真人试用反馈待用户确认。未提交、推送或重启后端。


### 2026-10-20 · 手势改接 RoomCanvas，移除 ViewForge 场景关联

- 独立识别入口由 `viewforge.html` 改为 `roomcanvas.html`，默认连接 7880 的 RoomCanvas 编辑器；iframe 协议统一为 `roomcanvas-gesture-v1`，同步更新接收端、测试和文档。
- 内置识别继续复用现有 runtime、Worker 和状态机，摄像头默认关闭；不连接物体重建后端。ViewForge 的房间场景及场景手势接收端已移除，物体重建、补拍、预览和实测标定保留。
- 手势 74 项、网页 173 项及网页 Python 12 项测试通过，手势类型检查、资源校验、Vite 和 embed 构建通过；物体预览 10 项及后端 CPU 58 项回归通过（macOS 测试使用规范临时路径）。
- Chrome 本机合成模型验证：单物体 GLB/Gaussian 切换、标定 0.9 米并导入 RoomCanvas 放置、添加物体入口、手势 iframe 握手和切模式、摄像头默认关闭；未见页面异常。未使用物理摄像头或执行 GPU 重建，未操作正式服务器数据、提交、推送或部署。

### 2026-10-23 · 从本地完整 UI 分支拆出手势更新

- 对照主线 `6daeb80` 与本地整合版本 `0565704`，在 `feat/gesture-controls` 单独整理手势变更；原完整 UI 分支、工作区与 PR #24 保留。
- RoomCanvas 两入口接入左手独立环绕、右手家具操作、数字 1/2/3/4、抬高后悬空预览、双手相机缩放和 1080° 连续旋转。成圈的 3 优先选择缩放，松手后才重新抓取。
- 新增右手竖拇指稳定约 500ms 确认，绑定预览与会话；松手、追踪丢失、轻捏和换拿家具均不隐式保存。确认共用原碰撞、承托、落下与撤销流程。
- 两入口显示镜像骨架、双手指尖和确认进度；骨架按视频原尺寸绘制且只镜像一次。排除隐藏、折叠及禁用控件，导出布局仅接受鼠标／键盘。
- 保留主线页面、旧独立演示与资源，不带入首页、登录、房间管理、品牌、后端或仓库抽屉改版。更新最小操作文档和差异对照，重新生成内置识别包；构建保留 vendor 许可说明。
- 手势 98 项、编辑器 199 项、网页 Python 12 项通过；类型检查、资源校验、生产与 embed 构建通过。真实模型检查 office 18/18、room3 23/23 通过。含中文目录的检查使用既有 `--three-dir web/vendor` 参数，避开脚本默认路径重复编码问题；未改动该检查脚本。
- 浏览器验证 office 加载、选择／取消／确认家具、独立手势页握手及移动／抬高／缩放／旋转切换，未发现页面脚本错误。摄像头保持关闭；骨架几何、手型与控制路由通过合成输入检查，物理摄像头准确率和长时间手感仍待真人验收。

## 手势模块工程计划（2026-10-09）

> 原 `gesture/docs/plan.md`。

用户批准的实施范围，2026-10-09。验收目标与实际执行结果分开记录；本文件不构成已达标声明。

后续用户修订（2026-10-09）：强制右手两指控制，取消角色交换；天蓝色指尖连线仅显示右手。下文保留原始计划，现行行为以 gestures.md 为准。

再次修订（2026-10-09）：增加左手两指捏合拖动环绕场景，显示浅绿色指尖/连线/中点；右手物体控制保持天蓝色，不允许左右手互相接管。

手感修订（2026-10-09）：释放阈值由 0.35 调至 0.30，释放确认由 100ms 调至 40ms；抓取阈值 0.25 和确认 100ms 保持原值。现行参数见 src/shared/config.ts。

### 1. 工程位置与目录

工程位于 `/Users/why/Desktop/3D视觉设计/手势家具布置演示`，与 `glb转stl文件`、`手势控制3D模型` 平级。独立管理代码、依赖与文档，不复制旧工程或第三方仓库的依赖目录。

```text
手势家具布置演示/
├── README.md                # 项目介绍、启动与操作
├── AGENTS.md                # 开发约定
├── LOG.md                   # 决策、进度与验收记录
├── package.json
├── package-lock.json
├── index.html
├── tsconfig.json
├── vite.config.ts
├── docs/
│   ├── plan.md
│   ├── architecture.md
│   ├── gestures.md
│   ├── sources.md
│   └── acceptance.md
├── public/
│   ├── vision/              # 本地模型与 WASM
│   ├── models/
│   │   ├── room/
│   │   └── furniture/
│   ├── textures/
│   └── environments/
├── src/
│   ├── main.ts
│   ├── app/
│   ├── camera/
│   ├── tracking/
│   ├── gestures/
│   ├── controls/
│   ├── scene/
│   │   ├── core/
│   │   ├── furniture/
│   │   └── xyz/
│   ├── ui/
│   ├── shared/
│   └── styles/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── scripts/
└── outputs/                 # 初始为空，不默认保存摄像头画面
```

旧调研通过文档链接引用；实际版本、许可及模型校验值记录在 sources.md 与 vision/manifest.json。node_modules、dist 是本工程生成的可重建目录。

### 2. 技术与模块边界

采用 TypeScript + Vite + MediaPipe Hand Landmarker + Three.js。首版使用普通网页界面，不引入 React 或路径追踪。

`摄像头 → 标准化手部数据 → 手势事件 → 控制命令 → 三维场景`

界面显示手势与模式；鼠标备用输入进入同一控制层。

- tracking 输出关键点、左右手、有效状态与时间戳，不操作场景。
- gestures 输出捏合开始/保持/结束、张掌与追踪中断，不包含家具逻辑。
- controls 管理模式、选中对象、相对基准、变换约束与撤销。
- scene 加载资产、射线拾取、执行变换，不直接读取 MediaPipe。
- app 协调生命周期，防止重复推理；ui 显示模式、手势及恢复提示。
- 鼠标和手势共用选择、移动、旋转、缩放、提交、撤销与复位入口。

当前 Apple Silicon Mac 上以本地 Chrome 为主验收浏览器，Safari 作兼容验证。模型、WASM 和资源由 localhost 提供；准备完成后支持断网运行。

### 3. 操作方式与手势

默认右手操作、左手打开菜单，允许交换角色。

| 操作 | 手势 | 行为 |
| --- | --- | --- |
| 打开菜单 | 未抓取时，左手张掌保持 600ms | 暂停场景操作，显示模式与功能 |
| 选择/关闭菜单 | 右手指向菜单项后捏合 | 确认选择，松手后允许场景操作 |
| 指向家具 | 移动右手拇指与食指中点 | 指针移动，命中家具高亮 |
| 移动家具 | 移动模式，指向后捏合并移动 | 射线与地板求交，保持抓取偏移 |
| 放置 | 松开捏合 | 提交当前位置，加入撤销 |
| 旋转家具 | 旋转模式，捏合后水平移动 | 绕竖直轴旋转，15°吸附与角度显示 |
| 调整高度 | 高度模式，捏合后上下移动 | 限制在地板与天花板之间 |
| 环绕观察 | 观察模式，单手捏合拖动 | 相机环绕，不移动家具 |
| 拉近/拉远 | 观察模式，双手捏合拉开/靠近 | 改变相机距离 |
| 缩放展示模型 | XYZ 缩放模式，双手捏合拉开/靠近 | 按初始双手间距比例缩放 |
| 撤销 | 菜单选择撤销 | 撤销最近物体操作 |
| 复位 | 菜单选择复位，再确认 | 恢复当前场景初始布局与视角 |
| 切换场景 | 菜单选择家具或 XYZ | 保留各自状态 |
| 暂停/恢复 | 菜单选择对应入口 | 暂停仅保留菜单响应 |

家具移动使用世界 XZ 平面，Y 向上，保持实际尺寸，不能越出房间边界。首版不实现家具间物理碰撞。

XYZ 中，捏合后手的左右/上下位移控制相机平面内移动；掌部投影尺度增大使光标靠近观察者，减小使其进入深处。每次抓取重建基准，显示深度标尺与地面投影线。明显转掌时暂停深度更新并提示掌面朝向摄像头。

捏合使用掌部尺度归一化，抓取/释放初始阈值 0.25/0.35，确认 100ms；使用按时间戳更新的 1€ Filter。参数集中配置，真人实测后固定。

追踪失效立即冻结；超过 200ms 中断会话，保留最后有效位置。恢复必须松手重抓，不能把手部丢失当作放置确认。

### 4. 实施阶段

1. 建立独立工程、开发约定与文档，确认依赖版本和许可。
2. 完成鼠标闭环：约 6×5m 房间、沙发/茶几/椅子、变换、约束、撤销及场景切换。
3. 实现摄像头入口、关键点反馈、捏合、张掌和完整手势菜单。
4. 接入家具移动、旋转、高度及相机控制。
5. 实现自然 XYZ 的掌部尺度深度、朝向检查与不同深度目标。
6. 进行本机断网、兼容、性能与稳定性验收，更新操作说明及记录。

首版不包含户型绘制、模型上传、自动布局、RGB-D 或复杂物理仿真。自然深度若未达标，记录限制，不用分步深度操作替代后宣称达标。

### 5. 验收目标

- 开启摄像头后，全手势完成菜单、家具操作、撤销与场景切换。
- 放置 20 次，至少 18 次中心误差 ≤10cm。
- 指定角度旋转 10 次，至少 9 次误差 ≤5°。
- XYZ 近/中/远目标 20 次，至少 18 次在 10 秒内进入半径 10cm 范围并保持 1 秒。
- 五分钟操作误抓取/误切换 ≤1 次。
- 遮挡、出画、交叉及摄像头断开无跳变或错误接管。
- 主浏览器渲染中位帧率 ≥30 FPS，推理 ≥20Hz；记录响应延迟及连续 15 分钟表现。
- 准备完成后断网可用；不默认录制或上传，停止时释放摄像头资源。

合成关键点测试验证状态与映射；真实摄像头验证操作手感。执行结果见 acceptance.md。

### 6. ViewForge 接入后续（2026-10-13）

用户认可右手移动/自由旋转首版，首版已本地提交 `ee685b6`。下一阶段左手 1/2/3 切换移动、旋转、仅观察；观察需要平移与环绕，具体切换方式待约定。本轮只更新计划，未实现新识别或相机控制。接入扩展单独维护在 [当前 RoomCanvas 接入](../gesture/docs/roomcanvas-integration.md)，原独立演示范围保留。

2026-10-13 后续实现：用户已确认左手 3 为食指/中指/无名指，观察右手两指捏合环绕、拇指/食指/中指合拢平移。两类观察动作和数字选择现已实现；后续转入真人手型、方向/增益和持续性能验收，见同一计划文档。

## 手势模块本机验收记录（2026-10-09）

> 原 `gesture/docs/acceptance.md`。

日期：2026-10-09。当前状态：功能原型与下列自动检查完成；真人指标尚未执行，不视为通过。

最新修订：松手达到释放阈值首帧冻结控制，确认后提交最后稳定结果；46 项测试和构建通过。Chrome 合成关键点经完整 App/Three.js 链路验证松手上移不改变物体和视角、释放正确提交。未开启真实摄像头，真人效果待体验。

此前修订：右手物体操作与左手环绕可同时进行，分别释放及中断。41 项测试、构建通过；Chrome 合成输入在真实 Three.js 场景检查相机旋转、静止右手不拖动物体、移动、提交及撤销通过，真人手感待验证。

此前修订：左手张掌 600ms 打开菜单、握拳 200ms 关闭；38 项测试及构建通过。Chrome 合成帧验证打开、普通捏合不关闭、握拳关闭、场景不变和再次打开，真人体验待验证。

此前修订：释放阈值 0.30、释放确认 40ms；场景标记显示上限 0.8（指尖距离/掌部尺度）。35 项测试与构建通过，Chrome 合成显示检查确认阈值边界、两手独立隐藏及恢复，未开启真实摄像头。

此前修订：右手物体控制保持天蓝色，左手捏合环绕相机并显示浅绿指尖/连线/中点，不提供角色交换。33 项测试通过；Chrome 合成帧通过真实 App→手势→控制→Three.js 场景链路，确认左手单独持续环绕、物体不变、双手配色和中点对齐、菜单时冻结及停止后隐藏。以下初版记录属于历史版本，真人验收仍待执行。

### 环境与可重复检查

Apple Silicon arm64 / macOS 26.3.1；Node 24.19.0；现有 Google Chrome 与现有浏览器测试工具。摄像头测试使用浏览器合成视频流，没有访问真实摄像头。

```sh
./scripts/run.sh test
./scripts/run.sh build
./scripts/run.sh resources
./scripts/run.sh dev
```

| 检查 | 结果与范围 |
| --- | --- |
| 合成单元/集成测试 | 19 项通过：捏合确认/迟滞、张掌、身份锁定、交叉歧义、操作手/辅助手丢失、单/双手中断隔离、映射/约束、撤销及跨场景状态 |
| TypeScript + 生产构建 | 通过；约 665KB 主脚本，Vite 提示大于 500KB，未据此宣称启动性能达标 |
| 模型/WASM/GLB | 本地资源 SHA-256、GLB 结构、依赖安装/锁文件版本、许可清单与计划文档存在性检查通过 |
| Chrome 页面与视觉 | 已加载房间、三件家具、界面；未开启摄像头；无页面/控制台错误 |
| 真实模型 Worker | 本地模块 WASM 与模型加载通过，黑色合成帧推理返回 0 手；首次冷推理约 328.5ms，该值不代表稳定推理频率 |
| 生产界面交互 | 13 项检查通过：默认不开摄像头、地板拖动/提交、撤销、旋转、高度、复位确认、XYZ 移动/鼠标深度、场景状态保留、暂停/恢复、左右手角色提示、摄像头生命周期、390px 布局、本地请求与无页面异常 |
| 仅本地资源运行 | 阻断非 localhost 请求后，生产页面资源加载、场景操作及真实模型推理通过；没有产生外部请求。物理断网尚未执行 |
| 合成摄像头性能 | Chrome 无头模式，短时合成视频测试界面显示 60 FPS / 22–23Hz，无错误；不能替代带真实双手的 15 分钟验收 |
| 停止摄像头 | 合成流所有 track 状态 ended，video.srcObject 为 null，Worker 停止 |
| Safari | 尚未执行 |

临时界面检查截图仅在系统临时目录，不写入 outputs，不含真实摄像头画面。浏览器测试不是新增项目依赖。

### 真人验收步骤与记录表

使用 Chrome 打开 localhost，允许摄像头，环境均匀照明。确认右手天蓝物体指针、左手浅绿视角指针；仅左手入画捏合可环绕，右手出画后左手不能接管物体；菜单只能由右手指向确认。记录摄像头型号、浏览器版本、照明、人与镜头距离及配置参数。

| 项目 | 方法 | 目标 | 当前结果 |
| --- | --- | --- | --- |
| 全手势闭环 | 只用菜单完成移动/旋转/高度/观察、撤销、场景切换、暂停/恢复与复位确认 | 每个入口可达 | 未执行 |
| 家具精度 | 指定 20 个地板坐标，松手后读 X/Z，与目标计算中心距离 | ≥18/20，误差 ≤0.10m | 未执行 |
| 旋转精度 | 指定 10 个 15°倍数角度，记录松手后角度 | ≥9/10，误差 ≤5° | 未执行 |
| XYZ 自然定位 | 复位，依次完成内置 20 目标；只用单手平面位移+掌尺度自然深度，不能用鼠标或分步高度代替 | ≥18/20，10s 内到达并保持 1s | 未执行 |
| 误操作 | 连续手势操作 5 分钟，手工记误抓取和误切换 | 总计 ≤1 次 | 未执行 |
| 恢复行为 | 抓取中依次遮挡、出画、交叉、拔/关摄像头；恢复时先保持捏合再释放 | 无跳变/错误接管/误提交 | 仅合成逻辑通过，真人未执行 |
| 性能/稳定性 | 连续 15 分钟，每分钟记录 FPS/Hz、卡顿、错误、内存与延迟；用外部观察记录动作到响应时间 | FPS 中位 ≥30，推理 ≥20Hz | 未执行 |
| 断网 | 依赖和资源准备后关闭网络，刷新 localhost，再开摄像头与两场景 | 完整运行 | 物理断网未执行 |
| Safari | 同样检查 WebGL2、模块 Worker/WASM、摄像头授权和释放 | 功能正常 | 未执行 |

XYZ 面板记录达到半径 0.10m 后保持 1s 的完成次数及 10s 内次数，记录只存在内存中。暂停/菜单时停止驻留判定，但目标计时包含等待时间；复位清空任务。家具误差需按目标与坐标另行计算。

### 已知限制

2026-10-09 界面增量检查：半透明天蓝色指尖点/连线/中点已通过 Chrome 合成关键点验证，两手显示正确，中点对齐误差低于 0.001 像素；叠加层不拦截菜单输入，手部丢失后隐藏。19 项测试和生产构建继续通过。摄像头预览同步突出指尖连线，真实摄像头仍待用户体验。

单目掌尺度是相对深度估计，非米制手部距离。手掌朝向、伸指姿态、出画与环境可能影响它；当前朝向检查及滤波不代表真人定位目标已达成。首帧冷推理可能被 250ms 过期保护丢弃；启动后等待稳定追踪再操作。无家具碰撞。撤销只恢复物体变换，不恢复相机或已完成目标记录；复位恢复布局和视角。

### 2026-10-10 · Mac mini 多客户端验收

真实跨设备摄像头验收尚未执行。详细记录表见 [macmini-test.md](#手势-mac-mini-远程识别测试2026-10-10)。本机合成协议/并发测试、空白图模型推理和 HTTPS 证书验证不代表 Mac mini 真人体验达标。

Mac mini 上 5 项后端测试及跨机器 HTTPS 校验通过，两条并发合成空白帧请求流各 5 帧成功（平均推理 16.2/14.9ms，平均往返 39.4/41.0ms）。未进行两台实体客户端摄像头操作，不视为真人验收。

## 手势接入 RoomCanvas 的双手操作更新（2026-10-23）

> 原 `gesture/docs/gesture-updates.md`。

对照基线：`origin/main` 的 `6daeb80`（2026-10-23）。从本地整合分支 `0565704` 抽取，原始本地手势核心与其一致；整合分支已采用主线的 `roomcanvas-gesture-v1` 协议名。本次只提交手势及必要编辑器接入。

| 项目 | 主线 RoomCanvas 编辑器 | 本次接入 |
| --- | --- | --- |
| 数字模式 | 1 移动、2 旋转、3 观察 | 1 移动、2 抬高、3 场景缩放、4 旋转；支持成圈的 3 |
| 双手分工 | 左手选择模式；右手移动或观察 | 左手独立环绕，右手操作家具，两手可同时进行 |
| 缩放 | 鼠标滚轮；编辑器没有双手缩放接入 | 双手间距驱动正交相机 zoom；缩放期间暂停环绕 |
| 家具高度 | 鼠标升降 | 右手升降；松手悬空，切移动后保持高度 |
| 放置确认 | 松手预览、短捏确认；换拿时可自动放好上一件 | 松手只暂停预览；竖拇指稳定约 500ms 或按钮／Enter 确认；换拿前先处理当前预览 |
| 旋转幅度 | 编辑器每画面 360° | 每画面 1080° 连续旋转 |
| 视觉反馈 | 编辑器右手圆点；手势页视频和左手识别文字 | 两入口镜像骨架、双手指尖／连线／中点、数字及拇指确认进度 |
| 连续操作 | 单一场景手势会话 | 分离左右手会话，缩放与环绕交接；转视角后重建右手抓取基准 |
| 误触保护 | 通用控件点击，无指定预览确认消息 | 排除隐藏／折叠／禁用控件；导出只接受鼠标或键盘；确认绑定预览、时间、会话、序号 |

### 哪些是原有基础

主线已包含本机 MediaPipe、捏合迟滞和滤波、释放首帧冻结、丢手保护、鼠标回退、碰撞／承托／重力／撤销。原 `gesture/index.html` 演示也已有部分双手控制和骨架；本次把本地完善的行为接入 RoomCanvas 的两种入口，不将这些基础重复列为新算法。

### 提交范围

- 识别层：数字 1–4、成圈的 3 与捏合区分、右手竖拇指确认、骨架反馈。
- 接入层：运行时、最小协议、内置摄像头与独立手势页。
- 编辑器：双手输入路由、预览暂停、相机 zoom、抬高／旋转、控制标记和误触保护。
- 对应测试、操作说明及重新生成的 `web/vendor/gesture/gesture-runtime.js`。识别模型、WASM、依赖版本未变。

不包含整站首页、登录、Google 配置、房间管理、品牌图片、旧演示删除、物体重建后端或仓库抽屉改版。原完整 UI 分支和 PR #24 保留；本次不修改它们。

自动化与合成输入能验证状态机、路由和消息约束；不能代替真人摄像头的手型准确率、镜像方向及长时间手感验收。

## 手势 Mac mini 远程识别测试（2026-10-10）

> 原 `gesture/docs/macmini-test.md`。

### 工作方式

每台电脑的浏览器调用自己的摄像头，将等比例缩小到不超过 640×480 的 JPEG 发到 Mac mini 的同源 `/api/detect`。Mac mini 用 MediaPipe Python CPU 模型计算关键点，浏览器保留手势判定、控制逻辑与 Three.js 渲染。各电脑的房间、撤销历史、手势状态互相独立，不同步家具布局。

默认仍是本机浏览器识别，不上传。Mac mini 启动链接预选远程模式，但只有用户点击“开启摄像头并发送画面”并授权摄像头后才发送画面。停止、切换模式、切换设备时取消在途请求。令牌只存在内存，刷新后需要重新打开启动链接。不录制、不保存画面或关键点，不输出请求日志。后端安装依赖时需要网络，运行时不调用第三方云服务。

后端使用 IMAGE 模式，每帧独立识别，无跨客户端视频追踪状态；与原浏览器 VIDEO 模式性能和稳定性可能不同，需要实测。默认两个独立模型实例，可以同时处理两路请求。超过并发上限返回 503，前端跳过当前帧继续尝试，不排队。并发数不是最大访问电脑数，也不是可保证的流畅设备数。可用 `--workers 1` 到 `--workers 8` 调整，增加实例会增加 CPU 与内存开销。

单客户端仅一个在途请求。沿用结果超过 250ms 丢弃、连续无有效结果超过 200ms 中断的规则；重获后松手再抓取。忙或断网不算放置确认。网络错误或请求超过 2 秒会停止摄像头，需要重新点击开启。跨设备通过客户端捕获时间计龄，不依赖两台电脑时钟一致。

### 安装与启动

已读到的测试目标：`ssh macmini`，Apple Silicon，局域网 IP `10.40.14.82`（2026-10-10；地址变化需要重新生成证书）。已保存完整工程到 `/Users/awhy/Desktop/3D视觉设计/手势家具布置演示`，使用已有 uv 0.12.22 安装 CPython 3.12.15 与锁定依赖；临时 HTTPS 测试服务已启动，默认两个实例，无开机启动配置。

以下命令在 Mac mini 的本工程目录执行。安装 Python 3.12 后创建工程内独立环境：

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock
```

若已有 uv，可改用：

```sh
uv venv --python 3.12 backend/.venv
uv pip sync --python backend/.venv/bin/python --require-hashes backend/requirements.lock
```

完整工程需 Node.js 22.12+，执行 `npm ci` 和 `./scripts/run.sh build`。使用打包的 `outputs/macmini-demo.tar.gz` 则已包含 dist，无需在 Mac mini 安装 Node 或重新构建。

生成含 Mac mini IP 的测试证书：

```sh
python3 scripts/create-test-cert.py 10.40.14.82
```

把 **仅 `backend/certs/ca.pem`** 复制到每台测试电脑并导入系统受信任根证书。Mac 在“钥匙串访问”导入并设置此测试 CA 为始终信任；Windows 导入“受信任的根证书颁发机构”；Firefox 如不使用系统信任，需导入其证书颁发机构。证书不受信任时先完成信任配置，不依赖忽略浏览器错误。浏览器摄像头要求安全上下文，普通 `http://10.40.14.82` 不适用。依据 [getUserMedia 文档](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。私钥 `ca-key.pem` 和 `server-key.pem` 留在 Mac mini，不复制到客户端。证书仅有效 30 天，测试结束可删除导入的测试 CA。

```sh
backend/.venv/bin/python backend/server.py \
  --host 0.0.0.0 --public-host 10.40.14.82 --port 8843 \
  --cert backend/certs/server.pem --key backend/certs/server-key.pem \
  --workers 2
```

终端输出含随机访问令牌的 HTTPS 链接。所有测试电脑在同一局域网内打开这条链接，点击开启按钮；允许 Mac mini 的 Python 接收局域网连接。`Ctrl+C` 停止后端，重启会更换令牌。服务是局域网原型，不配置公网转发。网页、模型接口均使用 8843，同源无需另开前端端口或配置 CORS。

### 本机验证

```sh
./scripts/run.sh test
./scripts/run.sh build
./scripts/run.sh resources
backend/.venv/bin/python -m unittest backend.test_server -v
```

不需要摄像头的本机运行：`backend/.venv/bin/python backend/server.py`，默认仅监听 127.0.0.1:8843，可通过终端输出的 localhost 链接验证网页与接口。本机浏览器模式仍可用原来的 `./scripts/run.sh dev`。

### 真实设备验收（待执行）

| 场景 | 记录 |
| --- | --- |
| 一台客户端：设备、浏览器、网络，30 秒推理耗时/往返/Hz、抓取和松开体验 | 待测 |
| 两台客户端同时：各自推理/往返/Hz，Mac mini CPU 与内存 | 待测 |
| 三台及以上：逐台增加，观察忙时丢帧和冻结；不同 workers 设置 | 待测 |
| 设备 A 摄像头/手势不能影响设备 B 家具 | 待测 |
| 拖动时断网或停止后端：立即冻结，不能提交，恢复后松手重抓 | 待测 |
| 改用本机模式不再向 /api/detect 上传；停止按钮释放摄像头 | 待测 |

合成协议测试和空白图推理只验证实现链路，不代表以上真人验收通过。

### 2026-10-10 · 跨机器合成检查

Mac mini 上 5 项后端测试通过，包括真实模型空白图。当前电脑使用测试 CA 验证 TLS，健康接口返回 200。从同一台电脑发出两条并发请求流，各发送 5 张 640×480 空白 JPEG：平均推理 16.2 / 14.9ms，平均往返 39.4 / 41.0ms。仅覆盖小样本无手图，不包含浏览器编码与真人识别，不用于宣称设备承载量或手势精度。

Chrome 无障碍树确认远程选择、发送画面提示和开启按钮；截图服务出现 ScreenCaptureKit 错误，本阶段未完成截图视觉检查。没有启用真人摄像头。每台测试电脑需导入测试 CA，再执行真人验收。

## ViewForge 与手势代码的历史整理（2026-10-17）

> 原 `object-reconstruction/docs/HISTORY_INTEGRATION.md`。

后续整合：本文件随 ViewForge `a93d457` 导入 RoomCanvas 的 `object-reconstruction/`，手势最终位于 RoomCanvas 的 `gesture/`。原提交的路径、哈希和时间均保留，下文描述的是原 ViewForge 仓库整理过程；当前目录及入口见 [RoomCanvas 整合说明](OBJECT_RECONSTRUCTION.md)。

整理日期：2026-10-17。实际 Git 仓库是服务器 `/workspace/geyinuo/ViewForge/code`，本机同步目录是工作区中的 `code/`。保留原 MV-SAM3D/ViewForge 历史，在 `codex/gesture-integration` 分支追加提交，不重写已有提交。

### ViewForge 阶段提交日期

此前功能长期保存在未提交的工作树中，本次按功能依赖拆分暂存快照；这些不是从旧提交恢复出的精确历史版本。作者时间和提交者时间按文件修改日期及进展记录推定，依据也写入各提交说明。

| 提交 | 日期（UTC+8） | 阶段 | 日期依据 |
| --- | --- | --- | --- |
| `149b7f8` | 2026-09-26 11:40:00 | 照片管理、补拍约束、重建进度与计时 | `run.py`、`import_photos.py`、画廊脚本及对应测试的修改日期 |
| `6caa997` | 2026-09-26 17:04:22 | 轻量 GLB 生成、原始模型尺寸测量与标定 API | 当日预览、尺寸模块及测试的修改日期 |
| `db6c480` | 2026-09-29 19:43:10 | 米制房间布局、全网格碰撞与自动承托后端 | 碰撞源码修改日期、工作区交接文件中的 9 月 29 日验收记录 |
| `693e5d8` | 2026-10-11 10:23:07 | 独立查看器的实尺显示及渐进加载 | `viewer.ts` 修改日期、10 月 11 日隐藏后台加载提示的验收记录 |
| `af791e0` | 2026-10-13 23:43:13 | 房间编辑及手势物体/相机控制接收端 | 手势接入记录、前端构建产物修改日期 |

同一文件跨越多个阶段时，只拆分必要的接口接线；不为补写历史虚构未曾保存的手势算法版本。目录迁移、便携入口和本次历史说明使用实际整理日期。

### 原手势历史

原来源仓库：`https://github.com/AWHYhuh/gesture-furniture-demo`，分支 `viewforge-integration`。以下五个提交以完整历史作为合并提交的另一条父链保留，原哈希、作者、作者时间和提交者时间均不变：

| 原提交 | 日期（UTC+8） | 内容 |
| --- | --- | --- |
| `b6b787afbe002933e4599dbfa6a7d673005a0812` | 2026-10-12 19:15:12 | 初版手势演示与本地识别 |
| `5d221ad50dd577dd9c6ab6aa8594f058fd3d7ea8` | 2026-10-12 19:15:51 | GitHub 同步记录 |
| `ee685b6e111bcbc11bdd50a1165d7b38b75e532f` | 2026-10-13 21:38:55 | 接入 ViewForge 右手移动和旋转 |
| `a992a65d91128df676078333037f99ee5caaf112` | 2026-10-13 21:42:56 | 左手模式与观察操作计划 |
| `32082a3bd54130873818d6f212ba59c672a12373` | 2026-10-13 23:51:21 | 左手检测、模式选择和观察手势 |

合并提交 `bc44718`（2026-10-17）把原手势树放到 `gesture-furniture-demo/`，原 ViewForge 根目录不被覆盖。之后单独提交路径适配和启动说明。旧提交中的文件路径仍然相对于原手势仓库根目录，可用 `git log 32082a3`、`git show <原提交>` 查看；并未改写为带子目录前缀的新提交。

2026-10-20 起，原 ViewForge 界面、房间布局和场景手势接收端已弃用，源码与原有产物保留在 `legacy/`；正式服务仅加载物体 API，重建、COVER、补拍命令行和尺寸标定保留，前端统一在 RoomCanvas。当前用法见 [物体重建说明](OBJECT_RECONSTRUCTION.md) 和 [RoomCanvas 手势接入](../gesture/docs/roomcanvas-integration.md)。上面的提交表仅记录历史。

### 验证与管理范围

- 对各阶段的暂存快照运行相关后端回归检查，并验证查看器及手势前端。
- 导入后核对原手势提交及原始源码树，最终核对工作树内容和运行入口。
- 运行环境、依赖目录、模型重建权重、照片、历史重建结果和本机密钥不纳入新增提交；手势项目已随源码提供的 MediaPipe 模型和 WASM 资源保留。
- 本次只提交，不推送到现有 `upstream`（原 MV-SAM3D 仓库）。后续推送应使用用户自己的目标仓库。

## ViewForge 原运行说明与部署验收（2026-09 – 10）

> 原 `object-reconstruction/docs/VIEWFORGE_RUNTIME.md`。

当前职责（2026-10-20）：只提供物体 API，使用 Starlette / Uvicorn，不加载 Gradio。前端、坐标轴、场景与手势统一在 RoomCanvas。原界面与查看器已弃用并保留于 `legacy/`，不要使用本文件历史段落中的界面操作作为当前启动说明。运行环境先安装 `python -m pip install -r configs/api-requirements.txt`，再按原参数运行 `python scripts/web.py --host <地址> --port 7862`。

RoomCanvas 整合说明：本模块现位于 `object-reconstruction/`，从该目录执行下面的相对启动命令；手势入口位于 RoomCanvas 的 `gesture/`。环境、权重和数据仍由 `VIEWFORGE_ROOT` 配置。下文的独立 `code/`、`upstream` 远程和旧部署路径属于原 ViewForge 运行记录，当前目录与历史保留方式以 [整合说明](OBJECT_RECONSTRUCTION.md) 为准。

`code/` 是保留上游历史的 MV-SAM3D 仓库。`upstream` 指向原作者仓库，当前部署基于 `abb04b5`；尚未创建 GitHub 账号下的远程 fork。

```bash
source configs/local.env
bash scripts/launch.sh --object stuffed_toy --attempt a02 --check
bash scripts/launch.sh --object stuffed_toy --attempt a02
```

本机设置从 `configs/local.env.example` 复制并填写，必须显式加载，且不纳入 Git。`VIEWFORGE_ROOT` 指向外部存储根目录；环境为 `envs/mvsam3d`，`CUDA_VISIBLE_DEVICES` 指定获授权的一张 GPU。`VIEWFORGE_GPU_LOCK` 与其他使用该卡的应用共用。容器无 tzdata 时可用 `TZ=CST-8` 表示 UTC+8。

输入为 `data/inputs/<物体>/images/` 和相邻 `masks/`。支持 `.png`/`.jpg`；对应掩码如 `1.png` 或 `1_mask.png`，须唯一、尺寸一致、RGBA alpha 非空。允许单视角；其实际推理行为由上游处理。

`--config <yaml>` 替换默认配置。`mv` 字段直接传给上游 `run_weighted_inference`：50/25 步与 entropy 仅是默认值，不强制禁止其他融合选项。上游不支持的参数会直接报错，不静默忽略。

每次新建 `runs/<日期>_<物体>_<attempt>/`，拒绝覆盖；保留 `config.yaml`、`inputs.json`、`result.json`、`da3/`、`reconstruction/` 和 `logs/`。运行 DA3 与重建，输出 GLB 网格和 Gaussian PLY；查看结果可使用上游可视化工具。

常规重建不提供逐阶段性能基准、显存采样、日志文字融合验收及重复结果快照。历史测量结果和旧运行不受影响。

维护与检查：

```bash
source configs/local.env
source scripts/env.sh
python -m unittest discover -s tests -v
git diff upstream/main -- sam3d_objects run_inference.py run_inference_weighted.py
```

核心算法源码未修改。DA3 原生脚本仅增加外部路径适配；MV 本地入口仅生成本地权重配置并重定向输出目录。数据、权重、环境、缓存和运行结果均在 checkout 外。上游历史中的公开样例媒体保留，本机 sparse checkout 不展开 `data/`。

旧包装仓库及旧源码归档于 `logs/setup/upstream-repo-20260913/`；历史提交和实验记录不改写。

### 历史网页记录（已弃用，仅供追溯）

在 code 目录执行：

```bash
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 172.18.0.2 --port 7862
```

当前容器地址为 `172.18.0.2`（重建容器后用 `hostname -I` 核对），网页监听该内网地址。通过容器 SSH 别名转发网页端口：

```bash
ssh -C -N -o IPQoS=none -o ServerAliveInterval=15 -L 127.0.0.1:7865:172.18.0.2:7862 3090x2-docker
```

本机访问 http://127.0.0.1:7865 。没有开启 Gradio 公网分享；关闭 SSH 连接会断开本机访问。默认 `--host` 仍为 `127.0.0.1`，可用于其他机器的回环部署。

从 `data/inputs/<物体>/images` 选择照片，先点“准备预览”，确认选区后再点“开始重建”；每次运行的 `input/` 只链接选中照片与掩码，DA3 和 MV 使用相同视角。CLI 也可用 `--images 1 3 5 7` 指定文件名（不含扩展名）。网页重建串行执行，完成后默认使用 `<model-viewer>` 查看 GLB 网格，支持拖动旋转和缩放；切换到 Gaussian 时才向上游同款 `gr.Model3D` 加载 PLY。两种模式均在本地浏览器渲染，重建仍在服务器执行。支持重新打开已有结果。网页只展示运行状态，不显示日志或模型下载入口；文件和日志仍保存在服务器运行目录中。查看器脚本随 `scripts/assets/` 本地提供。


### BiRefNet 自动 mask

首版只处理现有输入目录中的照片。即使还没有 `masks/`，物体及其照片也可选择和预览。网页“准备预览”检查所选照片：唯一有效的 mask 原样复用，缺失项由官方 `ZhengPeng7/BiRefNet` 补齐。画廊以缩小副本显示半透明绿色前景，确认后“开始重建”。改变物体或照片会撤销确认；正在准备的旧选择也不能恢复确认或启动重建。

首次部署（与重建环境完全隔离）：

```bash
source configs/local.env
bash scripts/setup_birefnet.sh
```

模型 revision 固定在 `configs/birefnet.json`，当前为 `e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4`。环境为 `$VIEWFORGE_ROOT/envs/birefnet`；官方代码与权重在 `$VIEWFORGE_ROOT/weights/birefnet`，下载来源记录为其中的 `viewforge_revision.json`。正常推理只从本地加载，不访问模型服务。服务器不能访问 Hugging Face 时，可在联网机器下载此 revision 对应的 snapshot，并将完整文件和 revision 记录传到上述目录。

独立准备入口使用已有运行环境启动协调进程，按需调用独立 BiRefNet Python：

```bash
source configs/local.env
source scripts/env.sh
python scripts/prepare_masks.py --object stuffed_toy --images 1 3 5 7
# 审查选区之后，CLI 重建仍会严格检查所有 mask：
bash scripts/launch.sh --object stuffed_toy --images 1 3 5 7 --attempt a03
```

推理逐张执行：1024×1024、FP16、batch size 1、eval/no_grad、ImageNet mean/std，最后一级预测 sigmoid；float 概率图以 bicubic 恢复原图尺寸后按 >=0.5 二值化。输出 `masks/<照片名>.png` 为原图尺寸 RGBA，RGB 来自原图，alpha 仅为 0/255；不应用 EXIF 旋转、不裁剪、不选最大连通区域。二值 alpha 与上游 `notebook/inference.py::load_mask` 的 `alpha > 0` 前景判定兼容。

继续匹配 `<照片名>.png`、`<照片名>_mask.png`、`.jpg` 和 `_mask.jpg`。已有 mask 必须可读取、RGBA、同尺寸且 alpha 非空；多个匹配、坏文件、尺寸不符会报错，原文件不被覆盖。空预测或推理失败停止准备，成功写出的 mask 保留供下次复用。CLI 重建入口不会自动补 mask，避免绕过校验。

全部 mask 已存在时只做 CPU 检查和预览，既不加载模型也不获取 GPU 锁。缺失项在与重建相同的 `VIEWFORGE_GPU_LOCK` 下生成，沿用一张已配置 GPU 及默认空闲显存检查。一次模型加载处理全部缺失项，子进程退出后释放 GPU，再等待用户确认。网页的两个阶段共用串行队列。重建仍使用 seed 42、DA3 504、MV 50/25 默认配置。

每次准备的简短记录和推理日志在 `$VIEWFORGE_ROOT/logs/masks/<任务>/`，记录固定 revision、推理配置、复用/生成清单、耗时及结果状态。显示用缩略图在 `cache/mask_previews/<任务>/`。网页不增加日志区、下载入口、上传、参数或编辑器。


#### 2026-09-13 部署验收

环境为独立 Python / torch 2.5.1+cu124 / torchvision 0.20.1 / transformers 4.48.3，`pip check` 通过。安装使用运行根目录缓存；cuDNN 9.1.0.70 从已有环境复制为独立副本，原环境保持不变。完整版本与安装日志见 `logs/birefnet-environment.txt`、`logs/birefnet-setup-final.log`。

使用独立物体 `birefnet_toy_20260913`，只链接 `stuffed_toy` 的 1、3、5、7 原图，最初没有 masks 目录。通过网页实际生成四张 mask：完整准备 45.311 秒；独立分割进程 30.751 秒（含 5.141 秒模型加载、图像读写），四张分别为 7.424 / 5.831 / 6.477 / 5.876 秒。200 ms 整卡采样峰值 2,680 MiB，开始和退出后均为 2 MiB；PyTorch 峰值 allocated 1,613.64 MiB / reserved 2,356 MiB。这里的整卡采样与 PyTorch 统计是不同指标。

四张输出均为 4096×3072 RGBA，保留原 RGB，alpha 仅 0/255；实际导入并调用上游 `notebook/inference.py::load_mask`，四张前景均与生成 alpha 完全一致。逐张检查缩略预览，玩偶主体被选中。这是自动 mask 流程验收，不代表复杂背景分割准确性评测。

分割记录：`logs/masks/20260913_160457_5dcf8dff/`；整卡采样：`logs/mask-gpu-20260913.csv`；下游回读检查：`logs/mask-loader-validation-20260913.json`。原物体 8 张已有 mask 的网页准备也已通过：复用 8、生成 0，17.015 秒，无模型进程与 GPU 使用。针对性及现有测试共 20 项通过，结果见 `logs/mask-tests-20260913.log`。


使用本次生成的 mask 从网页完成四图重建，运行名为 `20260913_birefnet_toy_20260913_web_160718_690463`。DA3 和 MV 阶段退出码均为 0，服务器重建约 281.23 秒（从保存配置到完成结果）；新 GLB 19,374,632 字节、Gaussian PLY 52,341,920 字节。默认 GLB 已在原网页实际加载，鼠标拖动后相机方位和可见视角均改变。验收在本次提交前工作区运行，运行记录中的 Git 起点为 `595a280`；重建核心、seed 42、DA3 504、MV 50/25 配置未改。

再次改变选择再回到同组四图，确认按钮先恢复“准备预览”；重新准备复用 4、生成 0，用时 10.228 秒，未进入模型/GPU路径，生成 mask 的大小及 mtime 均未改变。记录为 `logs/masks/20260913_161445_629dc28e/`。

另建独立物体 `birefnet_partial_20260913`，四张原图只作链接，并复制本次输出的 1、5 为 `_mask.png` 形式。真实准备复用 1、5，仅生成 3、7，共 38.542 秒；两张已有 mask 的大小和 mtime 未改变。记录为 `logs/masks/20260913_161310_9d2bedad/`。原 `stuffed_toy` 的全部照片和 mask 的大小及 mtime 与首轮准备记录一致，最终两张 GPU 均回到 2 MiB。


项目运行根目录已于 2026-09-13 统一为 `/workspace/geyinuo/ViewForge`，网页标题为 ViewForge（物体重建）。目录用途见 [项目目录](../object-reconstruction/docs/DIRECTORY_LAYOUT.md)。原路径 `/workspace/geyinuo/viewforge-mvsam3d` 保留为指向 `ViewForge` 的兼容软链接，用于已有环境入口、历史记录和符号链接；历史结果内容未批量改写。2026-10-27 起运行根目录并入 RoomCanvas 服务器文件夹的 `runtime/object-reconstruction/`（`/workspace/geyinuo/ViewForge` 暂留为指向它的软链接，`viewforge-mvsam3d` 早已不存在），本文以上记录里的旧路径保持原样。
