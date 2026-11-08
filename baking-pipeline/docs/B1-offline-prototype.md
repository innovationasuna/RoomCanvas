# B1 离线烘焙原型：Example_Room_2

日期：2026-11-01  
输入与实时基准：见 [B0-baseline.md](B0-baseline.md)  
复现命令：见 [reproduction.md](reproduction.md)

## 验收状态

**离线资产已实际生成，最终结构校验通过；视觉对照未达到当前完整实时 A0，B1 决策门未通过。未进入 B2 手机材质接入，也未进入 B3/B4 或其他实时优化阶段。**

最终导出：`output/example_room_2/example_room_2.baked.glb`  
SHA-256：`bc593f56125fa3eb5c10f3cb6920dfecd3d78821e2d68e5a235b98e657ad8137`

原始 GLB、旧 A0 样本、HDR、Android 源码与 assets 均未覆盖。没有修改 `任务进度.md`，没有创建 Git 提交。

## 环境与固定参数

- Blender 4.5.3 LTS，工程内便携安装；官方 ZIP 哈希已核对。
- Cycles / OPTIX，NVIDIA GeForce RTX 4050 Laptop GPU。
- 单张共享图集 4096×4096；256 samples；adaptive threshold 0.01；启用 denoising。
- 最大反弹 6，diffuse 4，glossy 4，transmission 6，transparent 8。
- 图集扩展边距 8 px，`EXTEND`；AO 距离 0.35 m。
- 完整 PBR 预览 64 samples，2486×1200；80° 竖直 FOV，near 0.05 m，far 100 m。
- 预览显示变换为 AgX / Medium High Contrast / exposure 0，仅用于离线查看；**没有把 AgX、ACES 或 FXAA 烘进 lightmap**。
- 当前手机配方是日光＋4 顶灯、无窗灯。离线保留 2500 lux / 6500K 日光定义及 4 个 60W / 4700K 顶灯位置；HDR IBL 强度 0.25。
- 日光以 `2500 / 683 = 3.660322` Cycles irradiance 近似转换；Filament falloff 10.7866 m 只记录为元数据，Cycles 没有擅自用不同灯型或截断模拟。

完整参数在 `configs/example_room_2.json`，灯位和相机坐标在 `output/example_room_2/preparation-report.json`。

## 静态、动态与特殊集合

| 集合 | mesh 数 | 三角形 | 处理 |
|---|---:|---:|---|
| 静态烘焙 | 1,202 | 342,185 | 建立共享 UV2，参与三通道烘焙 |
| 动画动态 | 9 | 27,660 | 每次静态烘焙均隐藏，保留动态光影路径 |
| 特殊实时 | 2 | 18,294 | 每次静态烘焙均隐藏，不烘透射构件/窗外背景 |

动态集合包括：

- `Table1_Desktop_Lift`
- `Door_Leaf` 及门上 5 个衣物后代 mesh
- `Casement_Left`、`Casement_Right`

特殊集合为 `Window_Frame_Fixed_Lights_Sill_Blind` 和 `Photographed exterior daylight`。窗固定框与透射玻璃共用 mesh，因此整个固定框 mesh 保守地留在特殊实时集合，没有拆开冒充静态。

烘焙只在临时合并的静态代理上执行，以避免 1,202 次逐对象整图 bake。代理不包含动态/特殊对象；三通道完成后删除代理并恢复原对象，最终 GLB 保留原节点、父链和动画。

## UV2 与通道映射

UV2 在临时合并网格上统一展开、打包，再按源对象/源 loop 属性传回。准备和导出分别做了面积检查，最终结果为：

- 光照 UV 名称：`UV2_Lightmap`
- 坐标均在 0–1 内且有限
- 342,185 个静态三角形 UV 面积总和：`0.5306387331`，小于单图集 1.0
- 每个源 loop 均完成映射
- 26 个零面积 UV 三角形已记录，未通过修改原几何掩盖
- 1,181 个原只有一套 UV 的 mesh：光照坐标在 `TEXCOORD_1`
- 21 个原已有两套 UV 的 mesh：保留原两套 UV，光照坐标在 `TEXCOORD_2`
- 每个静态节点的 `extras.lightmapUvIndex` 与真实通道一致；动态/特殊节点没有 lightmap 绑定

UV 面积是必要条件，不冒充 exhaustive 像素级重叠证明。布局图为 `output/example_room_2/previews/uv2-layout.png`。

