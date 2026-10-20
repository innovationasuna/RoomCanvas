# ViewForge 在 RoomCanvas 中的目录

RoomCanvas 照片界面 → 物体 API → BiRefNet → DA3 / MV-SAM3D → GLB / Gaussian → 实测标定 → RoomCanvas 摆放。本模块只负责物体；场景与手势归 RoomCanvas 编辑器。

```text
RoomCanvas/
├── room-reconstruction/   原有 LiteReality 房间重建
├── web/                   原有 Three.js 编辑器
├── samples/               原有示例房间
├── object-reconstruction/ ViewForge/MV-SAM3D 源码、配置模板、查看器和测试
│   ├── scripts/
│   ├── configs/
│   ├── legacy/              已弃用的原界面、查看器、场景及构建资源
│   └── docs/
├── gesture/               摄像头、手势识别、资源、接入页及原演示
└── scripts/gesture.sh     本机手势启动入口
```

源码统一由 RoomCanvas 根目录的 Git 管理，各模块内没有嵌套 Git。物体重建运行数据仍由 `VIEWFORGE_ROOT` 指向外部目录；现有服务器使用 `/workspace/geyinuo/ViewForge`：

```text
$VIEWFORGE_ROOT/
├── data/inputs/           原始照片、蒙版与导入记录
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
python -m pip install -r configs/api-requirements.txt
python scripts/web.py --host 127.0.0.1 --port 7862
```

监听地址和端口按实际部署设置；容器部署时应确认 SSH 服务器侧能访问该地址。

`scripts/env.sh` 按自身位置选择当前模块源码，运行环境、权重和数据仍来自 `VIEWFORGE_ROOT`。不再读取旧房间资产或 `VIEWFORGE_ROOMS_ROOT`，也不再写入布局快照。现有外部运行数据不删除。

房间和手势统一在 RoomCanvas 编辑器使用，详见 [物体重建说明](../../docs/OBJECT_RECONSTRUCTION.md)。

2026-10-18 已将正式后端切换到 RoomCanvas 的本模块；原 ViewForge 目录继续提供外部运行环境、权重与数据，不再作为服务源码入口。后端按上面的命令启动，本机使用自己的 SSH 端口转发配置访问服务。当前操作与历史说明见 [物体重建说明](../../docs/OBJECT_RECONSTRUCTION.md)。

当前 `scripts/web.py` 是无界面的 API 服务，不加载 Gradio 或 `legacy/`。旧界面代码保留供参考，详见 [弃用说明](../legacy/README.md)。旧外部数据与环境不随代码归档移动。
