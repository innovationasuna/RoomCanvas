# B1 同条件标定记录：Example_Room_2

日期：2026-11-07  
前置版本：`7f49f57`（10.5，修正烘焙法线与光照单位）  
范围：仅 B1 同条件标定与复核；未进入 B2/B3/B4。

## 结论先行

**视觉仍未通过，保持待验收，不进入 B2。**

本轮取得原生投影与 color grading 证据，完成日光、四盏顶灯、IBL 和显示变换的同条件小样，并解释透射机制差异。可保留的最小修正是：从既有场景线性 EXR 按 SceneView 实际 Filmic 路径重新输出预览。**没有第三轮烘焙，没有重做 UV2，没有修改或替换 baked GLB，没有复制到 Android assets。**

10.5 的资产事实保持不变：

- 原 GLB SHA-256：`812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`
- baked GLB SHA-256：`36acf40703c5f2cde3e87ddb34d206f252c0e3b4d6229d869188fe7e2954246b`
- UV 面积 `0.5306387330855316`；1,181 个 `TEXCOORD_1`、21 个 `TEXCOORD_2`；4 条动画及层级保留。
- 1,084 个封闭内向网格仍只在临时烘焙代理中翻转；黑带整改和 direct/indirect/AO 零异常降为 0/20 的结果没有重做或推翻。
- 动态门窗、升降桌面、透射构件及窗外照片仍不属于静态烘焙集合。

## 1. 实际投影：当前 A0 确为 80°，旧 B0 四图不能混作同构图证据

### 原生只读证据

使用现有 debug 包的 JDWP 接口，在 `onSceneFrame` 断点事件中只调用 getter，读取 `Camera.getProjectionMatrix()`、`getCullingProjectionMatrix()`、`getModelMatrix()`、曝光、viewport 和 `View.getColorGrading()`。没有修改 APK、材质、灯光、AR、位姿或门窗交互。

四张标定截图均记录到同一原生投影矩阵：

```text
projectionColumnMajor = [
  0.5752631983560145, 0, 0, 0,
  0, 1.1917535925942102, 0, 0,
  0, 0, -1, -1,
  0, 0, -0.10000000149011612, 0
]
```

由 `2 × atan(1 / P[5])` 得竖直 FOV `80.000000°`，由 `P[0]` 得水平 FOV `120.179533°`。viewport 为 `2486×1200`，near `0.05 m`，culling far `100 m`，曝光为 `f/0.7、1/125 s、ISO 100`。

| 视角 | 实测朝向 | 相机位置（glTF） | 证据 |
|---|---:|---|---|
| 入口 | `90.0°` | `(-1.565518, 0.005300, -0.277850)` | `a0/01-entry-jdi.log` |
| 反向 | `270.0°` | 同上 | `a0/02-reverse-jdi.log` |
| 左侧 | `182.3°` | 同上 | `a0/03-left-jdi.log` |
| 右侧 | `-4.0°` | 同上 | `a0/04-right-jdi.log` |

右侧用正常输入回读修正，最终与既定 `-4.1°` 相差 `0.1°`；没有通过改 FOV 或相机参数掩盖。

### 与旧 B0 的边界

- `SceneView 2.3.4` 的 `CameraNode.updateProjection()` 默认是 28 mm，`onResized()` 会再次调用它；因此不能只读“指定 80°”的源码就认定截图时生效值，也不能擅自改成默认 28 mm。
- 本轮原生读数证明当前同模型 A0 为 80°，其构图与离线 80° 基本一致。
- 旧 B0 四图明显更窄，且当时没有保存原生矩阵，不能用它们与离线 80° 做逐像素 MAE 来推断光照。旧图继续保留，未覆盖；本轮新 A0 单独存放在 `diagnostics/same-condition-calibration/a0/`。
- 当前手机原本已改载 `Hausen_Room_3`，不是 B0 模型。标定使用新建的临时私有 `Example_Room_2` 副本，SHA-256 与锁定原文件一致；没有使用其他模型的截图参与光照比较。

## 2. 实际 color grading：SceneView Filmic，不是请求中的 ACES

证据链如下：

1. `SceneView 2.3.4 createView()` 创建 `ColorGrading.Builder().toneMapper(ToneMapper.Filmic()).build(engine)`。
2. `PhysicalRoomLighting.kt` 中的 `toneMapping = View.ToneMapping.ACES` 在 Filament 1.68.2 的 `View.java` 中，setter `setToneMapping()` 是空实现，getter 始终返回 `ToneMapping.ACES`，所以日志中的“ACES”不是实际算子证明。
3. JDWP 读取到 `View.getColorGrading()` 返回非空 `com.google.android.filament.ColorGrading`，没有被旧 setter 替换。
4. `details/Engine.h` 默认 `engine.color_grading.use_1d_lut = false`；`details/ColorGrading.cpp` 因而走 32³、LogC、RGB10_A2 LUT。默认没有额外 adjustments、`gamutMapping=false`、`luminanceScaling=false`。
5. `FilmicToneMapper` 是 Narkowicz 曲线；当前默认路径在线性 Rec.2020 中执行，再转回 linear sRGB 和 sRGB OETF。

