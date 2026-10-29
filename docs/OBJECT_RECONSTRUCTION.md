# 物体重建

`object-reconstruction/` 把照片重建成带纹理的三维模型，并按一条实测边长标定到真实尺寸。它是无界面的 Starlette / Uvicorn API 服务，由网页编辑器的“添加物品”和“导入物品”调用。

## 部署

服务跑在 Linux GPU 服务器上，网页跑在本机，通过 SSH 隧道连接。

**服务器上**，首次部署：按 [运行说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md) 安装环境和权重，再从 `object-reconstruction/configs/local.env.example` 复制出 `configs/local.env`，填好 `VIEWFORGE_ROOT`、GPU 和共享锁，安装 API 依赖：

```bash
cd RoomCanvas/object-reconstruction
source configs/local.env && source scripts/env.sh
python -m pip install -r configs/api-requirements.txt
```

**服务器上**，启动服务（服务器重启后再执行一次）：

```bash
cd RoomCanvas/object-reconstruction
source configs/local.env && source scripts/env.sh
nohup python scripts/web.py --host 127.0.0.1 --port 7862 > "$VIEWFORGE_ROOT/logs/web.log" 2>&1 &
curl -s http://127.0.0.1:7862/health   # 检查服务是否在运行
```

**本机**：见下文 [在编辑器中使用](#在编辑器中使用)。

### 数据目录

`VIEWFORGE_ROOT` 下，`data/inputs/` 保存照片与蒙版，`runs/` 保存结果，`weights/`、`envs/`、`third_party/` 存放权重、环境和依赖。

## 在编辑器中使用

**本机**，在仓库根目录启动网页，同时打开到服务器的 SSH 隧道：

```bash
python3 web/scripts/serve.py --ssh <SSH 主机>
```

打开 <http://127.0.0.1:7880/web/>。隧道把本机 `127.0.0.1:7865` 接到服务器上的 `127.0.0.1:7862`，按 `Ctrl-C` 停止网页时一起关闭。服务监听的不是 `127.0.0.1`（例如在 Docker 容器里监听容器 IP）时，加上 `--remote <监听地址>:7862`。

“添加物品”：上传 1–40 张照片 → 确认抠图 → 重建 → 输入一条实测边长 → 放进房间。“导入物品”读取已有结果和标定，按真实尺寸摆放；操作见 [网页编辑器](../web/README.md#物品导入与添加)。

### 补拍

按结果页的橙色箭头补拍并上传照片，即可在原结果基础上重新重建。详见 [COVER 补拍引导](../object-reconstruction/docs/COVER.md)。

## 接口

| 接口 | 用途 |
| --- | --- |
| `POST /viewforge/objects/create` | 命名并上传 1–40 张 JPEG / PNG |
| `POST /viewforge/objects/capture` | 提交已有结果 `run` 和补拍照片 |
| `POST /viewforge/objects/masks` | BiRefNet 抠图，返回任务号 |
| `POST /viewforge/objects/reconstruct` | DA3 + MV-SAM3D 重建并生成 COVER 补拍建议；`parent` 指定原结果 |
| `GET /viewforge/objects/jobs/<任务号>` | 查询进度与结果 |
| `GET /viewforge/objects/previews/<批次>/<照片>.png` | 蒙版预览 |
| `GET /viewforge/assets/catalog` | 已重建物体目录 |
| `GET /viewforge/assets/<结果>` | 尺寸基准与已保存的标定 |
| `GET /viewforge/assets/<结果>/result.glb`、`preview.glb` | 完整模型、轻量模型 |
| `GET /viewforge/assets/<结果>/result.ply`、`preview.json` | Gaussian、补拍建议 |
| `GET /viewforge/dimensions/<结果>` | 读取标定 |
| `POST /viewforge/dimensions/<结果>` | 保存或清除实测标定，支持 mm / cm / m |
| `GET /viewforge/dimensions/<结果>/model.glb` | 导出米制模型 |
