# ViewForge 与 RoomCanvas 整合

更新：2026-10-18。ViewForge 后端、查看器和手势前端均从 RoomCanvas 源码启动；模型权重、Python 环境、照片和历史结果继续使用外部运行目录，不复制进 Git。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `reconstruction/` | 原有 LiteReality 房间重建 |
| `web/`、`samples/` | 原有 Three.js 编辑器与示例房间 |
| `object-reconstruction/` | ViewForge 物体重建、标定、Babylon 布局、碰撞和保存 |
| `gesture/` | 摄像头、MediaPipe Worker、手势识别和 ViewForge 接入页 |
| `scripts/gesture.sh` | 本机手势入口 |

两个重建模块保留各自的 Python 环境。RoomCanvas 原编辑器与 ViewForge 布局仍是独立页面；手势入口目前嵌入 ViewForge 的 Babylon 布局，没有给原 Three.js 编辑器新增手势接口，也没有转换 room3 的场景格式。

## 服务器启动

在 `object-reconstruction/configs/local.env` 中按同目录的 `local.env.example` 配置运行目录、授权 GPU 和共享 GPU 锁；该文件被 Git 忽略，不提交密钥和机器配置。

`VIEWFORGE_ROOT` 指向外部运行目录，提供 Python 环境、权重、照片、历史结果和缓存；空房间资产可通过 `VIEWFORGE_ROOMS_ROOT` 指定。具体路径由各部署配置。

在 RoomCanvas 根目录执行并保持终端运行（以下 `source` 命令使用 Bash 或 Zsh）：

```bash
cd object-reconstruction
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 127.0.0.1 --port 7862
```

`--host`、`--port` 按实际部署设置。若服务运行在容器中，需确认 SSH 所在环境能访问该监听地址。当前服务器的实际目录和容器地址记录在 [交接文档](HANDOFF.md)。

迁移保留原 GPU 设置和共享锁，不自动运行重建、不安装另一套 CUDA/Python 环境。旧 ViewForge 源码目录不再作为正式后端入口。

## 本机启动

需要 Node.js 22.12+ 和 npm。本机先通过 SSH 端口转发访问服务器后端；以下示例对应后端监听 `127.0.0.1:7862`：

```bash
ssh -N -L 127.0.0.1:7865:127.0.0.1:7862 <SSH主机别名>
```

将 `<SSH主机别名>` 换成自己的 SSH 配置。`-L` 的格式为 `本机监听地址:本机端口:服务器侧目标地址:目标端口`；目标地址从 SSH 服务器侧访问，须与后端实际监听地址一致。容器部署时按需替换目标地址。已有可用的 `7865` 隧道时不重复启动；若修改本机端口，也需调整手势页的房间布局地址。连接命令由各使用者按自己的机器配置，无需专用脚本。

另一个终端在 RoomCanvas 根目录启动手势服务：

```bash
sh scripts/gesture.sh install  # 首次使用或锁文件更新后
sh scripts/gesture.sh dev
```

- 手势接入页：<http://127.0.0.1:8800/viewforge.html>。
- ViewForge 首页：<http://127.0.0.1:7865/>。
- 布局入口：<http://127.0.0.1:7865/viewforge/layouts/viewer>；由服务器解析新源码位置，不固定旧磁盘路径。

先在布局页确认房间尺寸、加入物体，再点击“开启摄像头”并授权。左手 1（食指）、2（食指和中指）、3（食指、中指、无名指）选择移动、旋转、仅观察，保持约 400ms。右手拇指和食指捏合拖动；观察模式下两指环绕、拇指/食指/中指合拢平移。切换前完全松手。摄像头和识别在本机浏览器执行，不上传画面；服务器在物体操作结束后做承托/碰撞校验并保存布局。

本机使用本仓库中的手势模块。修改查看器源码后，在 `object-reconstruction/viewer/` 执行 `npm ci`、`npm run build`，构建到同模块的 `scripts/assets/`，随源码更新服务器。

## 历史与范围

来源为 ViewForge `a93d457` 和手势工程 `32082a3`。最初整合分支保留了来源历史，GitHub PR #5 最终采用 squash 合入 `main`；这些原始哈希是来源记录，不保证在新克隆的主线中可达。开源许可证、版权和来源说明继续保留，不通过重新合入旧整合分支引入上游共同作者标记。

本次迁移只调整服务入口和运行位置，沿用原重建、手势、碰撞、标定和保存算法。RoomCanvas 的房间重建、原编辑器、样例及各模块的数据目录保持原有职责。服务器运行配置不进 Git，运行资源和模型权重不随源码迁移。

## 2026-10-18 迁移验证

- 正式 `7862` 后端的进程工作目录为 `/workspace/geyinuo/RoomCanvas/object-reconstruction`，旧源码后端和临时 `7863` 验证进程已停止。
- 切换前后 catalog 完全一致：3 个房间、26 个重建结果、0 个保存布局；未创建测试重建或保存真实布局。
- 后端 71 项、查看器 34 项、手势 74 项回归通过；前端类型检查、两套构建及识别模型/WASM/GLB 清单校验通过。
- 查看器构建产物与仓库已跟踪资源一致。检查确认 MV-SAM3D 导入来自 RoomCanvas，不再通过旧源码路径加载。
- 未重跑 GPU 完整重建或开启真人摄像头；这两项仍由实际使用验收。

本轮改动位于 `feat/run-viewforge-from-roomcanvas`，尚未提交或推送。本机与服务器使用同名分支，机器配置和日志不进 Git。
