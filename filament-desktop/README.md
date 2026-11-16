# FilamentDesktop · Windows Filament 桌面渲染验证工程

> 对应方案：《光影渲染性能优化方案2（当前新方案）》。
> 目标：在 Windows 11 + RTX 4050 上用 Google Filament v1.68.2 复现 Android 端房间场景，逐步恢复灯光、阴影、后处理，并进行 PC-01 ~ PC-04 性能对比。

## 当前状态

| 阶段 | 状态 | 产物 |
|---|---|---|
| 阶段 0 · Android 源码分析与资源清单 | ✅ 已完成 | [docs/Stage0-render-inventory.md](docs/Stage0-render-inventory.md) |
| 阶段 1 · Windows Filament 环境 | ✅ 已完成 | [docs/Stage1-windows-filament-environment.md](docs/Stage1-windows-filament-environment.md) |
| 阶段 2 · 场景迁移 | ✅ 已完成 | [docs/Stage2-scene-migration.md](docs/Stage2-scene-migration.md)、`room_viewer` |
| 阶段 3 · 性能测试 | ✅ 已完成 | [docs/Stage3-performance-test.md](docs/Stage3-performance-test.md)、`benchmark/` |

## 目录

```
FilamentDesktop/
├── docs/                 # 阶段文档 + 阶段 2 对照图
├── src/                  # 桌面端 C++ 源码（main.cpp + CMakeLists.txt）
├── tools/                # build_room_viewer.bat
├── benchmark/            # 阶段 3 性能测试结果
└── README.md
```

官方 Filament 源码与模型/HDR 资源**不放入本仓库**，按方案放在：

```
D:\FilamentDesktop\filament    # v1.68.2 浅克隆
D:\FilamentDesktop\assets\     # room.glb + studio_small_09_2k.hdr（ASCII 路径）
D:\FilamentDesktop\scene\      # 实际构建目录
```

## 环境

| 项目 | 值 |
|---|---|
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU（6 GB，驱动 597.13） |
| 编译器 | Visual Studio 2019 Community，MSVC 14.29.30133 x64（方案原要求 VS2022） |
| 构建 | CMake 4.4.4（pip）+ Ninja 1.10.2（VS2019 自带） |
| 渲染后端 | Vulkan（实验统一），OpenGL 在本机会选到 Intel 核显 |
| Filament | v1.68.2（与 SceneView 2.3.4 对齐） |
| 运行库 | `/MT`（Filament 以 `USE_STATIC_CRT=ON` 构建） |

## 阶段 1 步骤（已完成）

```bat
:: VS2019 x64 开发者环境
git clone --depth 1 --branch v1.68.2 https://github.com/google/filament.git D:\FilamentDesktop\filament
cd /d D:\FilamentDesktop\filament
cmake -S . -B out\cmake-release -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build out\cmake-release --target gltf_viewer --config Release

:: 冒烟测试（ASCII 路径）
cd D:\FilamentDesktop\smoke
D:\FilamentDesktop\filament\out\cmake-release\samples\gltf_viewer.exe DamagedHelmet.glb
```

产物在 `out\cmake-release\samples\gltf_viewer.exe`（不是 `bin\`）。日志确认 Vulkan +
RTX 4050（api 1.4，驱动 597.13）。详见 [docs/Stage1-windows-filament-environment.md](docs/Stage1-windows-filament-environment.md)。

## 阶段 2：桌面场景程序（已完成）

### 构建与运行

```bat
:: 构建
D:\FilamentDesktop\tools\build_room_viewer.bat

:: 交互运行（1280×720）
D:\FilamentDesktop\scene\out\room_viewer.exe

:: 2640×1200 离屏出图（阶段 2 验收 / 阶段 3 测试）
D:\FilamentDesktop\scene\out\room_viewer.exe --headless --no-input ^
  --preset=p4 --shadow-type=dpcf --duration=3 --width=2640 --height=1200 ^
  --gpu-hint=NVIDIA --screenshot=D:/FilamentDesktop/shots/p4.png