## 实际输出

| 主资产 | 内容 | 烘焙耗时 | 非零像素比例 | 大小 |
|---|---|---:|---:|---:|
| `lightmaps/direct-diffuse.exr` | DIFFUSE / DIRECT，排除 COLOR | 47.97 s | 29.56% | 268,501,346 B |
| `lightmaps/indirect.exr` | DIFFUSE / INDIRECT，排除 COLOR | 88.44 s | 21.58% | 268,501,346 B |
| `lightmaps/ao.png` | AO，Non-Color | 33.36 s | 44.44% | 11,802,391 B |

三张主图均为 4096×4096，所有像素有限且非空，合计约 523.38 MiB。direct/indirect 为线性 EXR；AO PNG 不经过 ACES/FXAA。`previews/lightmaps/*-display.png` 只是显示副本，不是运行时主资产。

- direct 非零像素最大 RGB：约 `(23.78, 18.73, 12.71)`
- indirect 非零像素最大 RGB：约 `(409.59, 330.80, 189.06)`；未偷偷 clamp，局部 HDR 高值仍需后续诊断
- AO 最大值 1.0，非零均值约 0.6028

这些体积是离线原型成本，不是手机内存收益。没有复制到 Android assets，也没有据此宣称下载、解码、显存或帧率改善。

## 结构校验

`output/example_room_2/validation-report.json` 的全部检查通过：

- 原始输入哈希未变
- 全部 1,213 个源 mesh 节点存在，静态/动态/特殊角色一致
- 所有静态 primitive 具有其声明的光照 UV 通道，坐标有限且在图集内
- 光照 UV 面积总和符合单图集约束
- 4 条动画及目标保留：升降桌面、门、左窗、右窗
- 无 `KHR_materials_unlit`
- 无 `KHR_lights_punctual` 导出，不会误触发现有 glTF 灯光路径
- 三张 lightmap 主文件存在且非空

最终 GLB 为 49,279,372 B，含 1,350 节点、1,213 mesh、84 材质。临时诊断 unlit 材质没有进入最终 GLB。

## 视觉对照与未通过原因

已人工打开三张主贴图、四个静态诊断视角、四个完整 PBR 视角及两张 A0 接触表：

- `previews/contact-a0-vs-offline-full-pbr.jpg`
- `previews/contact-a0-vs-baked-static-diagnostic.jpg`

结论：

1. **完整 PBR 与 A0 不等价。** 四个机位和构图基本对齐，但离线画面整体更亮，墙面/家具明暗关系不同；曝光、ACES 与 Blender AgX、光照单位及 IBL 预滤波尚未完成同条件标定。
2. **窗外与透射表现不同。** 手机入口图窗面主要为黑色和局部高光，Blender 显示明亮室外照片。特殊集合没有烘入静态贴图，但离线完整参考也不能据此宣称材质等价。
3. **静态诊断仍有明显异常。** 256 采样降低了早期颗粒噪声，但墙面横向黑带、深色区域和部分材质表现仍不可接受。具体原因尚未完全定位，不能简单归咎于动态对象，也不能判为画质达到 A0。
4. **诊断图不是最终混合材质。** 它只显示静态“原底色 × (direct + indirect) × AO”，动态/特殊对象故意隐藏；AO 与间接光的组合、双面和材质响应需在后续材质阶段验证，本轮没有用手机实时灯光叠加来掩盖问题。
5. **动态验收未完成。** 完整 PBR 中恢复了门、窗扇和衣物；4 条动画在 GLB 中保留，但没有执行门窗连续开合、旧阴影残留、快速转身或热稳定测试，这些属于 B4，不能提前标通过。

## 失败迭代与保留证据

- 首次逐对象共享图集烘焙按实测速度需数小时，已中止；日志为 `bake-multi-object-aborted.log`，无有效贴图计入结果。
- 多对象分别打包产生面积 2.368 的重叠 UV，32 采样版本保留在 `iterations/32-sample-invalid-uv`，明确为无效反例。
- 后续发现 21 个对象原已有两套 UV；最终通过逐对象 `lightmapUvIndex` 和 `TEXCOORD_2` 校验解决，未删除原 UV 或重烘无关资产。

## 停止点与待验收问题

本轮停在 B1。后续只有在用户验收并另行授权后，才应处理：

