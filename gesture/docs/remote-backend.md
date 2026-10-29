# 远程识别后端

独立演示支持把手部识别放到局域网内的一台机器上（如一台 Mac mini），让多台电脑共用同一个推理服务。

## 工作方式

每台电脑的浏览器调用自己的摄像头，把画面等比例缩小到不超过 640×480 的 JPEG，发送到后端的同源接口 `/api/detect`。后端用 MediaPipe Python（CPU、IMAGE 模式）计算手部关键点，浏览器继续负责手势判定、控制逻辑和 Three.js 渲染。各电脑的房间、撤销历史和手势状态互相独立。

- **隐私**：默认仍是本机识别。只有在启动链接中选择远程模式，并点击“开启摄像头并发送画面”授权后才会发送画面。后端不录制、不保存画面或关键点，不输出请求日志，运行时不调用第三方云服务。访问令牌只存在内存中，刷新页面后需重新打开启动链接。
- **并发**：默认两个独立的模型实例，可同时处理两路请求，`--workers 1` 到 `--workers 8` 可调。超过并发上限时返回 503，前端跳过当前帧继续，不排队。
- **时效**：每个客户端同一时间只有一个在途请求；结果超过 250 毫秒即丢弃，连续 200 毫秒没有有效结果则中断当前操作，恢复后松手重新抓取。网络错误或请求超过 2 秒会停止摄像头。帧龄按客户端的采集时间计算，不要求各电脑时钟一致。

## 安装

在后端机器的 `gesture/` 目录下，用 Python 3.12 创建独立环境并按锁文件安装依赖：

```sh
python3.12 -m venv backend/.venv
backend/.venv/bin/python -m pip install --require-hashes -r backend/requirements.lock
```

或使用 uv：

```sh
uv venv --python 3.12 backend/.venv
uv pip sync --python backend/.venv/bin/python --require-hashes backend/requirements.lock
```

前端需要 Node.js 22.12+，执行 `npm ci` 和 `./scripts/run.sh build` 构建。

## HTTPS 证书

浏览器只在安全上下文中开放摄像头（见 [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)），局域网访问需要 HTTPS。生成包含后端 IP 的测试证书：

```sh
python3 scripts/create-test-cert.py <后端 IP>
```

只把 `backend/certs/ca.pem` 复制到每台客户端，导入系统受信任的根证书（macOS 在“钥匙串访问”中设为始终信任；Windows 导入“受信任的根证书颁发机构”；不使用系统信任的 Firefox 需单独导入）。私钥 `ca-key.pem`、`server-key.pem` 留在后端机器。证书有效期 30 天，后端 IP 变化后需重新生成。

## 启动

```sh
backend/.venv/bin/python backend/server.py \
  --host 0.0.0.0 --public-host <后端 IP> --port 8843 \
  --cert backend/certs/server.pem --key backend/certs/server-key.pem \
  --workers 2
```

终端会输出带随机访问令牌的 HTTPS 链接，局域网内的客户端打开这条链接并点击开启按钮即可。网页和推理接口共用 8843 端口，无需另开前端服务或配置 CORS。`Ctrl+C` 停止服务，重启后令牌会更换。服务面向局域网使用，不要配置公网转发。

不带证书运行 `backend/.venv/bin/python backend/server.py` 时只监听 `127.0.0.1:8843`，可用于本机调试。

## 检查

```sh
./scripts/run.sh test
./scripts/run.sh build
./scripts/run.sh resources
backend/.venv/bin/python -m unittest backend.test_server -v
```
