# B0 基准核对：Example_Room_2

日期：2026-11-01  
设备：HUAWEI P40 Pro（ELS-AN00，ADB `MDX0220B11015404`）  
手机主线：提交 `98cd2cd`（10.3）；本轮未修改 Android 源码、灯光、AR、位姿或门窗交互。

## 状态

**输入来源、哈希、当前 A0 光影配方和四个实时视角已核对并留档；当前模型的同条件性能基准未完成，B0 不判定全量通过。**

遵照本轮约束，没有重跑 A0–A7，也没有执行 A8、真实漫游录像或 10 分钟热稳定测试。旧诊断数据继续作为背景证据，不冒充当前 GLB 的同条件结果。

## 模型来源与原始文件

工作区输入：`测试模型/Example_Room_2.glb`

- 手机原始文件：`/sdcard/Download/Example_Room_2.glb`
- 应用私有副本：`files/models/current/Example_Room_2-1793532446298.glb`
- 三处 SHA-256 均为 `812c8efe501630f3e2a0e5e72560178099f2c88658e38b83843e80ea778ced9a`
- 文件大小：35,974,968 B
- 原始 Download 文件保留；工作区归档文件用于离线输入，没有覆盖 `Room-nonagent.glb`、旧 `.tmp_room_model.glb` 或 Android assets。
- 旧 A0 样本 `.tmp_room_model.glb` 的 SHA-256 是 `486a1f024b2366c0ca83103f0a2bd26bc661e075d0bc2edfb01c4fcc128779d7`。它与本轮当前手机模型不同，不能混作同模型视觉或性能对照。

结构检查位于 `output/example_room_2/b0/source-inspection.json`：

| 项目 | 当前 GLB |
|---|---:|
| 节点 / mesh / primitive | 1,350 / 1,213 / 1,239 |
| 三角形 / primitive 顶点 | 388,139 / 373,207 |
| 材质 / 图片 | 84 / 145 |
| 动画 / skin / glTF 灯 | 4 / 0 / 0 |

## 当前 A0 配方

真机 `PhysicalRoomLighting` 日志确认：

```text
日光 2500 lux，局部灯 4 盏，lights=5 shadowRequests=5
ceiling=4 window=0 gltfLights=false，ACES + PCSS + SSAO=true
```

这与旧房间的一条“1 顶灯＋1 窗灯”记录不同。离线布局按当前源码和当前 GLB 重新计算，不能照搬旧灯数。

继续保留的手机基准包括：PCSS、4 级 1024 日光 cascade、当前局部灯和 512 局部阴影请求、半分辨率 MEDIUM SSAO、原生 3D 比例、HDR IBL、SceneView Filmic color grading、FXAA 和现有材质。本轮没有替换其中任何一项。上方日志中的“ACES”仅是旧 API 请求；2026-11-07 原生标定确认其 setter 为空实现，实际为 SceneView 创建的 Filmic。

HDR 输入仍为 `AndroidApp/app/src/main/assets/environments/studio_small_09_2k.hdr`，SHA-256 `ad995fe96d922bd20ad25f98c862006325e095431176646500d717ada1ed3f61`，强度 0.25。

## 四个实时视角

截图与逐视角日志在 `output/example_room_2/b0/`，元数据为 `capture-metadata.json`。相机位置来自同一份模型包围盒，离线准备报告中的 glTF 坐标为 `(-1.565518, 0.005300, -0.277850)`，与手机日志 `(-1.566, 0.005, -0.278)` 一致。

| 视角 | 手机最终朝向 | 采集方式 | 文件 |
|---|---:|---|---|
| 入口 | 90.0° | 现有 debug 精确入口 | `01-entry-android-a0.png` |
| 反向 | 270.0° | 现有 debug 精确反向 | `02-reverse-android-a0.png` |
| 左侧 | 182.3° | 正常漫游起点＋600 px 滑动 | `03-left-android-a0.png` |
| 右侧 | -4.1° | 正常漫游起点＋600 px 滑动 | `04-right-android-a0.png` |

前两个入口由现有诊断 Intent 固定；诊断入口禁用触摸，因此左右视角改用正常漫游“回开始页→重新开始→滑动”的路径。最终朝向从日志读取，不把名义 90° 滑动虚报为完全精确。离线相机按实测朝向对齐。

截图为 2640×1200，左侧 154 px 是刘海黑边；3D 内容区为 2486×1200。离线预览使用相同内容区尺寸和 80° 竖直 FOV。Android 截图保留 UI，不用裁剪图冒充整屏一致。

## 性能、内存与热状态边界

- 本轮截图期间只记录了一次 `dumpsys meminfo`：TOTAL PSS 1,873,812 KiB。这是当前模型加载后的单点观测，不是稳定性能基线，也不能与旧模型的 PSS 直接判定收益。
- 截图前后电池温度均为 44°C，不作为冷机性能条件。
- 本轮没有执行固定轨迹性能采样；`performanceRunExecuted=false`。
- 旧严格 A0（56.330 average FPS、p95 16.561 ms、PSS 919,721 KiB、起始 35°C）来自另一份 GLB，只保留为旧诊断参考，不能回答当前模型的烘焙收益。
- A8、真实漫游录像、有效 AR TRACKING/真实走动和长期热稳定仍是旧遗留，均未在本轮标为完成。

因此，B0 已完成“当前输入与视觉基准核对”，但当前 GLB 的可重复性能/PSS/热基线仍待后续按授权补采。

## 2026-11-07 同条件标定补充

旧 B0 四图继续保留，但当时未保存原生投影矩阵，且与当前 80° 同模型标定图的构图不同，不能再与离线 80° 图做逐像素光照归因。新标定图只用于视觉对照，单独保存在 `output/example_room_2/diagnostics/same-condition-calibration/a0/`，未覆盖本目录。

JDWP 原生读数确认当前同模型 A0 为竖直 `80.000000°`、水平 `120.179533°`、viewport `2486×1200`。SceneView 2.3.4 的实际 color grading 为 `FilmicToneMapper`；旧 `toneMapping=ACES` 是空 setter，不代表实际 ACES。完整证据和边界见 [B1-same-condition-calibration.md](B1-same-condition-calibration.md)。本补充没有重跑性能实验，也没有改变 B0 性能未完成的结论。
