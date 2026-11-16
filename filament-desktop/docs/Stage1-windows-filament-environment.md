# 阶段 1 · Windows Filament 开发环境

> 依据《光影渲染性能优化方案2（当前新方案）》第 4 章执行。
> 目标：在 Windows 11 + RTX 4050 上构建与 Android 端同版本的 Filament，并跑通官方 `gltf_viewer`。
> 日期：2026-11-08。

---

## 0. 结论

1. Filament **v1.68.2** 已在 `D:\FilamentDesktop\filament` 浅克隆并成功编译。
2. 官方 `gltf_viewer.exe` 已生成，冒烟测试加载 `DamagedHelmet.glb` 正常出图。
3. 渲染后端确认走 **Vulkan**，物理设备为 **NVIDIA GeForce RTX 4050 Laptop GPU**（驱动 597.13，Vulkan API 1.4），未误用核显。
4. 实际工具链与方案有偏差：本机只有 **VS 2019 Community**（MSVC 14.29.30133），没有 VS 2022；CMake 使用 pip 安装的 4.4.4，Ninja 使用 VS2019 自带的 1.10.2。方案要求 VS 2022，但 VS2019 + v142 工具集足以完成第一轮实验，暂不升级，避免引入额外变量。
5. Filament 以 `USE_STATIC_CRT=ON` 构建，因此所有链接 Filament 静态库的桌面程序必须使用 `/MT` 运行库，否则会出现 CRT 冲突。

---

## 1. 实际环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11 Home China 10.0.26300 |
| GPU | NVIDIA GeForce RTX 4050 Laptop GPU（6,141 MiB），驱动 597.13 |
| 编译器 | Visual Studio 2019 Community，MSVC 14.29.30133（x64） |
| Windows SDK | 10.0.19041.0 |
| CMake | 4.4.4（`C:\Users\lenovo\AppData\Roaming\Python\Python312\Scripts\cmake.exe`） |
| Ninja | 1.10.2（VS2019 自带） |
| Git | 2.55.0.windows.3 |
| Python | 3.12.11 |
| 源码目录 | `D:\FilamentDesktop\filament` |
| 构建目录 | `D:\FilamentDesktop\filament\out\cmake-release` |

与方案要求的差异：

| 方案要求 | 实际 | 影响 |
|---|---|---|
| Visual Studio 2022 | VS 2019 Community | 无 API 差异；后续如遇 C++20 库问题再升级 |
| Windows 11 SDK | 10.0.19041 | 可用 |
| 系统 CMake / Ninja | pip CMake 4.4.4 + VS2019 Ninja | 可用 |

---

## 2. Filament 源码

```text
D:\FilamentDesktop\filament     # v1.68.2 浅克隆
commit 8167baf7e0dd7e5012e6863407cb83a88663ecce (2025-12-16)
tag    v1.68.2
```

选择 1.68.2 的原因见阶段 0 文档：SceneView 2.3.4 依赖 Filament 1.68.2，桌面端保持同版本可避免材质/着色器/API 差异。

---

## 3. 构建官方 gltf_viewer

在 VS2019 x64 开发者环境（`vcvars64.bat`）中：

```bat
cd /d D:\FilamentDesktop\filament
cmake -S . -B out\cmake-release -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build out\cmake-release --target gltf_viewer --config Release
```

构建配置中的关键项（`out/cmake-release/CMakeCache.txt`）：

| 项 | 值 |
|---|---|
| `CMAKE_BUILD_TYPE` | `Release` |
| `CMAKE_CXX_COMPILER` | `...\VS\2019\Community\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64\cl.exe` |
| `CMAKE_GENERATOR` | `Ninja` |
| `USE_STATIC_CRT` | `ON` |

产物：

```text
D:\FilamentDesktop\filament\out\cmake-release\samples\gltf_viewer.exe   (18.5 MB)
```

> `gltf_viewer.exe` 位于 `samples/`，不是 `bin/`。

---

## 4. 冒烟测试

素材：`测试模型\DamagedHelmet.glb`（复制到 `D:\FilamentDesktop\smoke\DamagedHelmet.glb`，路径保持 ASCII）。

用 `gltf_viewer` 的自动化截图模式渲染 10 帧：

```bat
cd /d D:\FilamentDesktop\smoke
..\filament\out\cmake-release\samples\gltf_viewer.exe ^
    --automation-script=smoke_spec.json DamagedHelmet.glb
```

日志（`smoke\run.log`）确认：

```text
FEngine (64 bits) created ...
Vulkan device driver: NVIDIA 597.13
Selected physical device 'NVIDIA GeForce RTX 4050 Laptop GPU' from 2 physical devices.
(vendor 0x10de, device 0x28a1, driver 0x95434000, api 1.4)
Backend feature level: 3
FEngine feature level: 3
Running test 0 ... Running test 9
```

产物：`smoke00.png` ~ `smoke09.png`（1280×720，模型、纹理、PBR、IBL 正常）。

验收检查（对应方案 §4.6）：

| 检查项 | 结果 |
|---|---|
| 程序能否正常启动 | ✅ |
| 模型能否正常显示 | ✅ |
| 纹理是否正确加载 | ✅ |
| PBR 材质是否正常 | ✅ |
| 能否旋转/缩放 | ✅（交互模式已验证） |
| 是否使用 RTX 4050 | ✅ Vulkan 日志确认 |

---

## 5. 环境注意事项

1. **静态 CRT**：Filament 默认 `USE_STATIC_CRT=ON`。自建桌面程序必须设置
   `CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"`，
   否则链接阶段会混用 `/MT` 与 `/MD`。
2. **非 ASCII 路径**：Filament `utils::Path` 在 Windows 上不做 UTF-8 → 宽字符转换，
   模型/HDR 路径必须为纯 ASCII。工作区中文目录不能直接传给 Filament。
3. **双 GPU**：本机 OpenGL 后端默认选中 Intel 核显（约 120 ms/帧），
   Vulkan 后端通过设备提示 `--gpu-hint=NVIDIA` 选中 RTX 4050。性能实验统一使用 Vulkan。
4. **Ninja 版本较旧**：1.10.2 能正常构建 Filament 1.68.2；若后续出现构建问题再加装新版。

---

## 6. 下一步

阶段 1 完成标准已满足。进入阶段 2：把 Android 房间场景迁移到桌面端，见
[Stage2-scene-migration.md](Stage2-scene-migration.md)。
