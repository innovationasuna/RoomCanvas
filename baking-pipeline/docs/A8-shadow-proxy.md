# A8 · 低模阴影代理（2026-11-16）

> 目标：主相机继续渲染原高模，阴影 pass 只吃低模代理；用于阶段 0 的 A8 单变量诊断，不进入默认画质。

## 1. 运行时机制

Filament 1.68.2 没有“同一 renderable 主 pass 高模、阴影 pass 低模”的分层开关；`View.setVisibleLayers` / `RenderableManager.setLayerMask` 只做整个 View 的可见性，不能按 pass 拆分。可用机制是 `MaterialInstance.setCullingMode(colorPass, shadowPass)`：

- 颜色 pass：`FRONT_AND_BACK`（代理完全不可见）。
- 阴影 pass：`BACK`（代理正常写入阴影图）。

`ShadowProxyController` 加载代理 GLB，挂到主模型节点下，按**世界包围盒**匹配主模型 renderable（名称在 glTF 节点/网格之间不稳定，不能依赖）。匹配成功后：

1. 代理 renderable：`castShadows=true`、`receiveShadows=false`、按上述 culling 配置。
2. 主模型对应 renderable：`castShadows=false`（保留可见与接收阴影）。
3. 关闭 A8 时恢复原投影标志并销毁代理模型。

该实现只在实验切换时增删一次实体，不逐帧增删。

A8 是**非交互诊断模式**：代理根节点设置 `isHittable=false` / `isTouchable=false`，且 Activity 在 A8 激活时跳过门窗 `View.pick`。原因是 `View.pick` 不读取颜色 pass 的 culling 状态，仍可能命中代理几何；若代理未匹配当前模型，实验会自动恢复 A0，不会把 A0 数据记成 A8。

## 2. 资产

| 房间 | 源模型 | 代理对象 | 源三角形 | 代理三角形 | 降幅 | 最大包围盒偏差 |
|---|---|---:|---:|---:|---:|---:|
| Hausen_Room_3 | `.tmp_room_model.glb`（`486a1f…`） | 30 | 818,167 | 43,679 | 94.66% | 11.6 mm |
| Example_Room_2 | `测试模型/Example_Room_2.glb`（`812c8e…`） | 9 | 261,743 | 14,045 | 94.63% | 6.2 mm |

- 仅取静态、不透明、≥2,000 三角形的网格；动态门窗子树和透射/背景材质保持原实时几何。
- 每个对象按 5% 目标减面（最少 500 三角形）；`Loose_score_pages*` 因薄片减面后包围盒收缩 5–7 cm，已排除，保留原几何。
- 代理 GLB 使用单一不透明材质，无贴图、无动画、无相机/灯光。

产物：

- `BakingPipeline/output/hausen_room_3/shadow-proxy/hausen_room_3.shadowproxy.glb`
- `BakingPipeline/output/example_room_2/shadow-proxy/example_room_2.shadowproxy.glb`
- 各自目录下 `shadow-proxy-report.json`、`validation-report.json`
- Android asset：`AndroidApp/app/src/main/assets/shadow_proxies/`

## 3. 复现命令

```bash
# 1) 生成 Hausen 的源分类（已有输出时可跳过）
python BakingPipeline/scripts/inspect_source.py \
  --config BakingPipeline/configs/hausen_room_3.inspect.json

# 2) 生成代理 GLB
BakingPipeline/.tools/blender-4.5.3-windows-x64/blender.exe \
  -b --factory-startup \
  --python BakingPipeline/scripts/build_shadow_proxy.py \
  -- --config BakingPipeline/configs/hausen_room_3.shadow-proxy.json

# 3) 结构校验
python BakingPipeline/scripts/validate_shadow_proxy.py \
  --config BakingPipeline/configs/hausen_room_3.shadow-proxy.json

# Example_Room_2 同理，把配置换成 example_room_2.shadow-proxy.json
```

校验覆盖：源哈希、节点覆盖（含祖先网格）、三角形预算、世界包围盒偏差、单不透明材质、无贴图/动画/相机/灯光。两份配置当前均 `passed=true`。

## 4. 真机结果（P40 Pro，Hausen_Room_3）

### 4.1 启用证据

```
11-16 15:24:08.382 I/ShadowProxy(31226): A8 shadow proxy ON asset=shadow_proxies/hausen_room_3.shadowproxy.glb renderables=30 disabledCasters=30
11-16 15:24:13.513 I/ShadowProxy(31226): A8 shadow proxy OFF
```

完整日志：`项目文档/手机端软件开发/光影渲染性能基线/阶段0/A8-shadowproxy-20261116/enable-disable.log`。

### 4.2 固定视角视觉

A0/A8 各拍 entry / piano 两个固定机位：

| 视角 | MAE（/255） | 差异 >20 的像素 | 结论 |
|---|---:|---:|---|
| entry | 2.01 | 2.80% | 主画面一致，差异集中在阴影边缘/噪声 |
| piano | 1.05 | 0.64% | 同上 |

未出现代理灰色几何；说明颜色 pass 剔除生效。截图目录：`阶段0/visual/A0-Hausen-20261116/`、`阶段0/visual/A8-Hausen-20261116/`。

### 4.3 性能（单次顺序对照，20 s 预热 + 60 s 采样）

| 实验 | averageFps | p95 ms | p99 ms | >50 ms | PSS KiB | 起始温度 |
|---|---:|---:|---:|---:|---:|---:|
| A0 run6 | 56.075 | 16.559 | 83.213 | 1.783% | 917,553 | 37°C |
| A8 run2 | 56.057 | 16.555 | 83.213 | 1.784% | 873,796 | 38°C |

- p95 改善 0.004 ms（−0.02%）、averageFps −0.03%，未达方案 1 的 10%/3 ms 门槛。
- 两轮均受 60 Hz vsync 封顶，thermal=3；PSS 差值约 43 MiB，但单次 PSS/GC 波动大，不当作稳定收益。
- 与 A6（关闭全部阴影）上限约 1.5% 一致：代理不是提升帧率的主要杠杆。
- 最终 APK SHA-256：`96f568de06df16a03849d6056c0b176ac20c397957fa72a800c6d8fa4c0e0fde`。

## 5. 边界

- 代理只改变阴影几何，不改变主模型几何、材质、灯光、SSAO、PCSS/DPCF 或分辨率。
- 视觉验收仍是同机位截图；动态门窗、真实漫游录像和用户肉眼验收未包含在本轮。
- 结论只适用于 Hausen_Room_3 / Example_Room_2 的当前哈希；换模型需重新生成代理。
- A8 首次启用会按固定顺序在主线程尝试两份代理（Hausen、Example）；不匹配时会有一次加载/销毁卡顿，仅诊断入口，不作为默认交互模式。
- A8 是诊断实验，不进入视觉优先档；未改默认 `RoomRenderQuality.BASELINE`。
