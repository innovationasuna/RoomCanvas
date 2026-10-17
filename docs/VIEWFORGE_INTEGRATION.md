# ViewForge 与 RoomCanvas 整合

日期：2026-10-17。整合分支 `feat/integrate-viewforge` 基于 RoomCanvas 最新主线 `9e9a897`；历史导入提交为 `670a8bf`。本次统一源码目录与 Git 历史，保留各模块已有功能和入口。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `reconstruction/` | 原有 LiteReality 房间重建 |
| `web/`、`samples/` | 原有 Three.js 编辑器与示例房间 |
| `object-reconstruction/` | ViewForge 多视角物体重建、尺寸标定、Babylon 布局、服务器碰撞与手势接收端 |
| `gesture/` | 浏览器摄像头、MediaPipe Worker、手势识别、ViewForge 接入页和原独立演示 |
| `scripts/gesture.sh` | 按脚本相对位置启动根目录的手势模块 |

两个重建模块保留各自的 Python 环境；两个前端模块保留各自的 `package.json`、锁文件和 `node_modules`。原 Three.js 编辑器与 Babylon 布局仍是独立页面；手势接入页只嵌入一个 Babylon 场景。

## 启动

RoomCanvas 原编辑器仍在仓库根目录启动静态服务，打开 `/web/`。原房间重建继续使用 `reconstruction/server/run_room.py`。

本机在拉取后的 RoomCanvas 根目录执行，需要 Node.js 22.12+ 和 npm：

```bash
sh scripts/gesture.sh install
sh scripts/gesture.sh dev
```

打开 <http://127.0.0.1:8800/viewforge.html>，保持 ViewForge 的 SSH 隧道可用。默认场景地址为 `http://127.0.0.1:7865/viewforge/layouts/viewer`，服务器按实际源码位置解析布局页；也可在页面或 `?layout=` 中修改地址。物体模块内 `scripts/gesture.sh` 是同一入口的兼容转发。

服务器物体重建从 `object-reconstruction/` 启动，显式加载本机配置后使用原命令：

```bash
source configs/local.env
source scripts/env.sh
python scripts/web.py --host 172.18.0.2 --port 7862
```

`configs/local.env` 由该模块的示例配置填写，不进入 Git。`VIEWFORGE_ROOT` 指向外部运行目录，现有服务器仍是 `/workspace/geyinuo/ViewForge`；权重、环境、照片和结果不迁入源码仓库。`VIEWFORGE_ROOMS_ROOT` 继续指定原空房间资产目录。

摄像头、手势识别和场景渲染在用户浏览器执行，通过 postMessage 控制物体/相机；服务器提供资源，执行物体重建、操作结束后的承托/碰撞校验及布局保存。没有更改手势动作或场景操作算法。

## Git 历史

- RoomCanvas 以 `9e9a897` 为基线，原有文件与历史保留。
- ViewForge 以 `a93d457` 为来源，完整 35 个可达提交（包含原手势仓库的 5 个提交）通过合并父链导入；原哈希、作者、作者时间和提交者时间不变。
- 导入提交 `670a8bf` 的 `object-reconstruction/` 树与 ViewForge 原树完全一致。后续单独把其中的 `gesture-furniture-demo/` 移到根目录 `gesture/`，调整启动脚本和文档。
- `git log a93d457` 查看完整原 ViewForge 历史，`git log 32082a3` 查看原手势历史。旧提交中的路径仍相对于原仓库根目录。
- ViewForge 事后拆分的阶段提交日期推定依据，见 [原历史整理说明](../object-reconstruction/docs/HISTORY_INTEGRATION.md)。

此整合分支若合入 `main`，应使用普通 merge commit，保留上述父链；squash 或 rebase 合并会使原提交不再作为 main 的祖先。普通后续功能仍按现有贡献流程处理。

## 范围与运行状态

原 `reconstruction/`、`web/`、`samples/` 的源码与资产不作改动。导入模块中的运行算法也保持原样；CI 追加两个前端模块的检查、测试和构建。没有把 RoomCanvas 整体 `Room.glb` 自动转换成 ViewForge 的空房间格式，也没有给原 Three.js 编辑器新增手势接口。

本次只在整合分支保存代码和提交，没有推送 GitHub 或合并 main；原 ViewForge Git 仓库、Mutagen 会话及运行服务保留。新源码可使用现有外部运行数据进行独立验证，正式服务切换另行执行。

## 本次验证

- 原 RoomCanvas 编辑器 122 项 Node 测试、6 项 Python 测试通过。
- 新位置的手势模块 74 项测试、类型检查、资源校验与双入口构建通过；从仓库外调用根脚本和物体模块兼容脚本均可定位同一手势目录。
- 新位置的 ViewForge 前端 34 项测试、类型检查与构建通过，后端 71 项测试通过。
- 在服务器临时端口启动新物体模块，确认布局入口重定向到 RoomCanvas 内的新资源路径，并保留手势会话；catalog 仍有原 3 个房间和 26 个重建结果。验证后关闭临时服务，没有切换现有服务或新增重建/布局结果。
- 检查原 `reconstruction/`、`web/`、`samples/` 与主线一致，核对导入前后原始提交的身份与时间。未重新执行 GPU 重建、真人摄像头验收或云端 CI。
