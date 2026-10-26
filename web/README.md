# web/

RoomCanvas 的网页：主页（`index.html`）列出房间，点进布置页（`editor/`）。

布置页是浏览器里的家具布置编辑器：选中家具，移动、旋转、升降、换墙、收进仓库再放回，带逐三角面的碰撞和支撑面检测，可撤销，布局存在浏览器里并能导入导出 JSON。纯前端，Three.js r180（`vendor/`，与 npm `three@0.180.0` 逐字节相同），没有构建步骤。

## 一个房间需要什么

房间目录里放两个文件：

- `Room.glb`：重建结果；
- `room_objects.json`：物体清单，用 `scripts/room_objects.py` 从重建的 `room_layout.json` 生成。

清单里记录每个物体是房间结构、门窗、固定设施（插座、灯、窗帘、暖气片等，留在房间里），还是可移动家具，以及哪些东西要一起移动（桌子连同桌上的东西、书架连同书）、挂在哪面墙上、上面哪些部件能放东西。小物件那一步用 TRELLIS 重建的物件（`room_layout.json` 里标了 `rebuilt`）单独成组，可以单独移动；它放在家具上时，家具移动会带着它走。家具名默认按类别自动起（“柜子 1”）；在 `groups` 里给某组加 `"name": "钢琴"` 就用手写的名字，重新生成时会保留。

能开合的部件（柜门、房门、窗扇、升降桌）也记在清单的 `joints` 里：`room_objects.py` 读重建结果里每件物体的 `sim/<物体>.urdf`（默认在 `room_preview` 旁边的 `../room/Objects`，别处用 `--joints <目录>`），只保留在 `Room.glb` 里能对上的：部件是单独一个节点，它的原点正好在关节上，自身不带旋转和缩放；对不上的会打印原因并跳过。

编辑器打开房间时还会自动处理几件事：从椅子网格里找座面；把墙角的短墙连到两侧长墙上，近侧墙变淡时一起变淡；把没记录墙的窗帘归到它前面的墙。

靠镜头一侧的墙（背面朝着镜头或几乎侧对着镜头的墙）不隐藏，而是变成半透明（不透明度 0.16），墙上的门窗、插座、窗帘、挂画一起变淡。比 1.6 米高的家具（衣柜、书架、白板）背靠近侧墙、或站在房间靠镜头的那一半时也变淡，免得像柱子一样挡在前面；转动视角时有 10 厘米的缓冲，不会在中线附近来回闪。变淡的东西不投影，点选和手势都穿过它点到后面的东西；正在摆放的那件始终是实心的（从仓库卡片选中半透明的衣柜即可）。“更多工具”里的“近侧墙半透明”可以关掉，关掉后所有墙都正常显示。勾上旁边的“隐藏近侧墙”，近侧墙连同墙上的门窗、窗帘、挂画、吊柜、搁板完全看不见（不透明度 0，仍按半透明的规则处理光照和点选，所以隐藏后不会有阳光照进来）；靠墙站着的高家具照旧半透明。勾上“隐藏”时“半透明”那一项不起作用、变灰。碰撞、承托检查不受影响。

主页上的房间写在 `rooms.json` 里（`id`、名字、目录、一句介绍），卡片上的家具数和模型大小直接读房间文件，缩略图是房间目录里的 `thumbnail.jpg`（`scripts/thumbnail.py` 从编辑器整体视角截图生成，需 Playwright 和 Pillow）。加房间就是在 `rooms.json` 加一行、生成缩略图。

打开方式：主页的房间是 `editor/?room=<id>`；其他房间目录用 `editor/?scene=<房间目录相对 editor/ 的路径>`，例如 `editor/?scene=../../samples/room3`。要放到仓库外的某个房间目录旁边，用 `python3 web/scripts/publish.py --scene-dir <房间目录>`。

配色和字体在 `theme.css`（`--rc-*`），主页和编辑器共用。

## 通用光影增强

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

### 时段与调色实验

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

### 光影调研

原 `docs/LIGHTING_RESEARCH.md`（lyk，2026-10-19）：RoomCanvas 光影改进调研与接入任务。