- 黑色带状区域的具体材质/法线/诊断合成原因
- Filament 与 Blender 的曝光、色调映射、光照单位、IBL 和透射材质同条件标定
- indirect 局部 HDR 高值和 26 个零面积 UV 三角形
- 图集利用率、EXR 压缩/格式与移动端显存预算
- 当前 `Example_Room_2` 的可重复 B0 性能、PSS 与热基线
- B2/B3/B4 的全部手机接入与动态验证

完整 A0 和现有实时光影配方继续作为默认回退，不用本原型替换。

---

# 2026-11-02 B1 视觉问题整改与复核

## 本轮结论

**视觉仍未通过，保持待验收，不进入 B2。结构校验已通过，黑色带状异常已定位并在同一组射线样本和四个固定视角中整改有效，但完整画面仍未证明达到 A0。**

本轮最终 `example_room_2.baked.glb`：49,279,372 B，SHA-256 `36acf40703c5f2cde3e87ddb34d206f252c0e3b4d6229d869188fe7e2954246b`。原 GLB 的 SHA-256 仍为 `812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`。完整实时 A0、Android 源码和 assets 均未修改。

## 黑带的实际原因与隔离证据

初次隔离结果保存在 `diagnostics/initial-isolation/`。逐项检查材质 ID、对象、UV checker、direct、indirect、AO、原底色和诊断合成后确认：

- 横向黑带主要对应 `Ivory PVC trunking` 线槽，不是墙漆自身的黑色材质，也不是增加采样就能消除的噪声。
- 同一组入口/反向 112 个射线样本中，线槽 20 个命中面全部背向相机；direct/indirect 为 20/20 零，AO 为 19/20 零。`White painted metal` 的 9 个命中面也有同类问题。
- `Cool off white lower wall paint.003` 的 10 个墙漆样本三通道均非零。原底色、UV checker 和完整 PBR 可显示这些构件，因此不能用整体曝光或诊断乘法解释根因。
- 按 1 微米位置容差合并顶点进行拓扑复核后，1,084 个静态对象是封闭但法线整体内向的网格。原模型大量使用双面材质，手机实时路径仍可显示，而当前 Cycles 烘焙在这些面上写入了零光照明。

最小修正是只在临时烘焙代理中翻转这些封闭内向网格；不修改原对象、原法线或原 GLB，不凭体积符号翻转开放薄片。每个副本按多边形＋顶点核对 UV2，loop 顺序的合法反转不算 UV 改变。最终清单在 `bake-report.json` 的 `normalCorrections`。

同一组抽样复核位于 `diagnostics/remediation-isolation/`：线槽 direct/indirect/AO 零异常分别从 20/20、20/20、19/20 降为 0/20；顶灯金属件分别从 9/20、9/20、8/20 降为 0/20。静态样本中未再出现同类三通道零值，但这不是对所有可见表面的穷尽证明。升降桌面等动态对象仍不绑定静态 lightmap。

## 灯光、曝光和显示条件

- 手机实际相机参数是 `f/0.7、1/125 s、ISO 100`，并非旧离线预览的 exposure 0。按 Filament `Exposure.cpp`，EV100 为 `5.936637939`，线性曝光因子为 `0.01360544218`，等效 Blender 曝光 `-6.199672345` 档。
- Filament 1.68.2 的 LED 效率为 `0.1171`；每盏顶灯 `60 × 0.1171 × 683 = 4798.758 lm`。LightManager 的 SUN 保留 lux，POINT 再从流明换算 candela，没有额外 `1/683` 除法。本轮使用日光 `2500`、每盏顶灯 `4798.758` 的等效光度值；灯型、位置、方向、色温、falloff、半径和角半径均通过不变量检查。
- `7.026 / 3.660322` 的额外归一化试验在手机曝光下近黑，已停止并归档，未计为有效修正版。
- 四视角仍使用原坐标、实测朝向和显式指定的 80° 竖直 FOV；没有根据构图差异随意改变相机。
- 预览从场景线性 EXR 经上述曝光和 Filament ACES 算子生成，ACES/FXAA 未烘入 lightmap。IBL 强度仍为 0.25、输入 HDR 未替换，但其方向、预滤波和手机响应没有因此证明完全等价。
- gamut mapping 试验出现不可接受的纯红高光斑块，已拒绝并移出最终显示路径。`diagnostics/pre-gamut-previews/` 和 `diagnostics/rejected-gamut-matrix/` 保留该失败证据，不能用未完成的显示实现宣称手机等价。

