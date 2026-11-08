# B0/B1 复现说明

## 工程与依赖边界

`BakingPipeline` 是独立电脑端工具工程，不属于 Android Gradle，不读取或写入 Android assets。所有命令均从工作区根目录 `D:\Obsidian_project\3D视觉大作业` 执行。

- Blender：4.5.3 LTS，工程内便携路径 `BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe`。
- 系统 Python：现有 3.12.11；`inspect_source.py` 和 `capture_b0.py` 只用标准库。
- 图像校验/对照：复用现有 Python 的 Pillow；没有全局安装任何包。
- Blender 数值检查：使用其自带 Python 3.11.11 与 NumPy。
- ADB：复用 `D:\Android\AndroidSDK\platform-tools\adb.exe`，只用于来源哈希、A0 截图和日志核对。
- GPU：NVIDIA GeForce RTX 4050 Laptop GPU，Cycles 优先 OPTIX；无兼容 GPU 时脚本记录 CPU 回退，不虚报 GPU。

便携 Blender 来自官方 `https://download.blender.org/release/Blender4.5/blender-4.5.3-windows-x64.zip`，ZIP SHA-256 为 `6b657c8bdd3a7b65b07b9e1ae17eb4be7dd4aa23121da7f3d3354fc2551330a7`。`.tools/`、`output/` 和 Python 缓存均由 `BakingPipeline/.gitignore` 排除；大型生成物默认不入 Git。

## 固定输入

配置：`BakingPipeline/configs/example_room_2.json`

- GLB：`测试模型/Example_Room_2.glb`
- GLB SHA-256：`812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`
- HDR：`AndroidApp/app/src/main/assets/environments/studio_small_09_2k.hdr`
- HDR SHA-256：`ad995fe96d922bd20ad25f98c862006325e095431176646500d717ada1ed3f61`

每次准备和烘焙都会校验输入哈希。不要重命名替换模型后继续沿用该配置；更换模型必须新建配置并重新核对动画后代、灯光和 A0 基准。

## 环境探测

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background --factory-startup --python-exit-code 1 \
  --python BakingPipeline/scripts/probe_blender.py
```

结果：`output/environment.json`。该步骤只探测本机能力，不安装依赖。

## B0 来源与实时视角

```bash
python BakingPipeline/scripts/inspect_source.py \
  --config BakingPipeline/configs/example_room_2.json

python BakingPipeline/scripts/capture_b0.py \
  --config BakingPipeline/configs/example_room_2.json
```

`capture_b0.py` 要求手机仍保留同一原始文件和应用私有副本，三处哈希不一致会停止。它只采集 A0 画面，不启动固定轨迹性能实验。左右视角通过正常漫游入口采集，因此复现时不要停留在文件选择器或诊断对话框。

## B1 准备与烘焙

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background --factory-startup --python-exit-code 1 \
  --python BakingPipeline/scripts/prepare_room.py -- \
  --config BakingPipeline/configs/example_room_2.json

BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.prepared.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/bake_room.py -- \
  --config BakingPipeline/configs/example_room_2.json
```

准备阶段完成：原模型导入、动画后代/特殊材质分类、当前灯光布局、共享 UV2 图集和四个固定相机。烘焙阶段依次生成 direct-diffuse、indirect、AO，再渲染静态烘焙诊断图和恢复全部对象后的完整 PBR 图，最后导出独立 `*.baked.glb`。

UV2 在临时合并的静态网格上统一展开和打包，再通过 `B1_SOURCE_OBJECT` / `B1_SOURCE_LOOP` 属性逐 loop 传回原对象；每个源 loop 的映射数量必须吻合，UV 三角形面积总和不得超过 1。早期多对象分别打包产生了面积 2.368 的重叠图集，已移至 `iterations/32-sample-invalid-uv`，不计为通过结果。

