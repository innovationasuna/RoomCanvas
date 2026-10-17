# Mac mini 后端与多电脑摄像头测试

## 工作方式

每台电脑的浏览器调用自己的摄像头，将等比例缩小到不超过 640×480 的 JPEG 发到 Mac mini 的同源 `/api/detect`。Mac mini 用 MediaPipe Python CPU 模型计算关键点，浏览器保留手势判定、控制逻辑与 Three.js 渲染。各电脑的房间、撤销历史、手势状态互相独立，不同步家具布局。

默认仍是本机浏览器识别，不上传。Mac mini 启动链接预选远程模式，但只有用户点击“开启摄像头并发送画面”并授权摄像头后才发送画面。停止、切换模式、切换设备时取消在途请求。令牌只存在内存，刷新后需要重新打开启动链接。不录制、不保存画面或关键点，不输出请求日志。后端安装依赖时需要网络，运行时不调用第三方云服务。

后端使用 IMAGE 模式，每帧独立识别，无跨客户端视频追踪状态；与原浏览器 VIDEO 模式性能和稳定性可能不同，需要实测。默认两个独立模型实例，可以同时处理两路请求。超过并发上限返回 503，前端跳过当前帧继续尝试，不排队。并发数不是最大访问电脑数，也不是可保证的流畅设备数。可用 `--workers 1` 到 `--workers 8` 调整，增加实例会增加 CPU 与内存开销。

单客户端仅一个在途请求。沿用结果超过 250ms 丢弃、连续无有效结果超过 200ms 中断的规则；重获后松手再抓取。忙或断网不算放置确认。网络错误或请求超过 2 秒会停止摄像头，需要重新点击开启。跨设备通过客户端捕获时间计龄，不依赖两台电脑时钟一致。

## 安装与启动

已读到的测试目标：`ssh macmini`，Apple Silicon，局域网 IP `10.40.14.82`（2026-10-10；地址变化需要重新生成证书）。已保存完整工程到 `/Users/awhy/Desktop/3D视觉设计/手势家具布置演示`，使用已有 uv 0.12.22 安装 CPython 3.12.15 与锁定依赖；临时 HTTPS 测试服务已启动，默认两个实例，无开机启动配置。

以下命令在 Mac mini 的本工程目录执行。安装 Python 3.12 后创建工程内独立环境：

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock
```

若已有 uv，可改用：

```sh
uv venv --python 3.12 backend/.venv
uv pip sync --python backend/.venv/bin/python --require-hashes backend/requirements.lock
```

完整工程需 Node.js 22.12+，执行 `npm ci` 和 `./scripts/run.sh build`。使用打包的 `outputs/macmini-demo.tar.gz` 则已包含 dist，无需在 Mac mini 安装 Node 或重新构建。

生成含 Mac mini IP 的测试证书：

```sh
python3 scripts/create-test-cert.py 10.40.14.82
```

把 **仅 `backend/certs/ca.pem`** 复制到每台测试电脑并导入系统受信任根证书。Mac 在“钥匙串访问”导入并设置此测试 CA 为始终信任；Windows 导入“受信任的根证书颁发机构”；Firefox 如不使用系统信任，需导入其证书颁发机构。证书不受信任时先完成信任配置，不依赖忽略浏览器错误。浏览器摄像头要求安全上下文，普通 `http://10.40.14.82` 不适用。依据 [getUserMedia 文档](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。私钥 `ca-key.pem` 和 `server-key.pem` 留在 Mac mini，不复制到客户端。证书仅有效 30 天，测试结束可删除导入的测试 CA。

```sh
backend/.venv/bin/python backend/server.py \
  --host 0.0.0.0 --public-host 10.40.14.82 --port 8843 \
  --cert backend/certs/server.pem --key backend/certs/server-key.pem \
  --workers 2
```

终端输出含随机访问令牌的 HTTPS 链接。所有测试电脑在同一局域网内打开这条链接，点击开启按钮；允许 Mac mini 的 Python 接收局域网连接。`Ctrl+C` 停止后端，重启会更换令牌。服务是局域网原型，不配置公网转发。网页、模型接口均使用 8843，同源无需另开前端端口或配置 CORS。

## 本机验证

```sh
./scripts/run.sh test
./scripts/run.sh build
./scripts/run.sh resources
backend/.venv/bin/python -m unittest backend.test_server -v
```

不需要摄像头的本机运行：`backend/.venv/bin/python backend/server.py`，默认仅监听 127.0.0.1:8843，可通过终端输出的 localhost 链接验证网页与接口。本机浏览器模式仍可用原来的 `./scripts/run.sh dev`。

## 真实设备验收（待执行）

| 场景 | 记录 |
| --- | --- |
| 一台客户端：设备、浏览器、网络，30 秒推理耗时/往返/Hz、抓取和松开体验 | 待测 |
| 两台客户端同时：各自推理/往返/Hz，Mac mini CPU 与内存 | 待测 |
| 三台及以上：逐台增加，观察忙时丢帧和冻结；不同 workers 设置 | 待测 |
| 设备 A 摄像头/手势不能影响设备 B 家具 | 待测 |
| 拖动时断网或停止后端：立即冻结，不能提交，恢复后松手重抓 | 待测 |
| 改用本机模式不再向 /api/detect 上传；停止按钮释放摄像头 | 待测 |

合成协议测试和空白图推理只验证实现链路，不代表以上真人验收通过。

## 2026-10-10 · 跨机器合成检查

Mac mini 上 5 项后端测试通过，包括真实模型空白图。当前电脑使用测试 CA 验证 TLS，健康接口返回 200。从同一台电脑发出两条并发请求流，各发送 5 张 640×480 空白 JPEG：平均推理 16.2 / 14.9ms，平均往返 39.4 / 41.0ms。仅覆盖小样本无手图，不包含浏览器编码与真人识别，不用于宣称设备承载量或手势精度。

Chrome 无障碍树确认远程选择、发送画面提示和开启按钮；截图服务出现 ScreenCaptureKit 错误，本阶段未完成截图视觉检查。没有启用真人摄像头。每台测试电脑需导入测试 CA，再执行真人验收。
