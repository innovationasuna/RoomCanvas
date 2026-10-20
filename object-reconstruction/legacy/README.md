# 已弃用的 ViewForge 独立界面

归档日期：2026-10-20。这里保留原 Gradio 物体重建页面、Babylon 单物体查看器与房间布局页、离线构建资源和旧界面测试，供追溯实现与参考；当前系统不加载或启动它们。

**唯一受支持的使用入口是 RoomCanvas 网站 `web/`。** 物体服务入口是 `object-reconstruction/scripts/web.py`，现在只提供 API，不依赖 Gradio 或本目录。请按 [当前物体服务说明](../../docs/OBJECT_RECONSTRUCTION.md) 启动。

| 归档内容 | 说明 |
| --- | --- |
| `scripts/web.py`、`scripts/mask_state.py` | 原 Gradio 页面及会话状态，保留迁移前实现 |
| `scripts/assets/` | 原页面脚本、Babylon / model-viewer 构建产物及许可证 |
| `viewer/` | 原单物体与房间查看器源码、构建工具和依赖锁文件 |
| `gesture/`、`docs/` | 原 ViewForge 手势接入页及场景操作说明，仅作历史记录 |
| `scripts/layout*.py`、`configs/layout-requirements.txt` | 原房间校验及依赖，不再由正式服务加载 |
| `tests/` | 只适用于原 Gradio 页面与会话的历史测试，不属于当前 API 回归 |
| `requirements.txt` | 原界面依赖记录；不是当前服务安装文件 |

代码按归档前的目录关系保存，旧 README、链接、UI 文案和启动约定属于历史，不是现行操作指南。这里不承诺与后续 API 改动兼容，不在 CI 中构建旧 UI，也不挂载旧页面或任意文件下载路由。

当前保留的能力由正式模块提供：照片上传与抠图、DA3 / MV-SAM3D 重建、任务进度、模型读取和实测尺寸标定；COVER、补拍运行和原始 Gaussian 结果仍由后端算法及命令行保留。RoomCanvas 已接入的功能不依赖归档代码。

许可证、依赖版本和构建产物随原代码保留。此目录只保存源码与原有构建文件，不包含用户照片、模型权重、环境或重建结果。