光照 UV 不固定等于 `TEXCOORD_1`：1,181 个对象使用 `TEXCOORD_1`，21 个原已有两套 UV 的对象使用 `TEXCOORD_2`。`extras.lightmapUvIndex` 按 Blender 中真实层索引写入，校验器也按该值读取，不能硬编码通道 1。

为避免 Cycles 对 1,202 个对象分别执行整轮 bake，脚本只在烘焙期间复制并临时合并静态网格，共用既有 UV2 图集；三通道完成后删除临时合并体，恢复原始静态对象再预览和导出。最终 GLB 不通过合并全屋来换取烘焙速度，动画节点和门窗父链保留。首次逐对象运行的中止日志保留为 `bake-multi-object-aborted.log`，不计为有效贴图。

只重渲染、不重新烘焙（要求已有三通道和 `bake-report.json`）：

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/bake_room.py -- \
  --config BakingPipeline/configs/example_room_2.json --render-only
```

只更新元数据并重新导出，不重烘、不重渲染：

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/bake_room.py -- \
  --config BakingPipeline/configs/example_room_2.json --export-only
```

## 校验与对照

```bash
python BakingPipeline/scripts/validate_output.py \
  --config BakingPipeline/configs/example_room_2.json

python BakingPipeline/scripts/make_contact_sheets.py \
  --config BakingPipeline/configs/example_room_2.json
```

结构校验覆盖：原文件哈希、源/导出节点、父子层级及角色、按 `lightmapUvIndex` 读取的静态 UV 存在性和范围、UV 三角形面积总和、4 条动画、无 `KHR_materials_unlit`、无导出 punctual lights、三张 lightmap 主文件。UV 总面积和 Blender pack 结果不能替代 exhaustive 像素级重叠证明，报告保留这一边界。

## 输出说明

| 路径（均在 `output/example_room_2/`） | 含义 |
|---|---|
| `b0/` | 当前手机来源检查、四个 A0 视角、日志和单点内存信息 |
| `example_room_2.prepared.blend` | 含分类、灯光、相机和 UV2 的准备场景 |
| `lightmaps/direct-diffuse.exr` | 线性 direct-diffuse 主资产，不含 COLOR、镜面、反射、ACES 或 FXAA |
| `lightmaps/indirect.exr` | 线性间接漫反射主资产，不含 ACES/FXAA |
| `lightmaps/ao.png` | Non-Color AO 主资产，不经过 ACES/FXAA |
| `previews/lightmaps/*-display.png` | 仅供人眼查看的显示转换副本，不是 B2 输入主资产 |
| `previews/*-baked-static-diagnostic.png` | 仅静态集合的诊断合成；动态/特殊对象故意隐藏，不是最终混合材质 |
| `previews/*-offline-full-pbr.png` | 恢复动态/特殊对象、灯光、PBR 材质后的离线参考图 |
| `example_room_2.baked.glb` | 带 UV2 与烘焙元数据的独立原型，不覆盖原 GLB，未接入手机 |
| `example_room_2.baked.blend` | 可继续检查/重渲染的离线场景 |
| `validation-report.json` | 导出结构与 UV 校验，不代表视觉或性能验收通过 |

`previews/*-baked-static-diagnostic.png` 使用临时诊断材质显示“原底色 × (direct + indirect) × AO”，完成后即恢复原 PBR 材质并删除诊断材质。它不是把手机全屋改成 unlit 的实现，也不包含动态门窗或高光验收结论。

## 2026-11-02 B1 视觉整改复核

### 保留上一轮并定位黑带

上一轮完整产物位于 `output/example_room_2/iterations/256-sample-inward-normals/`，包括原 lightmap、场景、GLB 和预览，不要覆盖。`diagnostics/initial-isolation/` 保存了 direct、indirect、AO、原底色、UV checker、材质 ID 和射线采样报告。`diagnostics/normal-audit.json` 记录法线方向与按 1 微米位置容差计算的封闭性。

