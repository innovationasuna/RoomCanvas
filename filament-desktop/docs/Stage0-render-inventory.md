# 阶段 0 · Android 端渲染资源与配置清单

> 依据《光影渲染性能优化方案2（当前新方案）》执行。
> 分析对象：`AndroidApp`（当前主入口 `VrWalkthroughActivity`）与工作区房间样本 `.tmp_room_model.glb`。
> 目的：明确桌面端要复现什么、哪些资产可直接复用、哪些代码必须用 C++ 重写。
> 日期：2026-11-08。

---

## 0. 结论摘要

1. Android 端渲染栈是 **SceneView 2.3.4 + Filament 1.68.2（Java/JNI）**，不是自研渲染器；工程内**没有自定义 `.mat` / `.filamat` 源文件**，也没有修改 Filament 的 Shadow Pass。
2. PCSS 是 **Filament 内置功能**：`View.setShadowType(PCSS)` + `SoftShadowOptions`，工程内没有自定义 GLSL 着色器。桌面端只要使用同一版本 Filament，PCSS 语义可以原样复现。
3. 场景的“物理光影配方”全部在 Kotlin 层：日光 2500 lux / 4 级 1024 阴影、顶灯 60 W / 4700 K、窗灯 20 W / 6500 K、PCSS、SSAO、HDR IBL 0.25、三参数曝光。**灯光布置算法可以逐行移植到 C++**。
4. 模型与纹理可以直接复用；房间样本为 **95.49 万三角形、50 材质、48 张纹理（约 184.3 MiB RGBA8）**。
5. 桌面端需要自己创建 Engine / Renderer / Scene / View / Camera / IBL，并用 gltfio 加载 GLB；SceneView 的 `ModelNode`、相机手势、Android 生命周期和 AR Engine **不迁移**。
6. 当前电脑只装了 **Visual Studio 2019 + Windows SDK 10.0.19041**，没有 VS 2022，也没有系统级 CMake/Ninja。阶段 1 需要先补齐工具链（VS2019 自带 CMake/Ninja 可先用于探测，但方案要求 VS 2022）。

---

## 1. 版本与依赖（已核实）

| 项目 | 值 | 证据 |
|---|---|---|
| SceneView | `io.github.sceneview:sceneview:2.3.4` | `AndroidApp/app/build.gradle.kts:44` |
| Filament | **1.68.2**（`filament-android` / `gltfio-android` / `filament-utils-android`） | SceneView 2.3.4 POM（Gradle 缓存） |
| gltfio | 1.68.2 | 同上 |
| Kotlin | 2.2.21 | `AndroidApp/build.gradle.kts` |
| AGP | 8.7.3 | 同上 |
| compileSdk / targetSdk / minSdk | 35 / 34 / 26 | `AndroidApp/app/build.gradle.kts:8-15` |
| ABI | `arm64-v8a`, `armeabi-v7a` | 同上 `:17-19` |
| 华为 AR Engine | `com.huawei.hms:arenginesdk:4.0.0.5` | `AndroidApp/app/build.gradle.kts:51` |
| 桌面目标版本 | **Filament v1.68.2** | 方案要求，与 Android 端严格对齐 |

> 注意：Filament 1.68.2 的 Java `View.setToneMapping(...)` **没有对应的 native 绑定**（`View.class` 中只有 `setToneMapping`，没有 `nSetToneMapping`），因此 `PhysicalRoomLighting.kt` 里的 `toneMapping = View.ToneMapping.ACES` 实际不生效。真正的色调映射来自 SceneView 2.3.4 `createView()` 内部的 `ColorGrading` + `ToneMapper.Filmic`。桌面端必须以 **Filmic** 为准，而不是 ACES。

---

## 2. Android 端对象初始化与每帧流程

### 2.1 对象所有权

Android 端没有手写 Engine/Renderer/Scene/View，全部由 `SceneView` 创建并持有：

| 对象 | 创建/持有位置 | 说明 |
|---|---|---|
| `Engine` | SceneView 内部 | 默认 OpenGL 后端 |
| `Renderer` | SceneView 内部 | 每帧 `beginFrame/render/endFrame` |
| `Scene` | SceneView 内部 | 灯光与模型实体挂在这里 |
| `View` | SceneView 内部 | 后处理、阴影、SSAO、动态分辨率 |
| `Camera` | `SceneView.cameraNode` | 第一人称位姿每帧由 `VrCameraController` 写入 |
| `IndirectLight` / `Skybox` | `loadEnvironment()` | `studio_small_09_2k.hdr` |