调研与实现日期：2026-10-19。基线：`main@7b4377b`。当前分支已完成可重放画面、整帧 CPU/GPU 计时、通用光源校准、可回退导入 PBR 实验以及 GTAO / N8AO 的首轮对照，操作说明见 [web/README.md](#通用光影增强)。下面区分已测结果与未验收边界；烘焙 GI 不在当前范围。

#### 1. 当前优先级、已实现范围与下一步

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

#### 2. 调研基线的代码与资产情况

##### 2.1 渲染基础

以下来自本仓库代码检查，入口为 [scene-editor.js](editor/scene-editor.js)、[编辑器 import map](editor/index.html)、[发布脚本](scripts/publish.py)。

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

##### 2.2 资产检查

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

**导入物体的旧路径有明确缺口。** 基线中的 `importRun()` 无条件换成 Basic 材质，不保留原贴图／PBR，也未设置 receiveShadow。Basic 可以参与投影，但不会因直接光重新着色，不自动使用 `scene.environment` 的 PBR 受光路径；被 AO 压暗不等于正确受光。本轮将此显示保留为默认／回退，增加独立的受光实验，原有 PBR 与贴图不再在实验路径中被丢弃。[当前导入逻辑](editor/scene-editor.js)、[材质 adapter](editor/import-materials.mjs)、[Three.js Basic 材质说明](https://threejs.org/docs/pages/MeshBasicMaterial.html)、[Standard 材质说明](https://threejs.org/docs/pages/MeshStandardMaterial.html)

验收用同一件合成 unlit 顶点色物体，经真实导入、摆放、确认后比较：原显示的中心区域亮度在开灯／关灯下均为 192；PBR 约为 173.82 / 0；切回原显示又恢复 192 / 192。缺失法线已补齐，碰撞代理未修改。已有 Physical 参数、贴图与共享几何的保留另有单测。当前真实物体目录返回 0 项，不能把合成实验当作真实重建颜色已完全适配；因此保留默认关闭，不批量重建粗糙度／金属贴图。

##### 2.3 几种“更真实”不能混为一谈

- **动态阴影**：某个光源被物体挡住形成的投影。
- **AO**：近邻几何的遮蔽和接触暗部；只使某些区域变暗，不产生真实反弹光。
- **IBL / 环境贴图**：给材质提供环境受光和反射；单张环境贴图不自动产生局部遮挡、窗户日照或多次反弹。
- **GI**：间接光、色彩反弹和更合理的室内明暗层次；可通过烘焙、屏幕空间近似或路径追踪实现，限制不同。
- **色调映射**：把 HDR 亮度显示到屏幕；不能修复错误光源方向或缺失的阴影。

#### 3. 前端直接接入或小范围适配的候选

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

#### 4. 离线加工或静止高质量预览候选

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

#### 5. 不够轻或不直接匹配，但值得保留的候选

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

#### 6. 版本、许可与维护快照

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

#### 7. 怎样保持和现有任务低耦合

##### 7.1 接入边界

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

##### 7.2 统一配置与文档连接

当前 P0–P2 使用统一默认参数和测试档位，不增加逐房间必填配置，不按房间名称调整光源。若未来确需记录真实朝向或光照资产，再讨论可选 `lighting.json`，独立于 `room_objects.json` 和布局存档；以下只是后续候选字段：

- schemaVersion、适用模型指纹和坐标约定；
- 主光方向/强度/色温、填充光强度、曝光与 tone mapping；
- 可选环境图及旋转；
- AO、阴影、效果质量档；
- 导入物体材质策略；
- 可选静态 lightmap / 探针数据及稳定节点映射。

没有该文件时始终使用统一默认效果，不给旧房间增加必填项。不凭空推断房间真实朝向、太阳时间或窗外环境；当前也不实施窗户驱动的逐房间配光。

将最终用户操作写入 [web/README.md](#通用光影增强)，资产契约写入 [ROOM_RECONSTRUCTION.md](../docs/ROOM_RECONSTRUCTION.md)，导入材质策略写入 [OBJECT_RECONSTRUCTION.md](../docs/OBJECT_RECONSTRUCTION.md)。本调研记录方案取舍、来源和待验证项目，避免把研究假设写成已经上线的能力。

##### 7.3 必须验证的相互作用

1. **剖墙**：编辑模式的隐藏墙和物理预览的遮挡墙分别处理；若需代理遮挡物，只用于视觉计算，不加入原碰撞/选择目录。
2. **虚影和手指指示**：避免把半透明候选、地面指示、轮廓渲染进错误的 AO/反射。可用视觉层或最后单独绘制；库的排除功能也需要算性能成本。
3. **阴影更新**：移动家具、落下动画、导入、清空/还原、开门及显隐变化都标记失效。不能只监听相机，也不能把按需渲染无条件变成常开循环。
4. **时域历史**：相机和物体变化都应重置；N8AO 的静态累积不会自动发现所有物体运动。SSGI/渐进阴影/路径追踪需要各自的收敛预算。
5. **色彩**：保持 GLTFLoader 对颜色贴图和数据贴图的处理；法线、粗糙度、金属度贴图不能统一改成 sRGB。原生与第三方 composer 的 tone mapping / gamma 约定分别核验。
6. **材质还原**：选择、高亮、虚影、导入与光影适配都可能改材料。保存并恢复原材质，避免改动共享材质影响其他物体。
7. **烘焙**：静态壳体与动态家具分离；生成 UV 时保留稳定映射，不依赖每次加载都会变化的 runtime UUID，也不改变关节引用节点。

#### 8. 可以独立承担的任务清单

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

#### 9. 实验与验收方法

##### 9.1 场景矩阵

至少覆盖：room3 全景、钢琴与琴凳近距离接触、床上枕头、书架层板、office 桌底、金属部件、一件 ViewForge 导入物体、柜门开合。每项比较静止、相机移动、家具拖动、松手、清空/还原、剖墙/天花板显隐。

每次只改变一个候选效果，保留原始、灯光校准、IBL、AO、软阴影和组合的结果。记录所有质量参数，不能把不同曝光、不同 DPR 或不同截图时刻混在一起比较。

##### 9.2 性能指标

- 明确本机型号、浏览器、硬件加速状态、画布尺寸和 DPR；编辑器与 MediaPipe 同时运行。
- 分别记录首帧/加载成本、稳定帧 GPU 时间、主线程时间、p50/p95 帧耗、交互响应及内存/显存估计。
- 记录停止交互后的收敛帧数和时间，静止后是否停止请求帧；关闭摄像头时不应继续保留无用推理。
- 记录新增本地资源的实际压缩后体积、传递依赖和网络请求。npm 包压缩包大小不等于最终网页 bundle 大小。
- 在目标 Mac 上先以 30 FPS 的 33.3 ms 总帧预算作保底评估，再评估 60 FPS；这是建议验收目标，不是已测表现。超预算时降低效果分辨率、阴影质量或回到基础档。

本调研没有把上游 demo 的毫秒数、加速倍数或截图效果当成本项目结论。

##### 9.2.1 P0 验收标准与当前边界

1. 固定模型版本、浏览器／渲染设备、画布尺寸、DPR、完整相机姿态／缩放／投影、布局、灯光状态、墙体与天花板显隐。统一无选中、无预览、无临时高亮，保存可重放配置；截图前等待静态增强真正完成。
2. 两个房间均保存整体画面，以及墙角、家具接触、深色光滑表面、床面／柜面伪影近景；再加入同一件导入物体的原显示和 PBR 版本。区域规则按材质／用途选择，不以房间名称写渲染补丁。
3. 拆分原始、仅环境、仅 AO、仅阴影与组合。当前 `lighting=off` 为完整原始；`ao=off&shadows=original` 为仅环境；`env=off&shadows=original` 为仅 AO；`env=off&ao=off` 为仅阴影。固定光照参数再比较算法，曝光不能一起变化。
4. 性能分别记录静止、有限时长的同轨迹视角移动／家具移动、停止后的补算；记录完整帧 CPU 提交耗时、GPU 时间（扩展可用时）、p50/p95、绘制调用、三角形、纹理／目标缓冲分配估计。手势关闭与识别开启分开测；扩展不支持的 GPU 指标明确记为不可用，不能用 CPU 时间替代。
5. 已修复先前 `renderCalls=1` 只反映末个全屏 pass 的问题：统一禁用自动逐 pass 重置，在交互／静态 AO／截图各阶段开始时重置并汇总全部绘制，输出带阶段标签的数据。`performance.now()` 只记录 CPU 提交；GPU 使用异步 query，不可用／disjoint 结果不会被伪装成零耗时。静止时不永久开动画循环。
6. 输出固定截图、配置和性能结果，对比是否改善白墙层次、深色材质反射、接触关系、导入物体受光与可见伪影。像素差异只能证明画面变化；真实性需参考照片或明确的物理／视觉判断，不能仅以“变化更大”验收。

本轮已实现上述基线的核心部分并记录两场景对照。真人手势、更多设备、真实新增物体、实际显存字节数和用户截图视角仍是后续验收项；单测数量不能替代这些结论。

##### 9.3 与现有检查连接

实现后先运行已有网页单测、Python 检查和真实模型检查；针对新增 adapter，只补有意义的失效、资源释放和配置回退测试。光影正确性仍需要固定相机截图和真人手势操作验证，单测不能证明视觉提升。

```bash
node --test 'web/editor/tests/*.mjs'
python3 -m unittest discover -s web/scripts
node web/scripts/check_room.mjs --scene-dir samples/room3
node web/scripts/check_room.mjs --scene-dir samples/office
```

已有离线网页入口为 `python3 web/scripts/serve.py`。第一轮光影实验可在此入口完成，不需要建立新的端口映射、模型服务或付费 API。

##### 9.4 第一版基础实现验证（2026-10-19，历史记录）

已按 1–3 的基础范围接入通用环境、静态 AO 与原生阴影校准，未接入表中其余候选：

- 前端单测 **157/157**，Python 检查 **12/12**；编辑器与脚本的 28 个 JS/MJS 模块语法检查通过。
- 真实模型检查：room3 **23/23**、office **18/18**。原有模型交叠提示仍保留，没有改几何或布局。
- 本机 Chrome 无头浏览器分别打开两个房间，比较默认增强与 `lighting=off`，确认三盏灯的类型、位置、强度一致；检查静止不再补算、视角保持拖动时暂停、松手后更新、暖光切换和窗口缩放。
- 实际选择办公室家具并操作移动摇杆，保持期间 AO 补算次数维持 2，松手后变为 3。此检查验证调度，不代表 GPU 帧耗测量。
- 人为阻断 GTAO 插件加载，编辑器仍能读取房间与物体，通用环境继续可用；新建及再次发布预览能更新插件和编辑器模块。

本机 Python 3.12 默认静态服务队列太小时，浏览器并行导入模块曾出现连接重置；扩大请求队列后完成上述浏览器检查。已有 `serve.py` 进程需重启才能采用此项修复。真人手势操作、GPU 时间与显存实测仍待后续验收，不能据此宣称达到特定 FPS 或真实全局光照。

##### 9.5 本轮 P0–P2 实现与测量（2026-10-19）

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

## 开门、开柜门

切到“预览”，点门、柜门、窗就打开，再点关上（约 0.45 秒的动画）；鼠标移到能开的部件上变成手形，旁边提示是什么、点一下会怎样（如“抽屉 · 点击关上”）。柜体是按扫描尺寸拉伸过的（不均匀缩放），所以门按世界里的合页线整块转动，不在拉伸过的柜体坐标里转，不会变形；推拉的部件沿自己的轴移动。放在部件上的东西跟着一起动：升降桌升起时桌上的显示器、键盘、杯子一起升，钢琴顶盖掀起时上面的谱子跟着转。重建结果只记了它们“放在桌子上”，没记放在哪个部件上，所以打开房间时按形状找：同一组里底部正好压在这个部件上的（从底部往下 6 厘米内碰到它）；叠在一起的（书压在谱子上）跟着下面那件走。回到“布置”时全部关上，摆放和碰撞检查都按关着的样子算。打开的状态不保存。变淡的近侧墙上的门、被窗帘挡着的窗点不到，转个视角就行。

示例房间里 room3 有 8 个（衣柜和柜子的 6 扇门、房门、一扇推拉窗），office 有 4 个（房门、两扇平开窗、升降桌）。office 办公桌的抽屉在重建里只是面板，没有滑轨，打不开。

## 漫游

切到顶部“漫游”，以第一人称在房间里走（眼睛离地 1.6 米）。拖动画面转头（上下左右），WASD 或方向键走动，按住 Shift 快走，Q / E 升高、降低视线（离地 0.5–2.2 米），Esc 回到进入漫游前的模式。不锁定鼠标：锁定会让浏览器在顶部弹出提示，而且 Esc 第一下只是放开鼠标。鼠标移到门、柜门、抽屉、窗上变成手形，旁边提示是什么、点一下会怎样（如“柜门 · 点击打开”），点一下开关，和“预览”一样。

身体按半径 0.25 米的圆柱算：沿走动方向，从身体中间和左右两边、在离地 0.3 / 0.9 / 1.45 米三个高度各打一条射线，碰到墙和家具就停下，贴着它滑过去；门洞、窗洞外由地板的范围挡住。起点是房间中间，被家具占着就往外一圈圈找空地，朝向最空旷的方向；离开再回来接着上次的位置。漫游时墙和高家具都不变半透明，天花板显示出来，手势和布置工具收起；切回“布置”后还原。代码在 `editor/walk.mjs`。

## 手势和导入物体

`scripts/serve.py` 在仓库根目录起网页服务，同时把 `/viewforge/assets/` 下的读请求（物体目录、尺寸、模型）和“添加物体”用的 `/viewforge/objects/`（上传、抠图、重建、进度）、`/viewforge/dimensions/<结果>`（保存实测尺寸）转给 ViewForge 服务器（默认 SSH 隧道 `127.0.0.1:7865`）。只转这几类地址，写请求只接受本页发出的。

- **仓库抽屉**：默认完全收起，不占用底部空间；使用顶部工具栏“仓库”按钮展开或收起，也可通过关闭按钮或 Esc 收起。卡片按网格排列，内容多时在抽屉内滚动。开合不改变场景画布大小与相机取景。选中卡片开始摆放、切到预览或手势“仅观察”时自动收起；按 `/` 展开并搜索家具。手势可捏合“仓库”按钮，再从卡片拖出家具。

- **手势**：点击工具栏“手势”开启本机摄像头。左手 1/2/3/4 切换移动／抬高／场景缩放／旋转；数字 3 支持拇食指成圈、另外三指伸出，选中后先松手再抓取。左手捏合可独立环绕，右手捏住家具或仓库卡片操作。松手保留预览，右手竖拇指约 0.5 秒、放置按钮或 Enter 确认，碰撞与落下规则不变；轻捏和换拿家具不再自动确认。双手捏合拉开／靠近缩放场景，旋转模式横扫画面对应 1080°。摄像头显示镜像骨架，场景显示双手指尖、连线及中点；丢手冻结、恢复后松手重抓。导出布局只接受鼠标／键盘。完整操作、协议和限制见 [手势接入](../gesture/docs/roomcanvas-integration.md)。
- **导入物体**：工具栏“导入物体”列出 ViewForge 的重建结果；在物体服务里保存过标定的自动填好尺寸，没标定的填一条实测边长（使用物体重建服务的同一份标定基准）。显示用完整模型，碰撞和支撑用它的轻量预览（同一坐标，三角面约 1/40）。导入后放在离房间中心最近的空地上，再用手势或鼠标摆放。导入要重建碰撞索引，room3 约 10 秒。
- **添加物体**（仓库展开后的第一张卡片；服务不可用时提示重试）：用照片新建物体，分四步——命名、拖入照片（1–40 张 JPEG/PNG，1 张也能重建，绕物体多拍几个角度效果更好；浏览器能解码的 HEIC 先转成 JPEG）→ 抠图预览（BiRefNet，绿色是识别出的物体，点一张可以不用它，至少留 1 张）→ 重建（DA3 深度 + MV-SAM3D，一般 3–8 分钟，GPU 被占时排队）→ 看结果、填一条实测边长 → 放进房间（之后同“导入物体”）。重建在服务器上跑，关掉对话框或刷新页面都不影响，卡片上显示进度，刷新后按 localStorage 里记的任务继续跟踪（服务重启过就跟不上了，结果照样会出现在“导入物体”里）。照片、抠图、结果和尺寸都保存在原有物体数据目录；正式服务已与旧界面解耦，不需要启动 Gradio 或 Babylon 查看器。旧界面源码归档于 `object-reconstruction/legacy/`。

- **补拍**：重建结果那一步会显示 COVER 算出的补拍建议——模型旁一支橙色箭头指向建议补拍的方向，“看推荐角度”把预览相机移到推荐的位置和视角（再点回到整体）。点“补拍”上传新照片（不用再起名），原来的照片全部保留（抠图那一步灰色虚线框，不能去掉、抠图直接复用），只给新照片抠图，然后在原结果基础上重建（`run.py --parent-run`），出来的是一个新结果，原结果不动。“不补拍了”回到原结果。已经重建过的物体也能补拍：“导入物体”里选中它，点“补拍”。旧结果没有补拍建议（没有 `cover/preview.json`）时照样能补拍。

重建结果的尺寸预览显示红色 X（宽）、绿色 Y（深）、蓝色 Z（高）箭头，点击轴标签可以选择实测方向；轴与标定使用同一显示坐标，旋转视角时标签跟随。

导入物体的仓库卡片右上角有删除按钮：只删除当前房间中的这一份实例，另一份重复导入和服务器重建结果保留，可从“导入物体”重新添加。原房间家具不提供这个删除入口。删除会清理已释放实例的历史引用，其他操作仍可撤销/重做；当前正在操作另一件家具时需先结束操作。

## 文件

| 位置 | 内容 |
|---|---|
| `index.html`、`rooms.json` | 主页和它列出的房间 |
| `theme.css`、`icon.svg` | 共用配色、字体和图标 |
| `editor/scene-editor.js` | 主程序：加载房间、选择、视角、仓库栏、放置流程 |
| `editor/warehouse-drawer.mjs` | 仓库面板开合与键盘操作 |
| `editor/static-lighting.mjs`、`settled-render.mjs` | 静态接触暗部、停止操作后的按需补算 |
| `editor/lighting-composite.mjs` | 交互／静态共用的透明混合、MSAA 与最终颜色输出 |
| `editor/time-lighting.mjs`、`color-grading.mjs`、`lighting-panel.mjs` | 时段光源／夜间衰减、四项调色参数与实验面板 |
| `editor/environment-lighting.mjs`、`lighting-settings.mjs` | 一次生成的通用环境反射、房间范围与阴影像素尺寸的自动校准 |
| `editor/lighting-profiles.mjs`、`render-metrics.mjs` | 通用光照档位、完整渲染帧的 CPU/GPU 与绘制统计 |
| `editor/import-materials.mjs` | 导入物体受光实验与原显示回退 |
| `editor/room-catalog.mjs` | 读 `room_objects.json`，生成可编辑清单、墙面归属 |
| `editor/placement.mjs`、`drop-placement.mjs` | 落到支撑面、自动找座面、贴墙、换墙、掉落 |
| `editor/collision.mjs` | 逐三角面的连续碰撞 |
| `editor/wall-visibility.mjs` | 剖墙、墙角连接 |
| `editor/layout.mjs` | 布局数据、撤销重做、导入导出 |
| `editor/walk.mjs` | 漫游：第一人称相机、键盘鼠标、射线碰撞、找起点 |
| `editor/placement-*.mjs`、`joystick-ui.mjs` | 预览后确认的放置流程、控制卡、摇杆 |
| `editor/joints.mjs` | 开合部件：合页、滑轨的变换和开关动画，以及放在部件上跟着动的东西 |
| `editor/gesture-bridge.mjs` | 手势输入（`GestureInput`：抓取、移动、抬高、旋转、预览暂停、竖拇指确认、独立环绕与场景缩放）和手势页协议的接收端 |
| `editor/gesture-camera.mjs` | 内置手势：摄像头卡片接 `vendor/gesture/` 的识别运行时 |
| `vendor/gesture/` | 从 `gesture/src/embed/` 构建的识别代码，随仓库提交 |
| `editor/object-import.mjs` | 读 ViewForge 物体目录和尺寸，算真实尺寸的放置矩阵 |
| `editor/object-dimensions.mjs`、`imported-objects.mjs` | 实测坐标轴与导入实例删除、资源清理 |
| `editor/add-object.mjs`、`editor/add-object-dialog.mjs` | “添加物体”：上传、抠图、重建、进度的请求，和分步对话框 |
| `editor/tests/` | 单元测试（Node 自带测试框架） |
| `scripts/room_objects.py` | `room_layout.json` → `room_objects.json` |
| `scripts/check_*.mjs` | 用真实模型在 CPU 上检查：`check_room` 适用于任何房间，其余四个针对 office |
| `scripts/check_lighting.mjs`、`check_import_lighting.mjs` | 可重放的浏览器光影基线、导入材质受光验收 |
| `scripts/check_lighting_stability.mjs` | 静止悬停零重绘、透明墙一致性、移动后更新的浏览器回归 |
| `scripts/check_time_lighting.mjs` | 时段、顶灯衰减、独立调色、单次合成和窄屏验收 |
| `scripts/publish.py` | 把编辑器复制到某个房间目录旁边 |
| `scripts/serve.py` | 本机网页服务，转发 ViewForge 的读请求和添加物体的请求 |
| `scripts/thumbnail.py` | 给 `rooms.json` 里的房间截缩略图 |

## 测试

```bash
node --test 'web/editor/tests/*.mjs'
python3 -m unittest discover -s web/scripts
node web/scripts/check_room.mjs --scene-dir samples/room3      # 约 30 秒
for c in collision wall_mount seat_support gravity; do node web/scripts/check_$c.mjs --scene-dir samples/office; done
```

CI 全部都跑。

## 已知问题

- **iframe 太矮时够不着仓库**：编辑器最矮 640 像素，手势页窗口太小时仓库会在 iframe 可见区域以外，手的指针到不了（内置手势没有这个问题）。
- **内置手势还没有真人摄像头验收**：用 Chromium 假摄像头验证过识别能加载、跑帧、切模式，手势拖动的逻辑和手势页共用、之前验证过；真人用手试一遍才算数。
- **发布到仓库外**（`publish.py`）时没有 `gesture/public/vision/`，“手势”会提示识别资源加载失败。
- **导入的物体不保存**：布局保存、导出只含房间原有家具；刷新后导入的物体要重新导入。以后有了后端再存。

- **重模型的检查要等一会儿**：落点的完整碰撞检查在后台线程（`editor/collision-worker.mjs`，同一份代码和三角面，结果相同）里做，页面不冻住；钢琴、琴凳这类紧挨着的重网格约 1–2 秒，期间预览是黄色“检查中”，确认按钮写“检查中…”，这时确认会在检查完后自动放下。用方向按钮逐步挪动、鼠标悬停摆放时的碰撞检查仍在页面线程，重网格挨着时还会顿一下；要更快需要给重网格做简化碰撞外形。
- **支撑判断**：底面采样点和支撑面三角形都多时（TRELLIS 枕头放在床上）逐个比较很慢，支撑面三角形先按平面网格分格，只比较同格的，结果不变。
- **重建本身的误差**：重建结果里家具之间常有几毫米到几厘米的互相穿插（room3 有 11 处）。这些原本就交叠的网格对不算碰撞，其余照常检查。白板、书架这类插进墙的，打开时显示“待调整”，挪开即可。