可重新执行数值与几何检查；初次隔离图的渲染选项为 `--render`，只做复核时可以省略，避免重复渲染：

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/diagnose_b1.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --label initial-isolation --views 01-entry 02-reverse --render

BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/audit_b1_normals.py -- \
  --config BakingPipeline/configs/example_room_2.json
```

### 只更新有依据的灯光换算，不重做 UV2

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.prepared.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/prepare_room.py -- \
  --config BakingPipeline/configs/example_room_2.json --lighting-only
```

Filament 1.68.2 的 `EFFICIENCY_LED = 0.1171`，`intensity(watts, efficiency)` 的光通量为 `watts × efficiency × 683` 流明。每盏顶灯因此为 `60 × 0.1171 × 683 = 4798.758 lm`，本轮 Cycles 使用等效光度功率值 `4798.758`；日光使用 `2500`。`filamentPhotometricUnitToCycles = 1.0`，不再对 lux/lumen 额外除以 683。

LightManager 源码中瓦数转流明只执行一次，SUN 保留 lux，POINT 再由流明换算 candela，没有额外的 `1/683` 归一化。曾生成的 `7.026 / 3.660322` 版本在手机相机曝光下近黑，已停止后续渲染并归档为 `iterations/256-sample-photopic-scale-rejected/`，不能计为有效修正版。