关键代码位置：

- 布局：[activity_vr_walkthrough.xml:13-17](AndroidApp/app/src/main/res/layout/activity_vr_walkthrough.xml#L13-L17)
- 渲染回调注册：[VrWalkthroughActivity.kt:641-673](AndroidApp/app/src/main/java/com/hausen3d/arviewer/VrWalkthroughActivity.kt#L641-L673)
- 每帧输入/AR/相机合成：[VrWalkthroughActivity.kt:1099-1227](AndroidApp/app/src/main/java/com/hausen3d/arviewer/VrWalkthroughActivity.kt#L1099-L1227)
- 模型加载：[VrWalkthroughActivity.kt:342-500](AndroidApp/app/src/main/java/com/hausen3d/arviewer/VrWalkthroughActivity.kt#L342-L500)

### 2.2 桌面端必须自建的对象

桌面端 C++ 需要显式创建并管理：

```text
Engine → Renderer → Scene → View → Camera
        ├── IndirectLight / Skybox（IBL）
        ├── gltfio AssetLoader / ResourceLoader / MaterialProvider
        └── LightManager（SUN + POINT + FOCUSED_SPOT）
```

SceneView 额外提供的以下行为需要在桌面端重写，不能假设 Filament 自带：

- `ModelNode` 的模型居中、包围盒、`autoAnimate` 语义；
- `ModelLoader.createModelInstance(file)` 的 Android 文件/Asset 路径封装；
- `CameraNode.setProjection(FOV, near, far, Fov.VERTICAL, aspect)`；
- 轨道相机手势、触摸拾取、UI 生命周期。

---

## 3. 渲染资源清单

### 3.1 房间模型（性能基准样本）

文件：`.tmp_room_model.glb`（工作区根目录，66,543,536 B ≈ 63.5 MiB）。
说明：这是当前房间类模型的性能参考样本；手机实际导入的是 `Hausen_Room_3.glb`（运行时由用户选择，仓库内没有该文件）。方案中的“95.5 万三角形 / 50 材质 / 48 纹理”与本样本一致。

| 项目 | 数值 |
|---|---:|
| 文件大小 | 66,543,536 B（63.5 MiB） |
| meshes / primitives | 158 / 185 |
| nodes | 214 |
| 三角形 | **954,913** |
| 顶点（POSITION） | 763,491 |
| 材质 | **50**（39 个 doubleSided；49 OPAQUE，1 BLEND） |
| 图片 / 纹理 | **48 / 48**（全部内嵌） |
| 图片编码体积 | 38.5 MiB |
| 纹理解码后 RGBA8 | **184.3 MiB**（48.32 Mpx） |
| 含完整 mipmap 估算 | **245.8 MiB** |
| 动画 | 8 条（7 扇门 + 1 扇窗） |
| skin | 0 |
| glTF 自带灯 | 0（走自动布光路径） |
| 材质扩展 | `KHR_materials_clearcoat` ×2、`KHR_materials_specular` ×2、`KHR_materials_ior` ×1、`KHR_materials_transmission` ×1 |

纹理分辨率分布：

| 分辨率 | 数量 |
|---|---:|
| 1024 × 1024 | 43 |
| 2048 × 740 | 1 |
| 1400 × 430 | 1 |
| 600 × 800 | 1 |
| 430 × 1200 | 1 |
| 305 × 385 | 1 |

高密度几何（主 pass 与阴影 pass 都会重复消化）：

| mesh | 三角形 |
|---|---:|
| `Pleated_Curtain_Mesh` | 91,160 |
| `DoorDrapeWide_pleated_cloth` | 50,508 |
| `geometry_0.005` / `.001` / `.003` / `.002` / `.007` / `.009` | 约 4.8–5.0 万/个 |

动画名称：`Storage1_Door_swing`、`Lower_Right_Door_swing`、`Upper_Door_swing`、`Door_Centre_swing`、`Door_Left_swing`、`Door_Right_swing`、`Door_Leaf_swing`、`Operable_Right_Sash_slide`。

### 3.2 其他可用测试模型

| 文件 | 大小 | 三角形 | 材质 | 纹理 | 用途 |
|---|---:|---:|---:|---:|---|
| `测试模型/Avocado.glb` | 7.7 MB | 682 | 1 | 3 | 冒烟测试 |
| `测试模型/DamagedHelmet.glb` | 3.6 MB | 15,452 | 1 | 5 | PBR/IBL 快速验证 |
| `测试模型/Lantern.glb` | 9.1 MB | 5,394 | 1 | 4 | 发光材质验证 |
| `测试模型/Example_Room_2.glb` | 34.3 MB | 388,139 | 84 | 154 | 房间场景中等负载 |
| `测试模型/Room-nonagent.glb` | 24.0 MB | 210,288 | 19 | 0 | 纯几何房间 |

### 3.3 环境贴图

| 文件 | 大小 | 用途 |
|---|---:|---|
| `AndroidApp/app/src/main/assets/environments/studio_small_09_2k.hdr` | 6.1 MB | HDR IBL + 天空盒；运行时 `indirectLight.intensity = 0.25` |

### 3.4 材质

- 工程源码内**没有**自定义 `.mat` 或 `.filamat`。
- `AndroidApp/app/build/intermediates/.../materials/*.filamat` 是 SceneView 依赖自带的通用材质（`opaque_textured`、`transparent_textured` 等），不是本项目编写，房间模型也不使用它们。
- 房间材质全部是 glTF PBR + 上述 4 个 KHR 扩展，由 Filament gltfio 在运行时生成材质变体。
- 桌面端不需要 `matc` 重新编译任何项目材质。

### 3.5 自定义着色器 / PCSS 实现

- 没有自定义 GLSL。
- 没有修改 Filament Shadow Pass。
- PCSS 完全由 `View.setShadowType(View.ShadowType.PCSS)` 触发，属于 Filament 1.68.2 内置实现。

---

## 4. 相机与场景参数

| 参数 | 值 | 代码位置 |
|---|---|---|
| 竖直 FOV | **80°** | `VrWalkthroughActivity.kt:93` |
| 近平面 / 远平面 | **0.05 m / 100 m** | `VrWalkthroughActivity.kt:94-95` |
| 投影更新 | 宽高比变化时调用 `CameraNode.setProjection(80, 0.05, 100, VERTICAL, aspect)` | `VrWalkthroughActivity.kt:1229-1246` |
| 初始位置 | 模型包围盒中心 X/Z，`minY + 1.6 m` 人眼高度 | `VrWalkthroughActivity.kt:447-455` |
| 初始朝向 | 房间 X 尺寸 ≥ Z 时 yaw=90°，否则 0° | `VrWalkthroughActivity.kt:456-457` |
| 模型缩放 | 1:1，不缩放 | `VrWalkthroughActivity.kt:432` |
| 房间边界 | 由包围盒给出，用于限制漫游 | `VrWalkthroughActivity.kt:459-470` |

> 桌面性能测试应固定在同一“入口位姿”（房间中心、yaw 朝长轴、眼高 1.6 m），避免不同视角导致负载不可比。

---

## 5. 灯光与阴影配方

实现文件：[PhysicalRoomLighting.kt](AndroidApp/app/src/main/java/com/hausen3d/arviewer/rendering/PhysicalRoomLighting.kt)、[RoomLightLayout.kt](AndroidApp/app/src/main/java/com/hausen3d/arviewer/rendering/RoomLightLayout.kt)。

### 5.1 全局设置

| 项目 | 值 | 代码位置 |
|---|---|---|
| SceneView 默认主光 | 置空（避免 100000 lux 过曝） | `PhysicalRoomLighting.kt:33-35` |
| 曝光 | 光圈 f/0.7、快门 1/125 s、ISO 100 | `PhysicalRoomLighting.kt:36` |
| 阴影开关 | 开 | `PhysicalRoomLighting.kt:42` |
| 阴影过滤 | **PCSS** | `PhysicalRoomLighting.kt:43-50` |
| 软阴影参数 | `penumbraScale=1.0`、`penumbraRatioScale=1.0` | `PhysicalRoomLighting.kt:51-54` |
| 模型投射/接收阴影 | 全模型 `isShadowCaster=true`、`isShadowReceiver=true` | `PhysicalRoomLighting.kt:78-79` |

### 5.2 日光

| 参数 | 值 |
|---|---|
| 类型 | `LightManager.Type.SUN` |
| 强度 | **2500 lux** |
| 色温 | **6500 K**（`Colors.illuminantD`） |
| 方向 | 高度角 40°、旋转角 35°，公式见 `RoomLightLayout.sunDirection()` |
| 太阳角半径 | 1.5° |
| 阴影图 | **1024** |
| 级联 | **4** |
| `stable` | `true` |

方向公式（Y-up）：

```text
elevation = 40°, rotation = 35°
dir = ( -cos(elevation)*sin(rotation),
        -sin(elevation),
        -cos(elevation)*cos(rotation) )
```

### 5.3 局部灯（最多 4 盏）

| 类型 | 触发条件 | 功率/色温 | 位置 | 方向/锥角 | 阴影图 | bulbRadius |
|---|---|---|---:|---|---:|---:|
| 顶灯 `POINT` | mesh 名称以 `ceiling` 开头 | 60 W / 4700 K | 天花板包围盒中心，`min.y - 0.05 m` | 无 | 512 | 0.05 m |
| 窗灯 `FOCUSED_SPOT` | mesh 名称以 `window` 开头，排除 drape/sheer/curtain/blind | 20 W / 6500 K | 窗户包围盒中心向房间内侧 0.08 m | 朝向房间中心，含 -0.35 的向下分量 | 512 | 0.20 m |

补充规则：

- `falloff = max(房间对角线 × 1.5, 1 m)`。
- 窗灯锥角：内 45°、外 85°。
- `maxLocalLights = 4`，按“顶灯 + 窗灯”顺序取前 4 盏。
- 同一扇窗的多个窗框 mesh 会按 `window` 编号合并。
- `singleWindowShadowOnly = false`（基线），所有窗灯都请求阴影；若开启，只保留第一盏投影窗灯。
- 顶灯的 `castShadows(true)` 在 Filament 1.68.2 中**不会产生实时点光阴影**（Filament 不支持 POINT 实时阴影），属于无效请求；桌面端保持同样配置即可，不要误判为 6 面 cube shadow。

### 5.4 glTF 自带灯优先路径

若模型包含 `KHR_lights_punctual` 灯（`modelNode.lightNodes` 非空）：

- 不再叠加自动日光/顶灯/窗灯；
- 仅 `SPOT` / `FOCUSED_SPOT` 允许投影；
- `singleWindowShadowOnly` 时只保留第一盏投影 spot。

当前房间样本没有自带灯，走自动布光路径。

---

## 6. 后处理与画质

`applyQuality()` 位于 [PhysicalRoomLighting.kt:40-74](AndroidApp/app/src/main/java/com/hausen3d/arviewer/rendering/PhysicalRoomLighting.kt#L40-L74)。

| 项目 | 基线值 | 说明 |
|---|---|---|
| 阴影 | 开，PCSS | 见第 5 节 |
| SSAO | **开** | `setAmbientOcclusion(View.AmbientOcclusion.SSAO)` |
| SSAO 半径 | 0.35 | |
| SSAO 强度 | 0.65 | |
| SSAO 分辨率 | 0.5（半分辨率） | |
| SSAO quality / lowPass / upsampling | MEDIUM / MEDIUM / MEDIUM | |
| 色调映射 | **Filmic**（SceneView ColorGrading） | 代码里的 ACES setter 无 native 实现，不生效 |
| 抗锯齿 | **FXAA**（SceneView 默认） | MSAA 默认关闭 |
| 动态分辨率 | 基线关闭（`enabled=false`，`minScale=maxScale=1.0`） | 只有 `resolutionScale < 0.999` 才启用 |
| HDR 中间缓冲 | SceneView 默认 MEDIUM | |
| IBL 强度 | **0.25** | `VrWalkthroughActivity.kt:635` |
| Bloom / Vignette / DoF / TAA | 未配置 | 桌面端不要额外开启 |

> 桌面端复现顺序：先 Filmic + FXAA + IBL，再加 SSAO，再加 PCSS；每步都保留截图对照。

---

## 7. 分辨率与手机端性能基准

### 7.1 渲染分辨率

| 项目 | 值 |
|---|---|
| 设备 | HUAWEI P40 Pro（ELS-AN00） |
| 物理分辨率 | 1200 × 2640（竖屏）/ 2640 × 1200（横屏） |
| 横屏像素量 | **3,168,000 px**（约 316.8 万） |
| 应用内缩放 | 无（动态分辨率 1.0） |
| 屏幕刷新率 | 60 Hz |

### 7.2 已有基准数据（不同批次，需注意条件差异）

**阶段 1 `before`（3 轮，2026-10 前期）：**

| 指标 | 值 |
|---|---:|
| 平均 FPS | 56.509 |
| 中位 FPS | 60.444 |
| p50 帧时间 | 16.544 ms |
| p95 帧时间 | 16.557 ms |
| p99 帧时间 | 83.211 ms |
| >50 ms 帧比例 | 1.74% |
| >100 ms 帧比例 | 0.00% |
| PSS | 874,934 KB |
| cpuCallback | 0.659 ms |

**阶段 0 `A0-run1`（2026-10-31）：**

| 指标 | 值 |
|---|---:|
| 平均 FPS | 42.816 |
| 中位 FPS | 60.429 |
| p50 帧时间 | 16.548 ms |
| p95 帧时间 | 16.667 ms |
| p99 帧时间 | 366.547 ms |
| >50 ms 帧比例 | 3.62% |
| >100 ms 帧比例 | 1.752% |
| PSS | 891,389 KB |
| thermal | 4 |
| 质量摘要 | `shadow=PCSS ssao=true resolution=1.0 cascades=4 sunMap=1024 singleWindowShadow=false shadows=true ar=true lights=3 shadowRequests=3 ceiling=1 window=1 gltfLights=false` |

> 两批数据平均 FPS 差异较大（56.5 vs 42.8），可能来自热状态、AR 跟踪状态、模型/场景差异或采样窗口。桌面端对比时应重新采集手机基准，且必须记录热状态与 AR 状态。

### 7.3 指标口径

- 手机端 `RenderPerfMonitor` 记录的是**应用帧提交间隔**，不是独立 GPU 时间。
- 桌面端应同时记录：帧间隔 p50/p95/p99、CPU 帧时间、GPU 帧时间（Filament `TimerQuery` 或 Nsight/PresentMon）、显存占用。
- 不要把手机端帧间隔直接与桌面 GPU 时间相加或相减。

---

## 8. 桌面端迁移分类

### 8.1 可以直接复用

| 资源/内容 | 处理 |
|---|---|
| `.tmp_room_model.glb` / `Hausen_Room_3.glb` | 直接复制到 `FilamentDesktop/assets/models/`，桌面 gltfio 加载 |
| GLB 内嵌 PNG/JPEG 纹理 | 直接复用；由 gltfio 解码 |
| `studio_small_09_2k.hdr` | 可直接作为 HDR 源；建议用 Filament `cmgen` 离线生成 KTX IBL 以保证桌面/手机一致并减少启动开销 |
| glTF PBR 材质参数 | 直接复用；不需要 `.filamat` |
| 灯光配方数值 | 直接照抄（第 5 节） |
| 质量参数数值 | 直接照抄（第 6 节） |

### 8.2 需要转换/生成

| 内容 | 处理 |
|---|---|
| HDR → IBL | `cmgen --type=ktx --format=rgb10_a2`（或与手机 SceneView `EnvironmentLoader` 等价规格），同时生成 skybox |
| 纹理压缩（可选） | 第一轮保持原 PNG/JPEG，避免引入视觉变量；性能测试稳定后再评估 KTX2/ASTC |
| 模型变体（可选） | 第一轮用原始 GLB；低模阴影代理留到阶段 3 以后 |

### 8.3 必须用 C++ 重写

| Android 实现 | 桌面端重写内容 |
|---|---|
| SceneView 创建 Engine/Renderer/Scene/View | 显式生命周期管理 |
| `ModelLoader.createModelInstance(file)` | gltfio `AssetLoader` + `ResourceLoader` + `NameComponentManager` + `MaterialProvider` |
| `ModelNode` 包围盒/居中/动画 | 场景节点变换、包围盒计算、Animator 更新 |
| `CameraNode.setProjection` | `Camera::setProjection(80, aspect, 0.05, 100, FOV_VERTICAL)` |
| `PhysicalRoomLighting` | 逐项移植：SUN/POINT/FOCUSED_SPOT、阴影选项、曝光 |
| `RoomLightLayout` | 逐行移植：包围盒、窗户合并、顶灯/窗灯位置、falloff |
| `RoomRenderQuality` | 桌面端质量配置结构体 |
| `RenderPerfMonitor` | 桌面端帧时间统计 + CSV 输出 |
| `VrCameraController` | 桌面端固定轨迹/自由相机；不需要 AR 部分 |
| UI/触摸/手势/SAF | 桌面端窗口 + 键盘，或直接固定相机 |

### 8.4 不迁移

- 华为 AR Engine（`ARSession`、`ARWorldTrackingConfig`、位姿/Anchor）；
- 相机背景 `CameraBackgroundRenderer` / `ArPoseRenderer`；
- AR 放置、手势、门窗点击拾取（性能测试阶段不需要）；
- Android 生命周期、权限、沉浸式 UI、文件选择器。

### 8.5 平台兼容性风险

| 风险 | 说明 | 验证方式 |
|---|---|---|
| VS 版本 | 方案要求 VS 2022；当前机器只有 VS 2019（MSVC 14.29） | 阶段 1 安装 VS 2022 或先试 VS2019 |
| CMake/Ninja | 系统 PATH 中没有；VS2019 自带 CMake/Ninja 可用 | `cmake --version` |
| Windows SDK | 当前只有 10.0.19041 | VS2022 安装时补新 SDK |
| gltfio 扩展 | `KHR_materials_transmission` 在桌面端需要额外渲染通道，成本可能高于手机预期 | 加载房间模型后对比玻璃/窗户外观 |
| Filmic vs ACES | 桌面端若误用 ACES 会改变整体观感 | 用 SceneView 截图对照 |
| 点光阴影 | Filament 1.68 不支持 POINT 实时阴影，手机端同样如此 | 不要预期桌面端顶灯有投影 |
| 双面材质 | 39/50 材质 doubleSided，桌面端背面剔除行为需一致 | 对比墙面/窗帘 |
| Vulkan 设备选择 | 笔记本可能使用核显 | `vulkaninfo` / Filament 日志确认 RTX 4050 |

---

## 9. 桌面最小可运行版本（M0）功能清单

阶段 2 的第一版不追求完整交互，只要求“同场景、同配方、可测帧率”：

1. 创建 1280×720（或 2640×1200）窗口与 Filament Engine（优先 Vulkan，回退 OpenGL）。
2. 加载 `.tmp_room_model.glb`（gltfio），输出 mesh/primitive/triangle/material/texture 统计。
3. 加载 IBL + Skybox，`indirectLight.intensity = 0.25`。
4. 相机固定在房间入口位姿：中心 X/Z、`minY + 1.6 m`、yaw 朝长轴、FOV 80°、near 0.05 / far 100。
5. 复现灯光：SUN 2500 lux / 6500 K / 4 级 1024 / stable；顶灯 60 W / 4700 K；窗灯 20 W / 6500 K / 45°–85°；最多 4 盏。
6. 复现 View 设置：PCSS、`penumbraScale=1`、`penumbraRatioScale=1`、SSAO（0.35/0.65/0.5/MEDIUM）、Filmic ColorGrading、FXAA、曝光 f/0.7 / 1/125 / ISO100。
7. 每秒输出帧间隔 p50/p95/p99、平均 FPS、CPU 帧时间；可选 GPU 时间。
8. 支持 `--resolution WxH`、`--vsync on/off`、`--fixed-camera` 参数，便于阶段 3 分组测试。
9. 验收：程序稳定运行、模型/纹理/灯光/阴影正确、能确认使用 RTX 4050。

---

## 10. 当前电脑环境探测结果（2026-11-08）

| 项目 | 结果 |
|---|---|
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU，6,141 MiB 显存，驱动 597.13 |
| Visual Studio | **仅 VS 2019 Community**（MSVC 14.29.30037 / 14.29.30133） |
| VS 2022 | 未安装 |
| Windows SDK | 10.0.19041.0（仅此一个） |
| 系统 CMake / Ninja | PATH 中没有 |
| VS2019 自带 CMake/Ninja | 存在（`Common7/IDE/CommonExtensions/Microsoft/CMake/...`） |
| Git | 2.55.0.windows.3 |
| Python | 3.12.11 |
| D 盘可用空间 | 148 GB |

**阶段 1 的前置动作：**

1. 安装 Visual Studio 2022（C++ 桌面开发、MSVC x64、Windows 11 SDK、CMake 工具）。
2. 获取 Filament v1.68.2 源码（建议浅克隆以节省时间）。
3. 编译 `gltf_viewer`，用 `测试模型/DamagedHelmet.glb` 冒烟。
4. 确认渲染后端为 RTX 4050（Vulkan）。

---

## 11. 下一步（阶段 1 执行顺序）

```text
[已完成] 阶段 0：源码分析 + 资源清单（本文档）
   ↓
[进行中] 阶段 1：安装/确认 VS2022 与 SDK → 浅克隆 Filament v1.68.2 → CMake 配置 → 编译 gltf_viewer
   ↓
阶段 2：复制模型/HDR → 自建 C++ 场景 → 逐步恢复材质/灯光/阴影/后处理
   ↓
阶段 3：PC-01 ~ PC-04 分组测试 + PresentMon/Nsight 采集
```

> 阶段 0 完成标准已满足：Android 端渲染资源、配置、代码位置、复用/重写分类均已明确。
