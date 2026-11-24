# RoomCanvas 文档导航

## 我想试玩或布置房间

| 想做什么 | 从哪里开始 |
| --- | --- |
| 在电脑上打开一个示例房间 | [快速开始](../README.md#快速开始) · [示例模型获取](../web/README.md#示例房间的模型) |
| 摆放物品、比较光照、在房间里走动 | [鼠标键盘速查](../README.md#怎么用) · [网页编辑器指南](../web/README.md) |
| 用手势选取、摆放或取消 | [手势操作与摄像头设置](../gesture/docs/roomcanvas-integration.md) · [确认与取消摆放](../README.md#手势) |
| 扫码查看布局、导入后离线漫游 | [手机分享与导入](MOBILE_HANDOFF.md) · [Android 安装、构建和操作](../android-app/README.md) |
| 重建自己的房间或拍照添加物品 | [上传完整扫描包](ROOM_RECONSTRUCTION.md#从网页重建房间) · [查看重建回放](ROOM_RECONSTRUCTION.md#查看重建过程) · [拍照与补拍](OBJECT_RECONSTRUCTION.md#在编辑器中使用) |

## 我想部署和维护服务

- **首次部署。** 安装房间和物品重建环境、分配 GPU，再启动两项服务和网关。[服务器部署与运维](SERVER_DEPLOYMENT.md)
- **从电脑连接。** 选择网关或单独转发后端，配置本机访问并核对缓存用量。[连接方式](SERVER_DEPLOYMENT.md#从电脑连接) · [服务凭证](SERVER_DEPLOYMENT.md#服务凭证) · [示例模型与缓存](SERVER_DEPLOYMENT.md#示例模型与本机缓存)
- **用命令行处理数据。** 运行房间重建或物品重建，核对输入与输出目录。[房间重建命令](ROOM_RECONSTRUCTION.md#运行) · [物品重建运行说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md)

## 我想参与开发

| 关注点 | 入口 |
| --- | --- |
| 分支、测试与合并 | [贡献指南](../CONTRIBUTING.md) · [项目约定](../AGENTS.md) |
| 网页与手势 | [编辑器光照、几何与渲染](architecture/web-editor-internals.md) · [手势模块](../gesture/README.md) |
| 房间重建与回放 | [房间模块](../room-reconstruction/README.md) · [阶段、续跑与回放事件](architecture/replay-and-pipeline.md) |
| 物品重建与模型契约 | [物品模块](../object-reconstruction/README.md) · [物品重建流水线](OBJECT_RECONSTRUCTION_PIPELINE.md) |
| 配置优先级、GPU 锁与兼容边界 | [配置与维护契约](refactor/contracts.md) |
| 手机客户端 | [快照导出与分享协议](architecture/mobile-handoff.md) · [Android 构建与模拟器](../android-app/README.md) |

## 我想查历史记录

- [项目交接记录（2026-11-03）](history/PROJECT_HANDOFF_2026-11-03.md) · [服务连接与下载用量记录](history/README_DEPLOYMENT_NOTES.md)
- [物品重建性能实验](history/OBJECT_RECONSTRUCTION_PERFORMANCE.md) · [PR 96 服务器验证](history/PR96_SERVER_VALIDATION.md)
- [房间安装与验证记录](history/ROOM_RECONSTRUCTION_VALIDATION.md) · [手机分享阶段计划](history/MOBILE_HANDOFF_PLAN.md) · [手机分享验证记录](history/MOBILE_HANDOFF_VALIDATION.md)
- [网页交互耗时记录](history/WEB_EDITOR_VALIDATION.md) · [重构实施与验收记录](refactor/README.md)
- [Git 历史改写说明](history/README.md) · [完整提交哈希对照](history/commit-map-2026-11-19.txt)
