# ViewForge 在 RoomCanvas 中的目录

物体照片 → BiRefNet 蒙版 → DA3 / MV-SAM3D → GLB / Gaussian → 尺寸标定与房间摆放。功能和浏览器内的手势控制方式保持不变。

```text
RoomCanvas/
├── reconstruction/        原有 LiteReality 房间重建
├── web/                   原有 Three.js 编辑器
├── samples/               原有示例房间
├── object-reconstruction/ ViewForge/MV-SAM3D 源码、配置模板、查看器和测试
│   ├── scripts/
│   ├── configs/
│   ├── viewer/
│   └── docs/
├── gesture/               摄像头、手势识别、资源、接入页及原演示
└── scripts/gesture.sh     本机手势启动入口
```

源码统一由 RoomCanvas 根目录的 Git 管理，各模块内没有嵌套 Git。物体重建运行数据仍由 `VIEWFORGE_ROOT` 指向外部目录；现有服务器使用 `/workspace/geyinuo/ViewForge`：

```text
$VIEWFORGE_ROOT/
├── data/inputs/           原始照片、蒙版与导入记录
├── data/layouts/          保存的布局
├── weights/              BiRefNet、SAM3D、DA3 和 DINO 权重
├── envs/                 原有独立 Python 环境
├── third_party/          固定版本的外部依赖源码
├── runs/                 历史和新重建结果
├── logs/
└── cache/
```

在 RoomCanvas 的 `object-reconstruction/` 下，按 `configs/local.env.example` 配置被 Git 忽略的 `configs/local.env`，然后显式加载：

```bash
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 172.18.0.2 --port 7862
```

`scripts/env.sh` 按自身位置选择当前模块源码，运行环境、权重和数据仍来自 `VIEWFORGE_ROOT`。房间资产通过 `VIEWFORGE_ROOMS_ROOT` 指定，现有部署继续使用 `RoomCanvas-Reconstruction/runs` 的 `empty_room.glb` 与 `room_structure.json`；本次没有增加读取另一种房间格式的逻辑。

在本机 RoomCanvas 根目录运行 `sh scripts/gesture.sh install`、`sh scripts/gesture.sh dev`。物体模块内的同名脚本保留为兼容入口，两者都按相对位置找到同一个 `gesture/`。

原独立 ViewForge 仓库和既有服务保留，不因本次源码整合自动切换。当前状态与完整历史说明见 [整合说明](../../docs/VIEWFORGE_INTEGRATION.md)。
