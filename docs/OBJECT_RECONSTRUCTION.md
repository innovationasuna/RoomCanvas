# 物体重建（ViewForge）与手势

更新：2026-10-18。ViewForge 后端、查看器和手势前端都从本仓库源码启动；Python 环境、模型权重、照片和历史结果留在外部运行目录，不进 Git。

## 目录与职责

| 目录 | 职责 |
| --- | --- |
| `room-reconstruction/` | LiteReality 房间重建 |
| `web/`、`samples/` | RoomCanvas 主页、编辑器（Three.js）与示例房间；编辑器内置手势（识别代码由 `gesture/src/embed/` 打包），也可被手势页嵌入，可导入 ViewForge 物体 |
| `object-reconstruction/` | ViewForge：照片重建物体、尺寸标定、Babylon 布局页、碰撞和保存 |
| `gesture/` | 摄像头、MediaPipe Worker、手势识别和手势接入页 |
| `scripts/gesture.sh` | 本机手势入口 |

两个重建模块各用自己的 Python 环境。RoomCanvas 编辑器和 ViewForge 布局页是两个独立页面，手势页用 `?layout=` 选择嵌入哪一个，两者用同一套手势协议。

## 服务器：ViewForge 后端

照同目录的 `local.env.example` 写好 `object-reconstruction/configs/local.env`（运行目录 `VIEWFORGE_ROOT`、授权 GPU、共享 GPU 锁；空房间资产可用 `VIEWFORGE_ROOMS_ROOT` 另指），这个文件被 Git 忽略。然后在仓库根目录（Bash 或 Zsh）运行并保持终端：

```bash
cd object-reconstruction
source configs/local.env
source scripts/env.sh
python scripts/web.py --host <监听地址> --port 7862
```

监听地址按部署填，SSH 所在的环境要能访问到它（容器里运行时填容器地址）。当前服务器的目录、地址和更新约定见 [交接文档](HANDOFF.md)。后端迁移沿用原来的 GPU 设置和共享锁，不会自动开始重建，也不另装 CUDA 或 Python 环境。

## 本机：隧道、手势页和编辑器

需要 Node.js 22.12+ 和 npm。先开一个到后端的 SSH 端口转发（已有可用的 `7865` 隧道就跳过）：

```bash
ssh -N -L 127.0.0.1:7865:<后端监听地址>:7862 <SSH主机别名>
```

`-L` 的格式是 `本机地址:本机端口:服务器侧地址:端口`，服务器侧地址要和后端实际监听的一致。换了本机端口，手势页里的布局地址也要跟着改。

另开一个终端，在仓库根目录启动手势页：

```bash
sh scripts/gesture.sh install  # 第一次，或锁文件更新后
sh scripts/gesture.sh dev
```

- **ViewForge 布局页**：打开 <http://127.0.0.1:8800/viewforge.html>（默认嵌入 <http://127.0.0.1:7865/viewforge/layouts/viewer>）。先在布局页确认房间尺寸、加入物体，再点“开启摄像头”。松手和保存时由服务器做承托、碰撞校验和保存。ViewForge 首页是 <http://127.0.0.1:7865/>。
- **RoomCanvas 编辑器（room3）**：编辑器自己有“手势”开关，不需要手势页，见 [网页说明](../web/README.md)。下面是经手势页嵌入的做法：再开一个终端运行 `python3 web/scripts/serve.py --port 7870`，打开 <http://127.0.0.1:8800/viewforge.html?layout=http%3A%2F%2F127.0.0.1%3A7870%2Fweb%2Feditor%2F%3Froom%3Droom3>。渲染、碰撞和支撑检查都在本机浏览器里做（完整落点检查在 Worker 中）。“导入物体”经 `serve.py` 读 ViewForge 的物体目录、尺寸和模型（默认走 `7865` 隧道，`--viewforge <地址>` 可改），只摆原有家具时不需要隧道；导入的物体暂不随布局保存。换了编辑器端口，要同时改 `layout=` 里的地址。具体操作和限制见 [网页说明](../web/README.md)。

手势操作两个页面相同：左手 1（食指）、2（食指和中指）、3（食指、中指、无名指）保持约 0.4 秒，切到移动、旋转、仅观察；切换前右手先完全松开。右手拇指和食指捏合拖动；观察模式下两指捏合环绕，拇指、食指、中指合拢平移。RoomCanvas 编辑器里松手后家具停成预览，在预览上轻捏一下放下，仓库卡片也能捏住拖出。摄像头画面只在本机识别，不上传。

改了查看器源码（`object-reconstruction/viewer/`）后，在该目录运行 `npm ci`、`npm run build`，产物写到同模块的 `scripts/assets/`，随源码一起更新到服务器。

## 来源与范围

来源是 ViewForge `a93d457` 和手势工程 `32082a3`。整合分支当初保留了来源历史，但 PR #5 最终以 squash 合入 `main`，这两个哈希只作来源记录，新克隆的主线里不一定找得到。上游的许可证、版权和来源说明照旧保留；不重新合入旧整合分支，以免带进上游的共同作者标记。

迁移只改了启动入口和运行位置，重建、手势、碰撞、标定和保存的算法都没变。之后 RoomCanvas 编辑器加了手势接收端、ViewForge 物体导入和后台落点检查（#8），room3 换成了小物件这一步之后的结果（#10）。

## 2026-10-18 迁移验证（lyk）

- 正式的 `7862` 后端进程工作目录是 `/workspace/geyinuo/RoomCanvas/object-reconstruction`；旧源码后端和临时的 `7863` 验证进程已停。
- 切换前后 catalog 完全一致：3 个房间、26 个重建结果、0 个保存的布局；没有新建测试重建，也没有保存真实布局。
- 后端 71 项、查看器 34 项、手势 74 项测试通过；前端类型检查、两套构建，以及识别模型、WASM、GLB 清单校验都通过。
- 查看器构建产物与仓库里跟踪的资源一致；MV-SAM3D 从 RoomCanvas 导入，不再经过旧源码路径。
- 没有重跑 GPU 完整重建，也没有用真人摄像头试过，这两项留给实际使用验收。
