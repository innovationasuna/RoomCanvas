# 目录结构

```text
object-reconstruction/
├── scripts/            物体服务与工具
│   ├── web.py              API 服务入口
│   ├── objects.py          上传、抠图、重建任务
│   ├── assets.py           物体目录与模型读取
│   ├── dimensions.py       实测尺寸标定
│   ├── run.py、launch.sh    命令行重建
│   ├── prepare_masks.py、birefnet_worker.py   BiRefNet 抠图
│   ├── run_cover.py、cover_*.py               COVER 补拍引导
│   ├── import_photos.py    导入照片
│   ├── preview_glb.py      轻量预览模型
│   ├── env.sh              加载运行环境
│   └── vendor/cover/       COVER 评分组件
├── configs/            默认配置、BiRefNet 版本、依赖清单、local.env 模板
├── tests/              API 与工具的单元测试（CPU 即可运行）
├── docs/               本模块文档
├── legacy/             早期独立界面的归档，服务不加载
├── sam3d_objects/      ┐
├── notebook/           │
├── preprocessing/      │ 多视角重建核心（MV-SAM3D）
├── run_inference*.py   ┘
└── data/example/       示例照片
```

源码由 RoomCanvas 仓库统一管理。运行环境、权重、照片和结果不在仓库内，由 `VIEWFORGE_ROOT` 指向的外部目录提供，结构见 [物体重建](../../docs/OBJECT_RECONSTRUCTION.md#数据目录)。
