# ViewForge

现有照片 → BiRefNet 补齐 mask → 预览确认 → DA3 / MV-SAM3D 重建 → GLB / Gaussian 查看。

运行目录：`/workspace/geyinuo/ViewForge`。网页：[ViewForge](http://127.0.0.1:7865/)。

```text
ViewForge/
├── README.md          项目入口
├── code/              Git 仓库：源码、scripts、configs、tests、docs
│   └── gesture-furniture-demo/  随仓库提供的本机手势入口、识别资源和测试
├── data/inputs/        按物体保存 images/ 与 masks/
├── weights/           BiRefNet、SAM3D、DA3、DINO 权重
├── envs/              birefnet 与 mvsam3d 独立环境
├── third_party/       DA3 等外部依赖源码
├── runs/              每次重建的配置、产物与运行日志
├── logs/              mask 准备记录、部署记录、网页日志和旧代码归档
└── cache/             模型缓存、缩略预览与共用 GPU 锁
```

代码与配置由 `code/.git` 管理，数据、权重、环境、缓存和结果留在 Git 仓库之外。上游 MV-SAM3D 的源码、历史和署名保留；项目展示名称统一为 ViewForge。

添加物体时使用 `data/inputs/<物体名>/images/`，照片为小写 `.jpg` 或 `.png`，文件名主干唯一。无需自行建立 masks 目录。当前新增物体后需重启网页服务以更新下拉列表。

```bash
cd /workspace/geyinuo/ViewForge/code
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 172.18.0.2 --port 7862
```

本机仍通过已有 SSH 隧道访问 `http://127.0.0.1:7865/`。CLI、mask 契约和部署验收见 `code/docs/VIEWFORGE_RUNTIME.md`（在代码仓库内为 `docs/VIEWFORGE_RUNTIME.md`）。

旧名称 `viewforge-mvsam3d` 只保留为指向 `ViewForge` 的兼容软链接，用于既有环境脚本和历史绝对路径。今后使用新路径；保留旧链接即可继续访问历史结果，无需移动或重新下载权重、重装环境。测试物体、原物体和既有结果均保留。