源码依据：

- [SceneView.kt](https://github.com/SceneView/sceneview-android/blob/v2.3.4/sceneview/src/main/java/io/github/sceneview/SceneView.kt)
- [View.java](https://github.com/google/filament/blob/v1.68.2/android/filament-android/src/main/java/com/google/android/filament/View.java)
- [ColorGrading.cpp](https://github.com/google/filament/blob/v1.68.2/filament/src/details/ColorGrading.cpp)
- [ToneMapper.cpp](https://github.com/google/filament/blob/v1.68.2/filament/src/ToneMapper.cpp)
- [details/Engine.h](https://github.com/google/filament/blob/v1.68.2/filament/src/details/Engine.h)

本轮 `filament_display.py` 按上述路径输出 Filmic 解析算子，复用既有 EXR，不拼接 gamut 实现。**解析预览不冒充完整的 32³ LUT 量化/插值、半浮点、抖动、FXAA 和驱动 HDR 量化复现。** Filmic/ACES/FXAA 均未写入 lightmap。

## 3. 剩余偏色和明暗：顶灯主导，显示修正不足以通过

### 同条件小样

`contribution-report.json` 记录 25% 分辨率、32 samples、固定 seed 的入口和反向小样。动态/特殊对象和自发光材质保留，因此 solo 变体不是严格独立、可相加的 light group 分解；它们用于判断主导贡献，不用于拟合系数。

全图场景线性 RGB 均值：

| 视角 | 全部光源 | 仅日光 | 仅四盏顶灯 | 仅 IBL |
|---|---|---|---|---|
| 入口 | `(49.5097, 37.5097, 21.6111)` | `(0.1371, 0.1431, 0.1198)` | `(55.7551, 41.5833, 23.4311)` | `(0.0639, 0.0639, 0.0538)` |
| 反向 | `(26.9478, 20.3901, 11.8970)` | `(0.0363, 0.0330, 0.0239)` | `(33.4536, 24.9278, 14.0882)` | `(0.0286, 0.0256, 0.0186)` |

结果不支持“IBL 是整体偏色主因”或“随意旋转 HDR 就能修复”的做法。顶灯是当前 Cycles 画面的主导照明；日光和 IBL 的显示贡献很小。IBL 仍承担手机端反射和高光，不能据此删除或降强度。

### 灯光单位与色温

- 每盏顶灯：`60 × 0.1171 × 683 = 4798.758 lm`；Filament POINT 再除以 `4π` 得约 `381.79 cd`。Cycles 中记录的能量为 `4798.7578125`。没有额外 `1/683` 归一化，也没有重试已被拒绝的近黑版本。
- 日光保持 `2500 lux / 6500K`，顶灯保持 `4700K`，灯位、方向、半径、falloff 和数量不变。
- 离线 `illuminant_d()` 与 Filament `Color::illuminantD()` 的代码确有差异：离线只截断负值，Filament 还按最大 RGB 分量归一化并截到 `[0,1]`。4700K 原始 RGB 为 `(1.228006, 0.966892, 0.656202)`，Filament 为 `(1.0, 0.787368, 0.534364)`。
- 同分辨率、同采样的归一化小样只使画面整体变暗，偏粉和偏绿没有消除；入口/反向基线到归一化 MAE 分别约 `7.78 / 8.83`。**不把这项候选纳入正式修正，不据此重烘 direct/indirect。**

证据：`scene-report.json`、`light-color-unnormalized-baseline/`、`light-color-normalization/`、`contact-light-color-normalization.jpg`。

### IBL 与显示边界

HDR 文件及 SHA-256 未变，强度 `0.25`；Blender 环境纹理为等距柱状投影，没有显式旋转或 Mapping 节点。手机走 HDR → cubemap → specularFilter，Cycles 走路径追踪世界照明，方向和预滤波不能由“同一文件、同一强度”推定等价。没有随意旋转 HDR 或拟合 IBL 增益。

Filmic 解析输出修正了先前错误假定的 ACES 路径，但四视角仍有局部偏粉高光、暗部偏绿和材质/反射差异。显示链路不是唯一问题，剩余光照/材质/IBL 等价性未证明。

## 4. 窗外与透射：机制不同，保留实时边界

源 GLB 与 Blender 材质一致：

- `Glazing`：`KHR_materials_transmission.transmissionFactor = 1`；`KHR_materials_ior.ior = 1.4500000476837158`；`alphaMode = OPAQUE`；`doubleSided = true`；metallic `0`；roughness `0.025`。
- `Actual exterior view`：`emissiveFactor = 0.8` 加 `emissiveTexture`，普通 PBR、双面，不是透射材质。
- 固定窗构件与透射玻璃共用 mesh，故整个固定框保守留在特殊实时集合；两扇活动窗属于动态集合；窗外照片独立留在特殊实时集合。三者均未烘入 lightmap。

Filament 1.68.2 默认开启屏幕空间折射，gltfio 设置 transmission 和 IOR；Cycles 则通过完整路径追踪实际穿过多层玻璃看到窗外自发光平面。当前 A0 窗面主要为黑色与局部高光，而 Cycles 可见窗外照片，证明现有完整预览并不等价。

`contact-transmission-entry.jpg` 保存该差异。**没有把窗户隐藏、把窗外照片烘入静态集合或修改 A0 来制造通过。** 当前没有逐 GPU pass 证据把黑窗唯一归因于某个单一参数；验收边界明确为：透射和窗外继续走实时路径，B1 不宣称它们的显示等价。

## 本轮实际修正与生成物

### 保留的最小修正

- `configs/example_room_2.json` 的预览改为 `previewToneMapper = FILMIC`，曝光保持原值。
- `reprocess_previews.py` 新增 `--output-dir`，允许在独立标定目录复用既有 EXR，不重烘、不覆盖 10.5 主报告。
- 新增标定/采集/复核脚本：`JdiCalibration.java`、`capture_b1_calibration.py`、`calibrate_b1.py`、`make_b1_calibration_review.py`。

### 实际打开检查的结果

- `contact-a0-display.jpg`：本轮 A0／10.5 ACES／本轮 Filmic 四视角对照。
- `contact-contributions.jpg`：入口和反向的日光、顶灯、IBL 小样。
- `contact-light-color-normalization.jpg`：色温归一化候选，未采纳。
- `contact-transmission-entry.jpg`：窗面与窗外差异。
- `display/`：由既有 8 张场景线性 EXR 重新输出的 Filmic PNG，没有重渲染 lightmap。
- `a0/capture-metadata.json`：四视角原生矩阵、FOV、相机模型矩阵、曝光、viewport 和截图哈希。
- `review.json`：辅助指标，不用于自动验收。

### 没有生成的内容

- 没有新 lightmap、没有新 baked GLB、没有第三轮烘焙、没有新 UV2、没有 Android 混合材质、没有性能收益数据。

## 四视角视觉复核

| 视角 | A0→10.5 ACES MAE | A0→Filmic MAE | 人工结论 |
|---|---:|---:|---|
| 入口 | 29.24 | 34.66 | 偏粉高光和窗外差异仍明显，不通过 |
| 反向 | 34.40 | 16.57 | Filmic 明暗更接近，但偏粉/反射/透射仍不等价，不通过 |
| 左侧 | 30.67 | 38.05 | 偏粉和材质高光差异仍明显，不通过 |
| 右侧 | 32.89 | 16.49 | Filmic 明暗改善，但局部偏色和光照关系不等价，不通过 |

MAE 使用当前同模型、已证明 80° 的 A0，并排除主要 UI 区域，只作辅助；旧 B0 没有原生投影证据，不用于这些数值。**局部视角改善不写成整体视觉通过。**

## 其他边界与现场恢复

- 未重跑 A0–A7 性能实验；四张新图仅为视觉标定，无 FPS/PSS/热基线或收益声明。
- A8、真实漫游录像、当前模型可重复性能基线及 B4 动态验收均未补标完成。
- 未修改 `任务进度.md`，未创建 Git 提交，未覆盖参考子模块已有脏状态。
- 安装临时诊断 APK 时遇到华为在线安全校验失败，旧包未更新；随后改用现有 debug 包的 JDWP 只读诊断，没有调整手机安全设置。
- 直接读取 Download 模型失败后，使用临时私有副本完成标定；旧模型偏好曾为空，结束后恢复为原 `Hausen_Room_3-1793549601499.glb` 和名称，并删除临时文件。
- 原 `example_room_2.baked.blend` 未被小样保存或覆盖，场景只在内存中切换诊断光源并恢复。

复现命令见 [reproduction.md](reproduction.md) 的“2026-11-07 B1 同条件标定”。完整实时 A0 保持默认回退；本轮停止等待用户验收。

---

# 2026-11-07 B1 剩余视觉复核

**结论：视觉仍未通过，保持待验收，不进入 B2。本轮没有采纳新参数修正，没有重烘 lightmap、重导 baked GLB 或修改 Android。**

本轮只在上轮证据上继续分解显示链和材质/通道贡献。新增证据集中在 `output/example_room_2/diagnostics/remaining-visual-review/`，复现命令见 [reproduction.md](reproduction.md) 的“2026-11-07 B1 剩余视觉复核”。

## 1. 32³ LogC LUT、HDR 量化与抖动不是剩余大范围偏色的充分解释

按 SceneView 2.3.4 与 Filament 1.68.2 源码进一步核对：

- 默认 color grading 为 32³ LogC LUT；每个 LUT 输出先转 binary16，再量化到 RGB10_A2，运行时三线性插值。`gamutMapping=false`、`luminanceScaling=false`。
- 漫游视图不透明，`hdrColorBuffer=MEDIUM` 的配置路径选择 R11F_G11F_B10F。物理曝光在灯光进入 HDR 缓冲前参与着色，因此诊断顺序为“既有线性 EXR × 曝光 → R11F_G11F_B10F → LogC/32³ LUT → 默认三角波抖动/8 位输出”。没有把它误放到曝光前。
- 默认抖动为 TEMPORAL；诊断只固定 `temporalNoise=0` 的一种实现，幅值不超过 1 个 8 位码值。未复现 FXAA、SSAO、PCSS、屏幕空间折射、Android 合成和驱动特定舍入。
- HDR 格式和 LUT 模型来自源码与当前配置，不是手机内部纹理读回；没有证明驱动不支持格式时的 fallback，也不把该模型称为真机逐位复现。

`display/report.json` 记录分项结果。解析曲线到 HDR 量化的四视角平均变化约 `0.20–0.23` 个 8 位码值，到 32³ LUT 的变化约 `0.15–0.20`；抖动自身约 `0.33`。它们远小于现有光照差异。

| 视角 | A0→上轮 Filmic MAE | A0→HDR＋LUT＋抖动模型 MAE | 实际打开检查 |
|---|---:|---:|---|
| 入口 | 34.66 | 34.60 | 粉白高亮、顶板和窗外差异仍在 |
| 反向 | 16.57 | 16.64 | 没有一致改善，局部偏色和明暗关系仍在 |
| 左侧 | 38.05 | 38.03 | 偏粉高亮没有消除 |
| 右侧 | 16.49 | 16.49 | 白板及下墙灰绿、墙面明暗差异仍在 |

证据：`contact-display-four-views.jpg`、`contact-display-stages-entry.jpg`、`contact-display-rois.jpg`。LUT/HDR/抖动候选没有四视角一致改善，**未替换上轮解析 Filmic 主路径，未调整曝光、LUT、HDR 格式或手机 dithering。**

源码：[SceneView](https://github.com/SceneView/sceneview-android/blob/v2.3.4/sceneview/src/main/java/io/github/sceneview/SceneView.kt)、[ColorGrading.cpp](https://github.com/google/filament/blob/v1.68.2/filament/src/details/ColorGrading.cpp)、[colorGrading.fs](https://github.com/google/filament/blob/v1.68.2/filament/src/materials/colorGrading/colorGrading.fs)、[Renderer.cpp](https://github.com/google/filament/blob/v1.68.2/filament/src/details/Renderer.cpp)、[Options.h](https://github.com/google/filament/blob/v1.68.2/filament/include/filament/Options.h)、[inline_dithering.fs](https://github.com/google/filament/blob/v1.68.2/shaders/src/inline_dithering.fs)。

## 2. 粉色高亮不是单纯镜面项；灰绿也存在于直接漫反射

对入口和右侧做了 25% 分辨率、32 samples、固定 seed 的一次 Cycles 多通道小样，原灯光、材质、IBL、对象可见性和几何均未改变。`material-report.json` 记录对象/材质/原 EXR 采样，`pass-report.json` 记录原始通道，`decomposition-report.json` 记录按正确公式加权后的结果：

```text
(DiffDir + DiffInd) × DiffCol + (GlossDir + GlossInd) × GlossCol
```

不能把未乘底色的 direct/indirect 光通道直接相加。已实际打开 `contact-lighting-passes.jpg` 和各加权 PNG。

| 样点 | 直接漫反射 RGB | 直接光泽 RGB | 结论边界 |
|---|---|---|---|
| 入口顶板 `(0.46, 0.07)` | `(41.45, 30.73, 19.88)` | `(9.04, 7.12, 4.83)` | 直接光泽占该点漫反射/光泽总量约 17.6%，粉色并非只由镜面项造成 |
| 入口墙 `(0.80, 0.18)` | `(104.21, 78.81, 43.26)` | `(2.92, 2.30, 1.56)` | 直接光泽约 2.82%，高亮以直接漫反射为主 |
| 右侧白板 `(0.60, 0.62)` | `(21.74, 19.41, 13.30)` | `(0.085, 0.067, 0.046)` | 直接光泽约 0.32%；灰绿已存在于材质底色×漫反射 |
| 右侧下墙 `(0.68, 0.75)` | `(10.38, 8.50, 5.60)` | `(0.243, 0.191, 0.130)` | 局部灰绿不能归因于 LUT 或单独高光参数 |

材质核对未发现可支持单改的导入错误：`Whiteboard0 image` 的源 `specularFactor=0.2` 对应 Blender `Specular IOR Level=0.1`，roughness 均为 `0.65`；`ceiling_tile` 的 metallic 为 0，粗糙度来自 metallicRoughnessTexture 的 Green 通道，原 `texCoord=1` 对应 Blender `UVMap.001`。这些采样不能证明所有材质等价，但不支持随意改粗糙度、Specular 或 UV。

**当前只能把主要剩余问题定位到顶灯下的直接光照传输、材质底色与 Filament/Cycles 着色响应的组合层，尚不能唯一归因某个可修正参数。** 直接光衰减/阴影、Principled 与 Filament BRDF 的精确差异仍未完全分离，保持不修改。

## 3. IBL 的贡献与等价边界

- HDR 文件和强度 `0.25` 未变；Blender 没有显式旋转，Android 也未设置 `IndirectLight.rotation`，Filament 默认旋转矩阵为单位矩阵。
- 上一轮 IBL-only 小样显示其全图贡献很小。本轮 12 个材质样点中，包含所有光源的间接光泽占各自漫反射/光泽总量约 `0.09%–1.45%`；这不是 IBL 独立 light-group 分解，也不能外推为高反射物体或全屋的固定比例。
- 同一 HDR、同一强度及默认单位旋转不等于等距柱状投影方向、cubemap 映射、SH 漫反射和 specularFilter 预滤波与 Cycles 路径追踪等价。没有手机预滤波 cubemap/SH 读回，方向等价仍未证明。
- 因而没有证据支持旋转 HDR 或改变 IBL 强度；高反射材质的反射方向与预滤波差异继续列为未解决问题。

源码：[IndirectLight.cpp](https://github.com/google/filament/blob/v1.68.2/filament/src/details/IndirectLight.cpp)、[View.cpp](https://github.com/google/filament/blob/v1.68.2/filament/src/details/View.cpp)、[EnvironmentLoader.kt](https://github.com/SceneView/sceneview-android/blob/v2.3.4/sceneview/src/main/java/io/github/sceneview/loaders/EnvironmentLoader.kt)。

## 4. 透射与窗外只能保留为不同机制

本轮没有新增足以消除机制差异的证据。Filament 屏幕空间折射依赖当前屏幕已渲染内容，Cycles 则能通过多层玻璃路径追踪看到窗外自发光照片；既有 A0 黑窗＋局部高光与 Cycles 窗外照片仍不同。**B1 只能明确记录该边界，不能继续靠静态配方勉强对齐。** 透射构件和窗外照片继续实时路径，不隐藏、不烘入静态集合，也不据此改 IOR、自发光或门窗材质。

## 5. 最终证据与未解决问题

已实际打开以下新生成图，而非只读取 JSON：

- `contact-display-four-views.jpg`：四视角 A0／上轮 Filmic／完整显示模型对照。
- `contact-display-stages-entry.jpg`、`contact-display-rois.jpg`：显示链分项与局部偏色。
- `contact-lighting-passes.jpg`：入口和右侧的加权直接漫反射、直接光泽与间接项。
- `display/`、`lighting/passes/`：对应 PNG 和线性 EXR；`lighting/pass-render.log` 保存最终逐路径输出日志。

通道输出初次出现过视角文件槽复用，相关输出未用于结论；改为每视角独立节点和独立主输出后重新生成，并核验没有跨视角文件或主预览目录写入。最终原 GLB 与 10.5 baked GLB 哈希保持：

- 原 GLB：`812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`
- baked GLB：`36acf40703c5f2cde3e87ddb34d206f252c0e3b4d6229d869188fe7e2954246b`

未解决：直接光传输/BRDF 的唯一根因、IBL 方向与预滤波的严格等价、所有高反射材质、完整驱动显示量化，以及透射/窗外机制差异。未重跑 A0–A7，未虚标 A8、真实漫游录像、当前模型性能基线、性能收益或 B4 动态验收；未修改 `任务进度.md`，未创建 Git 提交，未进入 B2。完整实时 A0 保持默认回退，本轮停止等待用户验收。

---

# 2026-11-08 B1 顶面法线/背面与阴影边界复核

**结论：视觉仍未通过，保持待验收，不进入 B2。本轮没有采纳任何修正，没有重烘 lightmap、重导 baked GLB、修改 Android 或覆盖任何哈希资产。**

本轮把上一轮剩余的“直接光照传输与着色响应组合层”继续拆分为顶灯距离/衰减、阴影/SSAO、直接漫反射、直接镜面，以及关键材质的法线/背面边界。新增只读诊断输出在 `output/example_room_2/diagnostics/ceiling-boundary/`；脚本不保存 `.blend`、不执行 bake、不写主预览或 Android assets。

## 1. 顶面 authored 法线朝上，标定相机看到背面

对 `01-entry` 顶板样点 `(0.46, 0.07)` 的射线与几何检查（`scene-report.json`）：

- 对象 `Ceiling0`，mesh `Floor0.001`，材质 `ceiling_tile`，源材质 `doubleSided=true`、`metallicFactor=0`。
- 多边形法线 `(0.0000, 0.0000, 1.0000)`；自定义 loop 法线均值为 `(0.0000, 0.0000, 1.0000)`，三个角点与面法线点积均为 `1.000`；`cameraSideOfFace = back`。
- 法线贴图样点接近平面 `(0.5176, 0.5176, 1.0)`，基色样点约 `(0.5216, 0.5059, 0.4941)`，粗糙度贴图 G 通道约 `0.7725`；没有发现与“顶面应整体变黑”相符的贴图异常。
- 第二个 `(0.48, 0.12)` 样点得到相同朝向和近似比例，排除单点法线贴图突变。

Cycles 的 `Geometry > Normal` 与 `True Normal` 都是**朝向射线**的着色法线，不是 authored winding 的可视化：法线通道中顶面呈橄榄/黄绿色（面向下方相机），不能据此反推原始法线朝下。原始朝上由射线命中的面法线与 loop 法线直接给出。

## 2. 离线直接光确实落在顶面，这是背面翻转后的预期结果

在 `(0.46, 0.07)`：

| 项 | RGB | 说明 |
|---|---|---|
| 仅四盏顶灯、loop 法线翻转后的期望 | `(136.16, 107.21, 72.76)` | 已含 `1/π`；未翻转时 `(0,0,0)` |
| Cycles 直接漫反射（`DiffDir × DiffCol`） | `(41.45, 30.73, 19.88)` | 非零，与翻转法线一致 |
| Cycles 直接光泽 | `(9.04, 7.12, 4.83)` | 约占该点漫反射/光泽总量 17.6% |
| 实际 / 翻转法线期望 | `(0.304, 0.287, 0.273)` | 第二样点同样约 `0.30 / 0.29 / 0.27` |

该比值与该样点基色亮度 `diffuseColorRgb ≈ 0.255` 同量级，不构成额外能量损失证据；这里只用它确认直接光非零且按翻转法线分布。因此离线顶面亮斑不是“灯光漏算”或“法线未翻转”的结果；Cycles 按双面语义把背面法线翻向射线，顶面得到直接漫反射。离线诊断与 Cycles 行为自洽。

## 3. 阴影测试不支持“离线阴影过强”修正

相同场景、25% 分辨率、32 samples、固定 seed，分别关闭顶灯阴影、顶面对象投影和全部阴影：

| 顶带均值（辅助值，含墙面） | 入口 | 右侧 |
|---|---:|---:|
| baseline | `(200.56, 171.25, 165.17)` | `(200.18, 169.00, 158.50)` |
| 顶灯不投影 | `(210.68, 180.04, 175.33)` | `(203.60, 172.02, 161.65)` |
| 顶面对象不投影 | `(214.25, 189.92, 192.56)` | `(217.98, 195.49, 202.06)` |
| 全部不投影 | `(226.24, 202.19, 212.31)` | `(225.19, 202.79, 213.72)` |

关闭阴影只会让离线画面更亮，顶面光斑和粉色仍然存在；**没有证据支持削弱离线阴影或把阴影当作当前差异的修正项。** 渲染后已恢复原灯光 `use_shadow` 与对象 `visible_shadow`，未保存 `.blend`。

## 4. A0 与离线的边界明确，但运行时机制未被唯一证明

标定 A0 的入口/右侧顶面接近黑色；离线 baseline 顶面有明亮光斑。离线证据说明：

1. 源顶面法线朝上，相机看背面；
2. Cycles 会翻转背面法线并点亮顶面；
3. 关闭阴影不会消除离线顶面光斑。

但以上只证明**离线侧**自洽，**没有**证明 Filament 1.68.2／当前 gltfio 路径在真机上是否对 `doubleSided` 背面执行同样的法线翻转，也没有排除手机 512 阴影贴图、PCSS 近灯自阴影或其它运行时因素。没有手机侧材质实例或 shader 读回，不能把 A0 顶面近黑唯一归因于法线翻转。（后续 2026-11-08 续测已取得手机侧材质实例读回并证明背面法线翻转；PCSS 部分仍未唯一归因，见下文。）**因此本轮不修改法线、UV、粗糙度、Specular、灯光或阴影参数，也不把 A0 的顶面黑当作需要烘入的目标。**

## 5. 实际打开的图像与未解决问题

已实际打开：

- `output/example_room_2/diagnostics/ceiling-boundary/contact-ceiling-boundary.jpg`：入口/右侧的 A0、离线 baseline、顶带、全关阴影顶带与 view-facing 法线通道对照。
- `normal/01-entry-true.png`、`normal/01-entry-shading.png`、`normal/04-right-true.png`、`normal/04-right-shading.png`。
- `shadow-tests/{01-entry,04-right}-{baseline,ceiling-lights-no-shadow,ceiling-objects-no-shadow,all-no-shadow}.png` 及对应线性 EXR。
- 上一轮八张复核图保持已打开结论，不重复生成。

未解决：

- Filament 运行时背面法线翻转与 A0 顶面近黑之间的因果链未闭合；可能需要手机侧只读 shader/材质实例证据，当前没有。
- 墙面/白板剩余亮度与偏色仍与 BRDF、阴影、SSAO 和显示链混合，不能唯一归因。
- IBL 方向/预滤波、透射/窗外机制差异、高反射材质等价性继续待验收。
- 本轮没有新增可用于采纳的参数修正，所有资产与配方保持不变。

原 GLB 与 10.5 baked GLB 哈希保持 `812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a` 与 `36acf40703c5f2cde3e87ddb34d206f252c0e3b4d6229d869188fe7e2954246b`。未重跑 A0–A7，未虚标 A8、真实漫游录像、当前模型性能基线、性能收益或 B4 动态验收；未修改 `任务进度.md`，未创建 Git 提交，未进入 B2。完整实时 A0 保持默认回退，本轮停止等待用户验收。

---

# 2026-11-08 续 B1 手机侧只读探针：doubleSided 运行时与阴影链路

**结论：视觉仍未通过，保持待验收，不进入 B2。本轮只做最小、只读的手机侧证据补齐：未修改手机代码、材质、灯光、AR、位姿、Android assets 或现有烘焙配方；未改 shader、未替换实时灯光、未重烘、未重导 GLB、未覆盖任何哈希资产。**

上一轮把两件事列为未证明：Filament 运行时是否对 `doubleSided` 材质背面翻转法线；A0 顶面近黑是否可由 512 阴影贴图/PCSS 近灯自阴影解释。本轮使用现有 debug 包、JDWP 只读探针和已有的 debug 实验入口补齐证据。探针在 `VrWalkthroughActivity.onSceneFrame(J)V` 断点暂停一次，只调用 getter，不调用 setter、不改参数、不写设备。证据输出在 `output/example_room_2/diagnostics/ceiling-boundary/phone-probe/`。

## 1. 运行时材质实例：背面法线翻转已获证明

A0 原始模型运行中（设备内 `B1-Example-calibration.glb`，每次启动/截图前校验 SHA-256 为 `812c8efe…`）读回：

| 项 | 读回值 |
|---|---|
| `Ceiling0` 材质实例名 | `ceiling_tile`（primitive 0） |
| `MaterialInstance.isDoubleSided()` | `true` |
| 父材质 | `base_lit_opaque`，`Material.isDoubleSided()` 为 `false` |
| shading | `LIT` |
| `isShadowCaster` / `isShadowReceiver` | `true` / `true` |
| 材质实例 light channels | `[true, false, false, false]` |
| `View.isShadowingEnabled()` | `true` |

Filament 1.68.2 中，`FMaterialInstance::setDoubleSided`（`MaterialInstance.cpp:357`）在父材质没有 double-sided capability 时于第 358 行提前返回，不会写入 `mIsDoubleSided`；Java `MaterialInstance.isDoubleSided()`（`java_MaterialInstance.java:544`）是 native 调用。因此实例为 `true` 而父材质为 `false` 只能说明：

1. 该材质具备 double-sided capability；
2. gltfio 已把实例的 `_doubleSided` 设为 1，culling 为 NONE；
3. `surface_shading_parameters.fs:17-25` 在 `isDoubleSided()` 且 `gl_FrontFacing == false` 时翻转 `n`（以及 `t/b`），`shading_geometricNormal` 随之翻向下方的相机。

**即 Filament 1.68.2／gltfio 在当前真机上确实对该顶板背面执行法线翻转，与 Cycles 的双面语义一致。** 上一轮的“未证明”项关闭。该结论只证明渲染语义，不证明顶面亮度应达到离线水平；阴影、SSAO 与材质响应仍可使其变暗。

## 2. 灯光与接收配置没有缺失

同一 A0 场景读回 5 盏灯：

- 1 盏 `SUN`，intensity `2500`，shadowCaster `true`，channels `[T,F,F,F]`；
- 4 盏 `POINT`，y 均为 `1.0194`（顶板 y≈`1.0754`，灯在顶板下方约 `0.056 m`），intensity 均为 `381.873`，falloff 均为 `10.786616`，shadowCaster 均为 `true`，channels 均为 `[T,F,F,F]`；
- 顶板 `Ceiling0` shadow receiver `true`，light channel 0 开启。

因此顶面近黑不是“灯未加载”“顶板不接收阴影”或“light channel 不匹配”。

## 3. 受控阴影对照：512 贴图本身不足以解释顶面近黑

使用现有 debug 实验入口启动并截屏，每次启动前校验模型哈希，截图时用探针确认已生效状态：

| 对照 | 探针确认 | 入口顶面 ROI 均值 RGB（中位亮度） |
|---|---|---:|
| A0 标定图（原始模型） | original probe：`shadowingEnabled=true`，材质同上 | `(7.90, 6.21, 4.17)`（`3.33`） |
| A6 关闭全部实时阴影 | `shadowingEnabled=false` | `(183.19, 170.04, 149.87)`（`174.67`） |
| A1_DPCF | `currentExperiment=A1_DPCF`，`quality={shadowFilter=DPCF, shadowsEnabled=true}`，`shadowingEnabled=true` | `(168.99, 156.25, 136.88)`（`158.33`） |
| 离线 baseline（Cycles） | — | `(191.88, 166.17, 155.61)`（`179.67`） |

A0 与 A1_DPCF 的局部阴影贴图同为 512（Filament 1.68.2 的点光局部阴影贴图分辨率），已确认的渲染配置差异在阴影过滤（PCSS vs DPCF）。A1_DPCF 顶面明亮且出现灯池，所以**“512 贴图分辨率”单独不足以让顶面近黑**；差异落在实时阴影链路，PCSS 是已确认的差异项。

未受控变量：一盏 POINT 灯在三次运行中的位置不同——原始 A0/A6 为 `(-1.4994771, 1.0194, 0.12881418)`，A1_DPCF 为 `(-0.73, 0.9854, 0.14)`，A0 复现为 `(-1.5390999, 1.0253999, -0.2778499)`；其余三盏与 SUN 完全一致。因此 A1_DPCF 与 A0 不是逐灯完全相同的对照，灯位/动画相位必须记为未受控变量；但单盏灯约 0.4–0.8 m 的位置差不足以解释约 20 倍的顶面均值差。

## 4. 不能唯一归因：A0 复现帧异常

15:55 用 `DEBUG_CAPTURE_VIEW`（`experiment=A0`、`view=entry`）重启并截图，顶面明亮、有灯池（ROI 均值 `(162.13, 149.36, 129.99)`，中位 `146.00`），接近 A1_DPCF。探针读到 `currentExperiment=A0`、`quality={shadowFilter=PCSS, shadowsEnabled=true}`、`shadowingEnabled=true`；但 `currentExperiment` 的默认值就是 A0，**不能证明 `applyQuality(A0)` 真正执行**。原计划用 `View.mAmbientOcclusionOptions` 读回验证（A0 应 enabled=true、radius=0.35、intensity=0.65、quality=MEDIUM），探针加入后设备在 16:00 前后断连，AO 读回未完成，`runtime-material-probe-a0-restored.json` 中没有该字段。

因此本轮**不能**把 A0 顶面近黑唯一归因于“PCSS 近灯自阴影”，也不能确定遮挡体是瓦片自阴影、灯具/格栅还是其它几何。已被证据排除的只是：512 贴图分辨率单独作用、灯未加载、顶板不接收阴影、light channel 不匹配、doubleSided 背面法线未翻转。

## 5. 顶面 ROI 的更正

既有 `ceiling-boundary/review.json` 的 `ceilingBandMeanRgb` 顶带包含墙面/窗户，不是顶面单材质区域：入口 A0 `(128.92, 121.01, 102.69)`、离线 `(200.56, 171.25, 165.17)`；右侧 A0 `(175.28, 166.05, 144.21)`、离线 `(200.18, 169.00, 158.50)`。这些带均值与“入口/右侧顶面近黑”的目视事实矛盾，不能用于顶面结论；`review.json` 未覆盖，保留为历史证据。新增 `phone-probe/ceiling-roi.json` 使用纯顶面 ROI（入口 `820,8,1440,215`，右侧 `1460,8,2250,140`，均为截图原始坐标并已排除 154 px 黑边）；同时修正了复核脚本对手机截图再次按视口归一化、使测量 ROI 左移约 73–113 px 的缺陷。以下数字均来自修正后的脚本。

## 6. 四视角逐项比较与视觉结论

已实际打开 `phone-probe/contact-phone-probe.jpg`，并逐张核对四张标定 A0、A6/A1_DPCF/A0 复现截图与离线 baseline：

- 入口 A0：顶面近黑，仅隐约可见瓦片网格与局部高光；ROI 中位亮度 `3.33`，`>64` 仅 `1.13%`。离线 baseline 中位 `179.67`，`>64` 为 `93.46%`。
- 右侧 A0：顶面近黑、格栅可见；ROI 中位 `8.00`，`>64` 仅 `5.11%` 的少量高光像素，离线 baseline 中位 `49.67`。
- 反向 A0：顶面暗棕/近黑但有可见瓦片纹理与烟感器，不是均匀纯黑。
- 左侧 A0：顶面整体暗棕，但顶部中央有清晰暖色灯池；说明顶面并非所有视角均匀全黑。
- A6、A1_DPCF、A0 复现：顶面均明亮且有灯池；A0 复现因 `applyQuality` 未证实，只作机制旁证，不作修正或验收。

**结论：视觉仍未通过。** 本轮只关闭了“运行时背面法线翻转未证明”一项；差异已缩小到实时阴影链路（PCSS 相关），但没有可复现的唯一归因，也没有采纳任何修正，未把 A0 顶面黑当作烘焙目标。

## 7. 未解决

- A0 顶面近黑的可复现机制未闭合：`applyQuality(A0)` 读回未完成，PCSS 近灯自阴影与遮挡体无法唯一确定；灯位/动画相位不同使“同条件”对照不严格。
- 左侧灯池与入口/右侧近黑的视角差异仍需解释（可能与灯位、格栅遮挡和 PCSS 采样有关）。
- 墙面/白板剩余亮度与偏色、IBL 方向/预滤波、透射/窗外机制差异继续待验收。
- 本轮未改手机代码、材质、灯光、AR、位姿、Android assets 或烘焙配方；未重跑 A0–A7，未虚标 A8、真实漫游录像、当前模型性能基线、性能收益或 B4 动态验收。

原 GLB 与 10.5 baked GLB 哈希保持 `812c8efe…` 与 `36acf407…`。未修改 `任务进度.md`，未创建 Git 提交，未进入 B2。完整实时 A0 保持默认回退，本轮停止等待用户验收。
