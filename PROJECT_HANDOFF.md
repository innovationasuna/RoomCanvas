# 项目交接

更新：2026-11-03。当前分支 `feat/objects-trellis`，单独物体主线已收敛为 **MV-SAM3D + 颜色烘焙 + 场景受光**。单图／多图 TRELLIS 与分区材质试验源码、测试、调研和对比文档已清理；房间重建自己的 TRELLIS 流程保留。

## 当前实现

- 默认 `mesh_export.mode=baked_pbr`、纹理 2048、roughness 1、metallic 0。颜色来自原生 Gaussian 观察烘焙，不预测分区属性，也不自动去光照。
- 保留多图、Gaussian、COVER 补拍和实测尺寸标定。UV 缓存校验源几何；烘焙失败会报错，不静默回退。
- 资产接口依据成功的 `materials.json` 标记 PBR。尺寸预览与场景导入保留纹理并响应灯光；旧版顶点色仍可切换受光。
- `requirements.inference.txt` 固定 nvdiffrast commit `253ac4fcea7de5f396371124af597e6cc957bfae`（0.4.0），安装入口也检查已有环境。补装与 CUDA 检查见 [运行说明](object-reconstruction/docs/VIEWFORGE_RUNTIME.md#颜色烘焙)。

## 服务器与验证

服务器 `gynserver`，项目 `/workspace/geyinuo/RoomCanvas`，正式 MV Python 为 `runtime/object-reconstruction/envs/mvsam3d/bin/python`。已在该环境编译安装 nvdiffrast 0.4.0；CUDA 光栅化、纹理梯度和两张 Gaussian 渲染检查通过，不依赖旧实验的临时包。

实际验收任务 `20261103_sofa_web_201941_871752` 通过正式 API 完成抠图确认、DA3、MV-SAM3D、2048 烘焙与 COVER。重建及 COVER 耗时 639.856 秒，其中烘焙适配阶段 369.344 秒。`materials.json` 与 `result.json` 均成功；烘焙和同次顶点色模型的 516,804 个三角面、几何哈希及包围盒一致；临时副本的米制导出保留颜色贴图。

物体 API／资产／尺寸／抠图／补拍／调度／COVER／烘焙 CPU 测试共 55 项、网页 Node 252 项和网页 Python 29 项通过。安装 dry-run 与 shell 语法检查通过。Chrome 中旧版导入、默认受光和摆放切换检查通过；真实烘焙沙发的尺寸预览、临时标定、确认摆放与场景灯光响应通过，即使 `materials=original` 仍保留 2048² 贴图和 PBR，页面脚本无错误。

服务器源码备份及验收记录位于 `/workspace/geyinuo/roomcanvas-mv-baking-backup-20261103/`，含 `source-before.tar`、`verification.json`、`artifact-audit.json` 和 CPU 测试日志。本机浏览器证据与本次真实 GLB 在仓库外 `/tmp/roomcanvas-mv-verification-20261103/`。照片、模型、权重和历史实验图均不提交。

## 运维约束

- Mutagen `roomcanvas-gynserver` 继续暂停；本次仅显式部署已审阅源码，不恢复双向同步。
- 服务器 Git 保持 `main`（`abbd001`）并叠加本次源码；本机功能分支单独提交推送。不在服务器直接 `git pull` 覆盖工作区。
- 既有物体 API 已重载，`172.18.0.2:7862` 的健康检查与真实烘焙资产契约通过；本次临时回环 API 已停止。本机 `serve.py --ssh gynserver --remote 172.18.0.2:7862` 连接。房间服务在 7866，未重启。
- GPU 继续使用 `configs/local.env` 指定的单卡与共享锁；CPU 测试应移除 `VIEWFORGE_GPU_LOCK`，防止误用正式作业锁。
