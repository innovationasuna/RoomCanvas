# 来源、版本与许可

核查日期：2026-10-09。依赖解析固定在 package-lock.json，不使用 @latest 或 CDN。

| 内容 | 版本/来源 | 许可 |
| --- | --- | --- |
| Three.js | 0.186.1；https://github.com/mrdoob/three.js | MIT |
| MediaPipe Tasks Vision / WASM | 1.1.0；https://www.npmjs.com/package/@mediapipe/tasks-vision | Apache-2.0 |
| Hand Landmarker 模型 | float16/1，官方 storage.googleapis.com/mediapipe-models | 官方模型卡标明 Apache-2.0 |
| TypeScript | 5.9.3；https://github.com/microsoft/TypeScript | Apache-2.0 |
| Vite | 8.3.4；https://github.com/vitejs/vite | MIT |
| Vitest | 5.0.3；https://github.com/vitest-dev/vitest | MIT |
| @types/three / @types/node | 0.186.0 / 24.10.1；DefinitelyTyped | MIT |
| One Euro Filter | 本工程独立实现；算法：Casiez, Roussel, Vogel, CHI 2012 | 实现属于本工程，未复制第三方源码 |
| GLB、界面、图标 | scripts/generate-assets.mjs 自制房间、沙发、茶几、椅子；图标/配色自制 | 本工程自制资产，无第三方模型授权依赖；未另行对外授权 |
| 环境贴图 | Three.js RoomEnvironment 运行时生成 | Three.js MIT，无外部 HDR 下载 |

模型 URL：https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task

官方任务说明：https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/index

官方模型卡（第 2 页 LICENSED UNDER）：https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf

算法与作者实现：https://gery.casiez.net/1euro/

模型与每个 WASM/JS 的来源、字节数和 SHA-256 在 public/vision/manifest.json；执行 `./scripts/run.sh resources` 校验。自制 GLB 可通过 `npm run assets` 重建，不需要联网。

没有引入第三方仓库、第三方云推理、遥测、字体或纹理；可选远程模式仅向用户指定的 Mac mini 发送画面。正式对外分发前应随发行物保留依赖许可及第三方声明；本工程目前为 private 本地原型。

旧工程调研只引用：总目录内的 `手势控制3D模型/research/modular-selection-2026-10-09.md`（不随本仓库分发）。未复制旧工程代码和 node_modules。

## 2026-10-10 · 可选 Mac mini 后端

Python 3.12，HTTP/HTTPS 服务使用 Python 标准库；推理采用 MediaPipe Python 0.10.32 CPU / IMAGE 模式，复用既有模型，不下载新模型。API 依据 [官方 Python 指南](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/python)。前端 JPEG 编码及网络请求不引入新 JS 依赖。

全部直接与传递依赖固定于 backend/requirements.lock，包含发行包 SHA-256，安装使用 --require-hashes。版本、来源、许可、发行包校验值与锁文件校验值也记录在 public/vision/manifest.json 的 backend 字段。许可包含 wheel 自带的第三方许可，分发时保留完整 wheel 许可文件。

| 包 | 版本 | 来源 | 许可 |
| --- | --- | --- | --- |
| absl-py | 2.5.1 | [PyPI](https://pypi.org/project/absl-py/2.5.1/) | Apache-2.0 |
| cffi | 2.1.1 | [PyPI](https://pypi.org/project/cffi/2.1.1/) | MIT-0 |
| contourpy | 1.4.0 | [PyPI](https://pypi.org/project/contourpy/1.4.0/) | BSD-3-Clause |
| cycler | 0.12.1 | [PyPI](https://pypi.org/project/cycler/0.12.1/) | BSD-3-Clause |
| flatbuffers | 25.12.19 | [PyPI](https://pypi.org/project/flatbuffers/25.12.19/) | Apache 2.0 |
| fonttools | 4.66.1 | [PyPI](https://pypi.org/project/fonttools/4.66.1/) | MIT |
| kiwisolver | 1.5.1 | [PyPI](https://pypi.org/project/kiwisolver/1.5.1/) | BSD-3-Clause |
| matplotlib | 3.11.2 | [PyPI](https://pypi.org/project/matplotlib/3.11.2/) | Matplotlib license (PSF-based); bundled licenses in wheel |
| mediapipe | 0.10.32 | [PyPI](https://pypi.org/project/mediapipe/0.10.32/) | Apache 2.0 |
| numpy | 2.5.3 | [PyPI](https://pypi.org/project/numpy/2.5.3/) | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| opencv-contrib-python | 5.0.0.93 | [PyPI](https://pypi.org/project/opencv-contrib-python/5.0.0.93/) | Apache 2.0 |
| packaging | 26.3 | [PyPI](https://pypi.org/project/packaging/26.3/) | Apache-2.0 OR BSD-2-Clause |
| pillow | 11.3.0 | [PyPI](https://pypi.org/project/pillow/11.3.0/) | MIT-CMU |
| pycparser | 3.11 | [PyPI](https://pypi.org/project/pycparser/3.11/) | BSD-3-Clause |
| pyparsing | 3.3.3 | [PyPI](https://pypi.org/project/pyparsing/3.3.3/) | MIT |
| python-dateutil | 2.9.0.post0 | [PyPI](https://pypi.org/project/python-dateutil/2.9.0.post0/) | Apache-2.0 OR BSD-3-Clause |
| six | 1.17.0 | [PyPI](https://pypi.org/project/six/1.17.0/) | MIT |
| sounddevice | 0.5.6 | [PyPI](https://pypi.org/project/sounddevice/0.5.6/) | MIT |

局域网测试证书由本工程 scripts/create-test-cert.py 调用系统 OpenSSL 生成，有效期 30 天；私钥与虚拟环境不进入分发包。