`--lighting-only` 会比较灯型、位置、方向、色温、falloff、半径和日光角半径，不变时才保存，不重新展开或打包 UV2。可先用下列命令生成单张完整 PBR 校准图，确认单位链路后再重烘；`diagnostics/photometric-unit-check.json` 记录实际灯值和显示参数：

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.prepared.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/preview_pbr.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --view 02-reverse --label photometric-unit-check --resolution-percent 50
```

依据：[LightManager.java](https://raw.githubusercontent.com/google/filament/v1.68.2/android/filament-android/src/main/java/com/google/android/filament/LightManager.java)、[LightManager.cpp](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/components/LightManager.cpp)。

### 法线修正与正式烘焙

正式命令与上文 B1 烘焙命令相同。`create_bake_proxy` 现在只在临时烘焙副本中翻转“负体积且按位置容差确认封闭”的网格；开放薄片不凭体积符号翻转。每个翻转副本都按多边形和顶点核对 UV2，避免把 `flip_normals` 合法的 loop 顺序变化误判为 UV 破坏。原 GLB、导出 GLB 的法线及原对象不变，动态/特殊对象仍在每次静态烘焙中隐藏。

校验器新增原法线数据一致性、既有 UV2 面积/通道分配不变量、八张预览 PNG 格式/尺寸及本轮生成时间检查。`previews/scene-linear/*.exr` 是显示复核用的场景线性渲染，不是 lightmap 主资产。

### 手机相机曝光与 ACES 显示预览

手机原配方为 `f/0.7、1/125 s、ISO 100`。按 Filament `Exposure.cpp`，`EV100 = 5.936637939`，线性曝光因子为 `0.01360544218`，相当于 Blender `exposure = -6.199672345` 档。该曝光只用于预览显示，不乘入 lightmap。

`filament_display.py` 对场景线性 EXR 实现 Filament 1.68.2 `ACESToneMapper` 算子及线性 sRGB/Rec.2020 转换，再以 Standard sRGB 输出 PNG。ACES、FXAA、高光和反射没有烘入三通道。LUT 量化、gamut mapping、抖动、FXAA 和 IBL 预滤波不因此自动等价，仍需对照验收。

依据：[Exposure.cpp](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/Exposure.cpp)、[ToneMapper.cpp](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/ToneMapper.cpp)、[ColorSpaceUtils.h](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/ColorSpaceUtils.h)。

最终对照仍执行上文的 `validate_output.py` 和 `make_contact_sheets.py`。后者额外生成 `contact-b1-remediation-*.jpg` 三列对照及 `visual-review.json` 辅助指标；三列依次为手机 A0、上一轮失败图和本轮修正图，不以 MAE 自动判定通过。

### 显示重输出、抽样复核与本轮结论

只从已有场景线性 EXR 重输出八张 PNG，不重烘、不重渲染：

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/reprocess_previews.py -- \
  --config BakingPipeline/configs/example_room_2.json
```

复查同一组对象、法线和通道采样，不重复初次隔离渲染：

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/diagnose_b1.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --label remediation-isolation --views 01-entry 02-reverse
```

源法线检查按相同位置的最近法线比较，允许 UV seam 改变顶点数量和 primitive 顺序；容差为 `0.001`，本轮最大差值 `0.0006744503`，不是逐位相同的声明。另将当前 GLB 与 `review.previousBaked` 比较，NORMAL 和 UV2 数组必须逐值一致。`pre-gamut-previews/`、`rejected-gamut-matrix/` 保存被拒绝的显示试验；最终路径没有采用会产生纯红斑块的 gamut 实现。

**本轮最终为“结构通过、黑带整改有效、B1 整体视觉仍未通过”。** 新 GLB SHA-256 为 `36acf40703c5f2cde3e87ddb34d206f252c0e3b4d6229d869188fe7e2954246b`，主图哈希和完整四视角证据见 [B1-offline-prototype.md](B1-offline-prototype.md) 的 2026-11-02 复核部分。未进入 B2，未修改 Android，未补标 A8、真实录像或当前模型性能基线。

---

## 2026-11-07 B1 同条件标定

详细结论见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)。本轮只执行标定、现有 EXR 显示重输出和小样，不执行 `bake_room.py`，不重做 UV2，不进入 B2。

### 临时原始模型与四张视觉标定图

`capture_b1_calibration.py` 使用临时私有原始副本，不改写旧模型文件或 Android assets。以下命令只在标定目录生成结果，旧 B0 不覆盖。创建副本后核对 SHA-256 必须为 `812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`：

```bash
export MSYS_NO_PATHCONV=1
ADB="D:/Android/AndroidSDK/platform-tools/adb.exe"
"$ADB" push "测试模型/Example_Room_2.glb" /data/local/tmp/b1-example.glb
"$ADB" shell run-as com.hausen3d.arviewer cp /data/local/tmp/b1-example.glb /data/user/0/com.hausen3d.arviewer/files/models/current/B1-Example-calibration.glb
"$ADB" shell run-as com.hausen3d.arviewer sha256sum /data/user/0/com.hausen3d.arviewer/files/models/current/B1-Example-calibration.glb
python BakingPipeline/scripts/capture_b1_calibration.py --config BakingPipeline/configs/example_room_2.json
```

脚本调用 `JdiCalibration.java`，每次在 `onSceneFrame` 断点事件中读取原生投影、剔除矩阵、相机模型矩阵、曝光、viewport 和 color grading 对象，再恢复执行。它只采集 A0 视觉标定，不运行固定性能轨迹。Java 使用现有 Android Studio JBR，不安装依赖；如路径不同，传 `--adb` 和 `--java`。

手动复现单次 JDWP 读取：

```bash
PID=$("$ADB" shell pidof com.hausen3d.arviewer | tr -d '\r')
"$ADB" forward tcp:18700 "jdwp:$PID"
"D:/Android/AndroidStudio/android-studio/jbr/bin/java.exe" --add-modules jdk.jdi BakingPipeline/scripts/JdiCalibration.java 18700
"$ADB" forward --remove tcp:18700
```

四张图、日志和 `capture-metadata.json` 位于 `diagnostics/same-condition-calibration/a0/`。右侧通过最多三次有界输入回读修正到既定朝向容差 `0.25°`，不修改相机参数。

### 只读场景与材质报告

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/calibrate_b1.py -- \
  --config BakingPipeline/configs/example_room_2.json
```

### 用现有线性 EXR 输出实际 Filmic 对照

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/reprocess_previews.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --output-dir BakingPipeline/output/example_room_2/diagnostics/same-condition-calibration/display
```

不传 `--output-dir` 时才更新主预览和主 `bake-report.json`。本轮传入独立目录，10.5 的主报告与旧图未覆盖；没有重烘或重渲染 lightmap。Filmic 解析算子不冒充 32³ LUT、抖动和 FXAA 的完整复现，也没有 gamut mapping。

### 日光、四盏顶灯和 IBL 小样

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/calibrate_b1.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --render-contributions --views 01-entry 02-reverse \
  --resolution-percent 25 --samples 32
```

### 色温归一化候选及同条件基线（未采纳）

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/calibrate_b1.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --render-contributions --views 01-entry 02-reverse \
  --variants all --resolution-percent 50 --samples 32 \
  --label light-color-unnormalized-baseline

BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/calibrate_b1.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --render-contributions --views 01-entry 02-reverse \
  --variants all --resolution-percent 50 --samples 32 \
  --label light-color-normalization --normalize-light-colors
```

小样只在内存中切换诊断光源，随后恢复，不保存 `.blend`、不导出 GLB、不触发烘焙。归一化候选未解决偏色，没有纳入正式参数。

### 生成并打开对照图

```bash
python BakingPipeline/scripts/make_b1_calibration_review.py --config BakingPipeline/configs/example_room_2.json
```

必须实际打开 `contact-a0-display.jpg`、`contact-contributions.jpg`、`contact-light-color-normalization.jpg` 和 `contact-transmission-entry.jpg` 逐项检查，不能只读取 MAE。最终结论仍为“视觉仍未通过”，不进入 B2。

手机原模型偏好和文件应在标定后恢复；临时私有副本只用于当次采集。旧模型加载失败时不要继续采集，更不能把其他模型截图混入同条件对照。

---

## 2026-11-07 B1 剩余视觉复核

详细结论见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)。以下命令只使用现有 EXR、只读材质/对象采样和低分辨率 Cycles 通道小样；**不要执行 `bake_room.py`，不要进入 B2。** 所有输出写入 `output/example_room_2/diagnostics/remaining-visual-review/`，不覆盖主预览、lightmap、GLB 或 Android assets。

### 显示链分项：同一 EXR，不重渲染

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/diagnose_b1_display.py -- \
  --config BakingPipeline/configs/example_room_2.json
```

输出 `display/`：source-order 解析 Filmic、R11F_G11F_B10F、32³ LogC LUT，以及 HDR＋LUT＋固定时域种子抖动四组 PNG 和 `report.json`。曝光先于 HDR 量化；LUT 输出经过 binary16 与 RGB10_A2。该模型不是设备纹理读回，不包含 FXAA、PCSS/SSAO、透射、Android 合成或驱动 fallback 证明。

### 材质报告与两个视角的 Cycles 通道小样

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/diagnose_b1_lighting.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --render-passes --views 01-entry 04-right \
  --resolution-percent 25 --samples 32 \
  > BakingPipeline/output/example_room_2/diagnostics/remaining-visual-review/lighting/pass-render.log 2>&1
```

只生成材质采样需要时省略 `--render-passes`。渲染保持原灯光、材质、IBL、对象和几何，不保存 `.blend`。每个视角使用独立合成输出节点和独立 `Combined.exr`；最终 `pass-render.log` 只应出现对应诊断目录，不能交叉写视角或写入 `previews/`。

### 按 Cycles 颜色通道加权，不重复渲染

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/reprocess_b1_passes.py -- \
  --config BakingPipeline/configs/example_room_2.json
```

`decomposition-report.json` 和 `*Weighted.png` 使用 `(DiffDir + DiffInd) × DiffCol + (GlossDir + GlossInd) × GlossCol`。不要把原始 DiffDir/GlossDir 不加权直接求和，也不要把透射/自发光缺失时的重构残差当成验收指标。

### 生成并实际打开复核图

```bash
python BakingPipeline/scripts/make_b1_display_review.py --config BakingPipeline/configs/example_room_2.json
```

必须打开：

- `contact-display-four-views.jpg`
- `contact-display-stages-entry.jpg`
- `contact-display-rois.jpg`
- `contact-lighting-passes.jpg`

脚本中的 `manualVisualAcceptance` 初始为待人工复核；只有实际打开图像后才能把 `review.json` 和文档更新为最终人工结论。当前结论为**视觉仍未通过**，不采纳显示、灯光、材质或 IBL 新修正，不进入 B2。未重跑 A0–A7，未修改手机材质、灯光、AR、位姿、门窗交互或 `任务进度.md`。

## 2026-11-08 B1 顶面法线/背面与阴影边界

详细结论见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)。以下命令只读打开现有 baked `.blend`，不保存场景、不重烘、不导出 GLB、不写主预览或 Android assets；输出只写入 `output/example_room_2/diagnostics/ceiling-boundary/`。

### 只读几何/光照采样与法线、阴影变体

```bash
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  --background BakingPipeline/output/example_room_2/example_room_2.baked.blend \
  --python-exit-code 1 \
  --python BakingPipeline/scripts/diagnose_b1_ceiling_boundary.py -- \
  --config BakingPipeline/configs/example_room_2.json \
  --views 01-entry 04-right \
  --render-normal --render-shadow-tests
```

脚本先校验场景 `sourceSha256` 与原 GLB 哈希，再对固定样点做射线、材质和灯光计算；`--render-normal` 用临时 emission override 输出 view-facing 的 `Geometry > Normal` 与 `True Normal`（它们不是 authored winding 的可视化）；`--render-shadow-tests` 临时关闭阴影渲染 `baseline`、`ceiling-lights-no-shadow`、`ceiling-objects-no-shadow`、`all-no-shadow` 四组，结束后恢复灯光 `use_shadow` 和对象 `visible_shadow`。输出 `scene-report.json`、`normal/*.png`、`shadow-tests/*.png` 与线性 EXR。该脚本不执行 bake、不保存 `.blend`。

### 生成并实际打开顶面/阴影对照图

```bash
python BakingPipeline/scripts/make_b1_ceiling_boundary_review.py \
  --config BakingPipeline/configs/example_room_2.json
```

必须打开 `contact-ceiling-boundary.jpg`，并核对 `review.json` 的 `referenceSample`、`ceilingBandMeanRgb`、`shadowVariantMeanRgb`。当前结论：源顶面法线朝上、相机看背面；Cycles 翻转背面法线并点亮顶面；关闭阴影只会让离线画面更亮，顶面光斑仍在，没有证据支持削弱阴影或改法线/粗糙度/Specular。`manualVisualAcceptance` 保持**视觉仍未通过**，不进入 B2。

## 2026-11-08 续 B1 手机侧只读探针

详细结论见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)。本节命令只读：`JdiMaterialProbe.java` 在 `VrWalkthroughActivity.onSceneFrame(J)V` 设一次断点，只调用 getter（材质实例、RenderableManager、LightManager、View），不调用 setter、不改材质/灯光、不写设备。不修改手机代码、Android assets 或烘焙配方。

### 前置条件

- 安装现有 debug 诊断 APK（可 JDWP 调试），设备已连接且 `adb devices` 可见。
- 设备内当前模型 `B1-Example-calibration.glb` 的 SHA-256 必须是 `812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`；每次启动和截图前校验。
- 先启动应用并等待模型加载；探针需要 `onSceneFrame` 已在运行。

### 只读探针与 A6 / A1_DPCF / A0 截图

```bash
ADB="D:/Android/AndroidSDK/platform-tools/adb.exe"
JAVA="D:/Android/AndroidStudio/android-studio/jbr/bin/java.exe"
MODEL="/data/user/0/com.hausen3d.arviewer/files/models/current/B1-Example-calibration.glb"
OUT="BakingPipeline/output/example_room_2/diagnostics/ceiling-boundary/phone-probe"

"$ADB" shell run-as com.hausen3d.arviewer sha256sum "$MODEL"   # 必须为 812c8efe…
"$ADB" shell am force-stop com.hausen3d.arviewer
"$ADB" shell am start -a com.hausen3d.arviewer.action.DEBUG_CAPTURE_VIEW \
  -n com.hausen3d.arviewer/.VrWalkthroughActivity \
  --es experiment A1_DPCF --es view entry --es model_path "$MODEL"
sleep 14
PID=$("$ADB" shell pidof com.hausen3d.arviewer | tr -d '\r')
"$ADB" forward tcp:18700 "jdwp:$PID"
"$JAVA" --add-modules jdk.jdi BakingPipeline/scripts/JdiMaterialProbe.java 18700 \
  | tee "$OUT/runtime-material-probe-a1-dpcf.json"
"$ADB" exec-out screencap -p > "$OUT/01-entry-android-a1-dpcf.png"
"$ADB" forward --remove tcp:18700
```

将 `--es experiment A1_DPCF` 分别替换为 `A6`、`A0` 可得到关闭全部阴影和 A0 复现截图；`--es view` 只支持 `entry` / `piano`。`01-entry-android-a6-no-shadow.png`、`01-entry-android-a1-dpcf.png`、`01-entry-android-a0-restored.png` 均按上述顺序采集，日志用 `adb logcat -d -s VrWalkthrough:I` 保存。本次保存的日志只含周期性位姿行，**未含** `VisualCapture` 行（安装的预编译 debug APK 可能早于该日志语句）；实验是否生效以 JDI 探针读回的 `currentExperiment` 与 `quality` 为准。Windows/Git Bash 下二进制截图也可用 Python `subprocess` + `exec-out` 避免换行转换。

探针输出为一行 `MATERIAL_PROBE_JSON {...}`（原始 A0 文件保留了该前缀，A6/A1_DPCF/A0 复现文件已去掉前缀并格式化为 JSON），关键字段：`currentExperiment`、`quality.{shadowFilter,shadowsEnabled}`、`shadowingEnabled`、`ceilingMaterialInstance.{instanceName,instanceDoubleSided,materialName,materialDoubleSided,shading}`、`ceilingShadowReceiver`、`ceilingLightChannels`、`lights[].{type,position,intensity,falloff,shadowCaster,lightChannels}`。

### 生成并实际打开手机侧对照图

```bash
python BakingPipeline/scripts/make_b1_phone_probe_review.py \
  --config BakingPipeline/configs/example_room_2.json
```

必须打开 `phone-probe/contact-phone-probe.jpg`，并核对 `phone-probe/ceiling-roi.json` 的 `measurements`、`runtimeProbe`、`caveats`。注意：既有 `ceiling-boundary/review.json` 的 `ceilingBandMeanRgb` 顶带包含墙面/窗户，不能当作顶面均值；顶面数字以 `ceiling-roi.json` 为准。

当前结论：运行时 `isDoubleSided=true` 证明 Filament 在背面翻转法线；A6 与 A1_DPCF 均点亮顶面，512 贴图分辨率单独不足以解释 A0 近黑；A0 复现明亮但 `applyQuality(A0)` 未证实，且一盏 POINT 灯位在运行间不同，PCSS 近灯自阴影与遮挡体**无法唯一归因**。A0 复现采集后设备断连，`mAmbientOcclusionOptions` 读回未完成。`manualVisualAcceptance` 保持**视觉仍未通过**，不进入 B2；本轮无性能采集，未重跑 A0–A7。
