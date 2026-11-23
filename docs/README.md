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

- **准备服务器。** 核对 GPU 和系统依赖，安装重建环境，再启动服务。[房间重建安装](ROOM_RECONSTRUCTION.md#安装) · [物品服务部署、更新与重启](OBJECT_RECONSTRUCTION.md#部署)
- **从电脑连接。** 连接已有服务器，读取服务凭证；已完成的房间和回放可缓存到本机。[连接方式](../README.md#快速开始) · [服务凭证](../web/README.md#共享服务器的服务凭证) · [缓存管理](../web/README.md#清理本地缓存)
- **用命令行处理数据。** 运行房间重建或物品重建，核对输入与输出目录。[房间重建命令](ROOM_RECONSTRUCTION.md#运行) · [物品重建运行说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md)

## 我想参与开发

| 关注点 | 入口 |
| --- | --- |
| 分支、测试与合并 | [贡献指南](../CONTRIBUTING.md) · [项目约定](../AGENTS.md) |
| 网页与手势 | [编辑器代码结构](../web/README.md#代码结构) · [手势模块](../gesture/README.md) |
| 重建流程与数据契约 | [房间模块](../room-reconstruction/README.md) · [物品模块](../object-reconstruction/README.md) · [物品重建流水线](OBJECT_RECONSTRUCTION_PIPELINE.md) |
| 配置优先级、GPU 锁与兼容边界 | [配置与维护契约](refactor/contracts.md) |
| 手机客户端 | [Android 构建与模拟器](../android-app/README.md) |

## 我想查历史记录

- [项目交接记录（2026-11-03）](history/PROJECT_HANDOFF_2026-11-03.md) · [服务连接与下载用量记录](history/README_DEPLOYMENT_NOTES.md)
- [物品重建性能实验](history/OBJECT_RECONSTRUCTION_PERFORMANCE.md) · [PR 96 服务器验证](history/PR96_SERVER_VALIDATION.md)
- [手机分享阶段计划与验证](history/MOBILE_HANDOFF_PLAN.md) · [重构实施与验收记录](refactor/README.md)
- [Git 历史改写说明](history/README.md) · [完整提交哈希对照](history/commit-map-2026-11-19.txt)