源码依据：[LightManager](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/components/LightManager.cpp)、[Exposure](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/Exposure.cpp)、[ToneMapper](https://raw.githubusercontent.com/google/filament/v1.68.2/filament/src/ToneMapper.cpp)。

## 本轮实际输出

三通道均为 4096×4096、256 samples、OPTIX，未提高采样来掩盖法线问题；动态与特殊集合仍在每次静态烘焙中隐藏。

| 主文件 | 烘焙耗时 | 非零像素比例 | 大小 | SHA-256 |
|---|---:|---:|---:|---|
| `direct-diffuse.exr` | 67.27 s | 46.6256% | 268,501,346 B | `6904278cf8297efc2374257126cc7954e423262907187584567cb0641901514b` |
| `indirect.exr` | 103.70 s | 39.7622% | 268,501,346 B | `a630b2a04d945a84b702844d2d1250254aeda2fd7858f5368faa33014865c246` |
| `ao.png` | 42.94 s | 56.5100% | 15,179,911 B | `19a47bcfa1a61ddb0f0e966828abea9931af89d11646d4d56113666e9528d7d6` |

三张主图合计约 526.60 MiB；direct/indirect 仍为线性 EXR，AO 为 Non-Color PNG，HDR 高值未截断。显示副本的过曝不作为线性值验收依据。

已生成四个静态诊断和四个完整 PBR PNG、对应场景线性 EXR、baked blend 和上述 GLB。三列对照为手机 A0／上一轮失败图／本轮结果：

- `previews/contact-b1-remediation-baked-static-diagnostic.jpg`
- `previews/contact-b1-remediation-offline-full-pbr.jpg`
- `previews/visual-review.json`

## 结构复核

`validation-report.json` 的全部检查通过：1,350 节点、1,213 mesh、84 材质和 4 条动画保留，动态/特殊集合无 lightmap 绑定，无 `KHR_materials_unlit`、无导出 punctual lights，八张 PNG 均为本轮正确尺寸。

- UV 面积仍为 `0.5306387330855316`；1,181 个对象用 `TEXCOORD_1`，21 个用 `TEXCOORD_2`。
- 本轮与上一轮 baked GLB 的 NORMAL 和 UV2 数组逐值一致；UV2 面积、通道分配和数组均未被代理修正改变。
- 源 GLB 到导出存在 UV seam 顶点拆分和 primitive 合并，不能按数组下标直接比较。按相同位置的最近法线比较 373,207 个源角点，最大方向差 `0.0006744503`，显式容差 `0.001`；该量化差异已记录，不冒充逐位相同。
- 仍有 26 个零面积 UV 三角形；UV 面积仍不是 exhaustive 像素级重叠证明。

## 四视角视觉结论与未解决问题

1. **异常黑带整改有效。** 四个静态视角中的线槽、插座、顶板及小构件恢复可读光照；不是通过整体提亮掩盖，通道零值也有对应改善。
2. **整体视觉仍未通过。** 入口及左侧有偏粉高光，反向和右侧视角明显偏暗、偏绿，和 A0 的明暗/色调关系不同。完整 PBR 与静态诊断不能视为已达到当前实时视觉基准。
3. **窗外与透射仍不等价。** 透射窗构件和窗外照片继续只在完整实时参考路径中，未纳入静态烘焙；当前暗部窗面、局部高光与手机仍不同，没有为了对比把它们烘入静态集合。
4. **不能只看平均指标。** 入口/左侧完整 PBR 的辅助 MAE 有所下降，但反向/右侧上升，不能据此宣称整体改善或通过。相机配置相同也不等于手机截图像素级构图一致，MAE 只用于辅助。
5. **仍需后续同条件标定。** IBL 方向/预滤波、完整显示变换、材质高光/反射、色调与透射响应仍未解决。高光、反射、ACES、FXAA 没有烘进贴图，全屋没有改成 unlit。
6. **验收边界不变。** 当前模型的可重复性能/PSS/热基线未补采，未重跑 A0–A7，A8、真实漫游录像和 B4 动态验证均未标完成；没有性能收益结论，也没有进入 B2/B3/B4。

完整 A0 和现有实时光影配方继续作为默认回退。本轮停在 B1，等待用户验收。

---

# 2026-11-07 B1 同条件标定与复核

**结论：视觉仍未通过，保持待验收，不进入 B2。没有第三轮烘焙，没有新 lightmap 或 baked GLB。**

本轮先完成同条件标定门，没有盲目重做 10.5 的资产：

- 原生 JDWP 只读证据确认当前同模型 A0 的竖直 FOV 为 `80.000000°`、水平 FOV 为 `120.179533°`，viewport 为 `2486×1200`，near/far 为 `0.05/100 m`，曝光为 `f/0.7、1/125 s、ISO 100`。没有改成默认 28 mm。
- 旧 B0 四图没有原生矩阵且构图更窄，不再用于逐像素光照归因；新采集的四张同模型标定图单独保存，旧图未覆盖。
- `PhysicalRoomLighting` 的 `toneMapping=ACES` 在 Filament 1.68.2 中是空实现，实际为 SceneView 创建的 `FilmicToneMapper` color grading。已从既有线性 EXR 重输出 Filmic 预览，未重烘，也未使用被拒绝的 gamut 试验。
- 日光、顶灯和 IBL 小样证明当前 Cycles 画面以顶灯贡献为主，不能通过旋转 HDR 或调 IBL 强度掩盖。色温归一化小样只整体变暗，未解决偏粉/偏绿，未采纳。
- `Glazing` 的 transmission/IOR/alpha/双面及窗外自发光照片已核实；Filament 屏幕空间折射与 Cycles 路径追踪机制不同。透射与窗外继续实时路径，没有隐藏窗户或烘入静态集合。
- 四视角人工对照仍见偏粉高光、局部偏绿、材质/反射和窗外差异。反向/右侧 MAE 改善不等于整体通过。

完整标定记录：[B1-same-condition-calibration.md](B1-same-condition-calibration.md)。证据集中在 `output/example_room_2/diagnostics/same-condition-calibration/`，复现命令见 [reproduction.md](reproduction.md)。完整实时 A0 保持默认回退；未进入 B2/B3/B4，未虚标性能收益。

---

# 2026-11-07 B1 剩余视觉复核

**结论：视觉仍未通过，保持待验收，不进入 B2；没有采纳新修正，没有第三轮烘焙或新 GLB。**

- 从同一批线性 EXR 实际生成 R11F_G11F_B10F、32³ LogC LUT、RGB10_A2 和默认抖动的分项预览。各显示步骤只造成约 0.15–0.33 个 8 位码值的平均变化，四视角没有一致改善，不能解释粉高光、局部灰绿和窗外差异。
- 入口/右侧 Cycles 通道小样按 `(DiffDir + DiffInd) × DiffCol + (GlossDir + GlossInd) × GlossCol` 分解。入口顶板和墙面的粉色高亮包含大量直接漫反射，不是单纯镜面高光；右侧白板/下墙灰绿也存在于直接漫反射。未发现支持单改 roughness、Specular 或 UV 的证据。
- IBL 强度与默认旋转保持不变；采样点间接光泽很小不等于证明 IBL 方向或预滤波等价，不能据此旋转 HDR 或调强度。高反射材质与完整 IBL 等价仍未解决。
- 透射和窗外只能记录为 Filament 屏幕空间折射与 Cycles 路径追踪的机制差异，继续实时路径，不隐藏、不烘入静态集合，不勉强对齐。
- 实际复核图为 `diagnostics/remaining-visual-review/contact-display-four-views.jpg`、`contact-display-stages-entry.jpg`、`contact-display-rois.jpg` 和 `contact-lighting-passes.jpg`。原 GLB、10.5 baked GLB、lightmap、完整实时 A0 和现有配方均未覆盖。

完整证据和未解决问题见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)，复现命令见 [reproduction.md](reproduction.md)。未重跑 A0–A7，未虚标 A8、真实漫游录像、当前模型性能基线、性能收益或 B4 动态验收；本轮停止等待用户验收。

