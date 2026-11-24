# 物品重建与补拍

<a id="物体重建"></a>
<a id="重建与材质"></a>

拍一张或多张照片，把物品做成带 2048 × 2048 颜色贴图的三维模型。量出任一条边的真实长度，就能按比例放进房间。某一面看不清时，可以补拍那个角度。[重建与颜色烘焙](OBJECT_RECONSTRUCTION_PIPELINE.md#颜色烘焙)

## 在编辑器中使用

1. 打开房间，在物品库点 **添加物品**，输入名称并选择 1–40 张照片。绕物品拍摄可补足背面和侧面。网页接受 JPEG、PNG、HEIC 和 HEIF。
2. 确认每张照片的抠图，选择要保留的照片，开始重建。关闭弹窗后，服务继续计算。
3. 在尺寸预览中选择一个轴，按米输入实测边长。例如桌宽 60 厘米，选 X 轴，填 `0.60`，确认后放入房间。模型贴图会随室内光照显示。
4. 要使用已有结果，在物品库点 **从已生成的模型添加**，选择模型并核对已保存的尺寸。缺少尺寸时，按米补填一条实测边长再放入房间。[网页操作指南](../web/README.md#添加与导入物品)

### 补拍

按尺寸预览里的橙色箭头，从建议方向拍一两张新照片。选择补拍，上传并确认抠图后，将原照片与新角度一起重建。没有方向建议时也能补拍。

原来的模型和房间里已经摆好的实例都会保留。确认新结果后，按需要把新模型加入房间。[补拍方向的计算与输出](../object-reconstruction/docs/COVER.md)

## 部署

服务器运行无界面的 Starlette / Uvicorn API，本机运行网页。新建模型需要 GPU。已有模型可通过已配置的预览服务读取。安装条件、网关、凭证及连接方式见[服务器部署与运维](SERVER_DEPLOYMENT.md)。

### 首次部署

在服务器的仓库根目录用 Bash 执行以下命令。若需自定义环境和数据位置，先将 `VIEWFORGE_ROOT` 设为可写的绝对路径。

```bash
bash scripts/setup_server.sh objects --dry-run
bash scripts/setup_server.sh objects
```

模块安装入口也可直接运行 `bash object-reconstruction/scripts/setup.sh`。安装包括重建环境、API 依赖、外部源码、权重，以及单独的 BiRefNet 抠图环境。[安装配方与续装](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#安装)

### 启动与检查

通常由统一启动脚本管理服务和网关。若单独维护物品 API，先确认端口空闲，再从服务器的 `object-reconstruction/` 启动进程。

```bash
source configs/local.env && source scripts/env.sh
mkdir -p "$VIEWFORGE_ROOT/logs"
nohup python scripts/web.py --host 127.0.0.1 --port 7862 >> "$VIEWFORGE_ROOT/logs/web.log" 2>&1 &
```

等服务启动后，在同一目录运行带凭证的健康检查。自定义了监听地址或凭证文件时，使用该实例的可达地址与凭证配置。

```bash
PYTHONPATH=../scripts python3 -c "from service_auth import load_token, urlopen; print(urlopen('http://127.0.0.1:7862/health', token=load_token()).read().decode())"
```

正常返回 `{"service":"roomcanvas-objects","status":"ok"}`。失败时查看 `$VIEWFORGE_ROOT/logs/web.log`。要验证烘焙，在正式环境检查 nvdiffrast、gsplat、xatlas 并试跑模型。[CUDA 烘焙检查](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md#颜色烘焙)

### 更新与重启

任务进度保存在服务进程内。等任务完成后再重启，已保存的结果仍可导入。先按[服务器更新步骤](SERVER_DEPLOYMENT.md)核对分支、工作区与在途任务。

手动管理的实例可用以下命令核对旧进程。将 `PID` 设置为实际进程号，确认命令和工作目录属于本服务后，再停止该进程。

```bash
pgrep -af 'python.*scripts/web.py'
ps -p "$PID" -o pid,args
readlink "/proc/$PID/cwd"
kill "$PID"
ps -p "$PID" -o pid,args
```

等旧进程退出。需要更新代码时，在仓库根目录快进更新 `main`。若 API 依赖变更，请在 `object-reconstruction/` 重新安装依赖。

```bash
source configs/local.env && source scripts/env.sh
python -m pip install -r configs/api-requirements.txt
```

仅重启时直接沿用原监听地址[启动与检查](#启动与检查)。重建依赖或权重升级时，核对安装配方，在新运行目录安装并切换配置。

### 数据目录

`VIEWFORGE_ROOT` 下，`data/inputs/` 保存照片和蒙版，`runs/` 保存结果，`weights/`、`envs/`、`third_party/` 分别存放权重、环境和外部源码。更新代码时保留这些目录。[模块目录说明](../object-reconstruction/docs/DIRECTORY_LAYOUT.md)

## 接口

下列接口可通过物品服务或服务器网关调用。已连接服务的网页代理也能转发表中大部分请求，例外在表内注明。直接调用上传接口时发送 JPEG / PNG，单次上传请求（含表单）的上限为 419,430,400 字节，约 419.4 MB。网页会先在本地将 HEIC / HEIF 转为 JPEG。[算法、格式与发布契约](OBJECT_RECONSTRUCTION_PIPELINE.md)

| 方法与路径 | 用途 |
| --- | --- |
| `POST /viewforge/objects/create` | 命名并上传 1–40 张照片 |
| `POST /viewforge/objects/capture` | 提交已有结果的 `run` 和补拍照片。新旧照片合计最多 40 张 |
| `POST /viewforge/objects/masks` | 启动 BiRefNet 抠图，返回任务号 |
| `POST /viewforge/objects/reconstruct` | 提交已确认的照片和抠图任务，启动 DA3、MV-SAM3D 和 COVER。补拍用 `parent` 指定原结果 |
| `GET /viewforge/objects/jobs/<任务号>` | 查询进度与结果 |
| `GET /viewforge/objects/previews/<预览批次>/<照片名>.png` | 读取抠图结果返回的预览路径 |
| `GET /viewforge/assets/catalog` | 列出可导入的重建结果 |
| `GET /viewforge/assets/<结果>` | 网页代理用此接口读取尺寸基准、已保存标定及可用的材质能力 |
| `GET /viewforge/assets/<结果>/<文件名>` | `result.glb` 完整模型、`result.ply` Gaussian、`preview.json` 显示信息与建议。按结果提供 `collision.glb` 碰撞模型或 `preview.glb` 轻量模型 |
| `GET /viewforge/dimensions/<结果>` | 读取标定（仅物品服务或服务器网关） |
| `POST /viewforge/dimensions/<结果>` | 保存或清除标定，支持 mm / cm / m |
| `GET /viewforge/dimensions/<结果>/model.glb` | 下载已标定的米制模型（仅物品服务或服务器网关） |