```

主要参数：`--preset=p1|p2|p3|p4`、`--shadow-type=pcss|dpcf|pcf`、`--width/--height`、
`--duration`、`--warmup`、`--max-fps`、`--ignore-skip`、`--csv`、`--frame-csv`、
`--screenshot`、`--headless`、`--gpu-hint`。完整列表见
[docs/Stage2-scene-migration.md](docs/Stage2-scene-migration.md) §7。

### 复现配方（摘要）

- 模型：`room.glb`（原 `.tmp_room_model.glb`，954,913 三角形 / 50 材质 / 48 纹理，158 renderables）
- 相机：竖直 FOV 80°，near 0.05 / far 100，入口眼高 1.6 m，三参数曝光 f/0.7 / 1/125 / ISO100
- 日光：2500 lux / 6500 K / 1.5° 角半径 / 4 级 1024 阴影 / stable
- 顶灯：POINT 60 W / 4700 K（Filament 1.68 不支持点光实时阴影）
- 窗灯：FOCUSED_SPOT 20 W / 6500 K / 45°–85° / 512 阴影
- 阴影：PCSS 基线，`penumbraScale=1`、`penumbraRatioScale=1`
- 后处理：SSAO（0.35/0.65/0.5/MEDIUM）、Filmic、FXAA
- IBL：`studio_small_09_2k.hdr`，强度 0.25

### 结果

2640×1200 分阶段截图（模型+IBL → +灯光 → +阴影 → +完整后处理）与关键发现见
[docs/Stage2-scene-migration.md](docs/Stage2-scene-migration.md)。与手机 A0 对照，DPCF 下构图/色调一致。

**已知 PCSS 差异**：桌面 Vulkan 的 `ShadowType::PCSS` 在边界处出现亮色点状漏光，
DPCF/PCF 正常；阶段 2 视觉验收用 DPCF，阶段 3 对 PCSS/DPCF 分别计时。

## 阶段 3：性能测试（已完成）

2640×1200、60 Hz 节流、20 s 预热 + 5 s warmup + 40 s 采样，PC-01～PC-04 × 三种阴影类型：

| 用例 | 平均 FPS | GPU p50 / p95 (ms) | CPU p95 (ms) | 显存 |
|---|---|---|---|---|
| PC-01 模型+IBL | 60.01 | 6.30 / 6.32 | 0.62 | 561.7 MB |
| PC-02 +灯光 | 59.99 | 4.74 / 7.55 | 0.94 | 561.6 MB |
| PC-03 +阴影 PCSS | 60.00 | 9.57 / 9.83 | 2.54 | 584.7 MB |
| PC-03 +阴影 DPCF | 60.00 | 6.25 / 6.53 | 2.56 | 584.7 MB |
| PC-04 +后处理 PCSS | 59.99 | 10.80 / 11.88 | 1.84 | 613.2 MB |
| PC-04 +后处理 DPCF | 59.51* | 7.00 / 7.26 | 0.99 | 613.2 MB |

\* 一次孤立的 286 ms 系统停顿，其余帧 p99 = 16.78 ms。

- 全部 8 个配置达到 60 FPS；最重配置 GPU p95 = 11.88 ms，低于 16.67 ms 预算约 29%。
- PCSS 比 DPCF 多约 3.3～3.8 ms GPU 时间（约 +53%）；DPCF 与 PCF 基本持平。
- 10 分钟长稳（PC-04 PCSS）：59.98 FPS、GPU p95 14.55 ms、温度 57～58 °C、显存无增长。
- 方法、完整表格与三个测量陷阱（帧跳过积压、Windows 后台进程节流、WMI 采样干扰）见
  [docs/Stage3-performance-test.md](docs/Stage3-performance-test.md)。

## 注意

- 不要用 ACES 代替 Filmic：Android 端 `View.setToneMapping(ACES)` 在 Filament 1.68.2 中无 native 实现，实际观感来自 SceneView 的 `ColorGrading + ToneMapper.Filmic`。
- 资源路径必须为纯 ASCII：Filament `utils::Path` 在 Windows 上不转换 UTF-8。
- 纹理提供者（`StbProvider`/`Ktx2Provider`）必须在销毁 Engine **之前**释放，否则退出时崩溃（析构函数访问 JobSystem）。
- `SUMMARY` 自阶段 3 起基于 `Renderer::getFrameInfoHistory()`，同时输出帧间隔、CPU 与 GPU 帧时间的 p50/p95/p99。
- AR Engine、相机背景、Android UI 不在本工程范围内。
- 原始 Android 工程不改动；资源只读复用。