---

# 2026-11-08 B1 顶面法线/背面与阴影边界

**结论：视觉仍未通过，保持待验收，不进入 B2；没有采纳新修正，没有重烘、重导或修改 Android。**

- 只读诊断确认入口顶板 `Ceiling0` 的面法线与自定义 loop 法线均朝 `+Z`，标定相机看到背面；源材质 `doubleSided=true`、metallic 为 0，法线贴图样点接近平面，基色为深灰。法线通道是 view-facing 可视化，不能反推 authored winding。
- 同一顶板样点的 Cycles 直接漫反射为 `(41.45, 30.73, 19.88)`，直接光泽 `(9.04, 7.12, 4.83)`；仅四盏顶灯按翻转法线计算的期望为 `(136.16, 107.21, 72.76)`，未翻转时为 `(0,0,0)`。这与 Cycles 双面语义翻转背面法线一致，离线顶面亮斑不是灯光漏算。
- 阴影变体显示：关闭顶灯阴影、顶面对象投影或全部阴影只会让画面更亮，顶面光斑仍在（入口顶带均值从 `(200.56, 171.25, 165.17)` 升至 `(226.24, 202.19, 212.31)`；右侧从 `(200.18, 169.00, 158.50)` 升至 `(225.19, 202.79, 213.72)`）。没有证据支持削弱离线阴影。
- A0 顶面近黑与离线光斑仍不同；但本轮不能证明 Filament 1.68.2／gltfio 运行时是否翻转 `doubleSided` 背面法线，也未排除 512 阴影贴图、PCSS 近灯自阴影等运行时因素（该“未证明”项已由 2026-11-08 续测关闭，见下）。**不修改法线、UV、粗糙度、Specular、灯光或阴影，也不把 A0 顶面黑作为烘焙目标。**
- 证据：`output/example_room_2/diagnostics/ceiling-boundary/contact-ceiling-boundary.jpg`、`scene-report.json`、`normal/`、`shadow-tests/`。复现命令见 [reproduction.md](reproduction.md)。原 GLB、10.5 baked GLB、lightmap、完整实时 A0 和现有配方均未覆盖，未创建提交，本轮停止等待用户验收。

---

# 2026-11-08 续 B1 手机侧只读探针

**结论：视觉仍未通过，保持待验收，不进入 B2；没有采纳修正，没有重烘、重导或修改 Android。**

- JDWP 只读探针仅调用 getter。A0 原始模型运行中读回 `Ceiling0` 的 `ceiling_tile` 实例 `isDoubleSided=true`，父材质 `base_lit_opaque` 为 `false`；Filament 1.68.2 的 `setDoubleSided` 在父材质无 capability 时提前返回而不写 `mIsDoubleSided`，因此实例为 true 证明 double-sided capability、`_doubleSided=1`、culling NONE，`surface_shading_parameters.fs` 在背面翻转 `n/t/b`。**运行时背面法线翻转已证明。**
- 同场景 5 盏灯（1 SUN + 4 POINT）全部加载；四盏 POINT 灯 y=`1.0194`、intensity=`381.873`、falloff=`10.786616`、`shadowCaster=true`，顶板 `isShadowReceiver=true` 且 light channel 0 开启，排除灯光/接收/通道配置缺失。
- 受控截图：A6（`shadowingEnabled=false`）入口顶面 ROI 均值 `(183.19, 170.04, 149.87)`；A1_DPCF（`currentExperiment=A1_DPCF`，DPCF，阴影开启）`(168.99, 156.25, 136.88)`；A0 标定图为 `(7.90, 6.21, 4.17)`。A1_DPCF 与 A0 的 512 局部阴影贴图相同，故 **512 贴图分辨率单独不足以解释顶面近黑**。一盏 POINT 灯位在运行间不同（A0/A6 `(-1.4995,1.0194,0.1288)`、A1_DPCF `(-0.73,0.9854,0.14)`、A0 复现 `(-1.5391,1.0254,-0.2778)`），是未受控变量。
- A0 复现截得明亮顶面（均值 `(162.13, 149.36, 129.99)`），但探针只读到默认 `currentExperiment=A0`，无法证明 `applyQuality(A0)` 执行；AO 读回探针加入后设备断连，未取得结果。**因此 PCSS 近灯自阴影与遮挡体无法唯一归因**，未修改任何参数。
- 既有 `review.json` 的顶带均值包含墙面/窗户，不能用于顶面结论；新增 `phone-probe/ceiling-roi.json` 以纯顶面 ROI 记录修正后的量化值，并修正了复核脚本对手机截图再次归一化导致 ROI 左移的缺陷。
- 证据：`output/example_room_2/diagnostics/ceiling-boundary/phone-probe/contact-phone-probe.jpg`、`ceiling-roi.json`、`runtime-material-probe-*.json`、`01-entry-android-*.png`。记录见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)，复现命令见 [reproduction.md](reproduction.md)。原 GLB、10.5 baked GLB、lightmap、完整实时 A0 和现有配方均未覆盖，未创建提交，本轮停止等待用户验收。
