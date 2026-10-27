# 独立物体复用场景 TRELLIS.2：实验记录

更新：2026-10-27。实验分支：`feat/objects-trellis`。这是两个入口共用物体生成模块的实验，房间扫描、布局、组装和关节流程没有合并。

## 接入内容

```text
用户照片 → 原有 BiRefNet 抠图与人工确认
        → 保留的第一张照片 + 确认后的 alpha
        → 场景侧 trellis_local.py → 同一份 TRELLIS.2 推理模块及本地权重
        → 带 PBR 的 result.glb → 实测单轴标定 → 房间摆放
```

按本次确认，首版直接使用第一张确认照片，不调用图像生成 API。多张照片可以保留，但不会融合；`reconstruction/generation.json` 记录实际使用和未使用的照片 ID。照片 RGB 与蒙版 alpha 合成透明 PNG，裁前景并加透明边缘，不以黑色阈值删除物体的深色表面。

核心实现为 [`run_trellis.py`](../object-reconstruction/scripts/run_trellis.py)，调用现有 [`trellis_local.py`](../room-reconstruction/server/trellis_local.py) 和 [`models/trellis/inference.py`](../room-reconstruction/src/litereality_agent/models/trellis/inference.py)，没有复制模型实现或引入第二套 TRELLIS 权重。

| 项目 | 原有 MV-SAM3D | TRELLIS 实验 |
| --- | --- | --- |
| 选择方式 | 默认；`--backend mvsam3d` | `--backend trellis`，API 启动时设 `VIEWFORGE_BACKEND=trellis` |
| 生成条件 | DA3 pointmap + 多视角图像／蒙版 | 第一张确认图的 RGBA；其余图不参与推理 |
| 推理环境 | ViewForge 的 MV-SAM3D 环境 | 独立子进程使用现有 room 的 TRELLIS 环境 |
| 产物 | GLB + Gaussian，默认主要顶点色 | PBR GLB；不要求或伪造 Gaussian |
| 补拍与 COVER | 保留原功能 | 明确标注不支持，隐藏／禁用相关入口 |
| 尺寸 | 完整 GLB、显示变换、单轴实测 | 复用同一标定接口；glTF 已是 Y-up，不套用 SAM3D 的旋转 |
| 展示 | 旧显示与受光实验均保留 | 尺寸预览及房间导入保留生成的 PBR 贴图，并受场景光照影响 |
| 轻量预览 | 原有顶点色简化 GLB | 暂不生成，以免减面过程丢掉 UV／材质；碰撞回退到完整网格 |

默认后端仍是 MV-SAM3D；历史结果没有迁移。实验服务读取历史 MV-SAM3D 结果时，补拍仍选用该结果的原后端。新后端不改变正式服务，使用独立目录验证。

## 命令行验证

调用者仍使用 ViewForge 的 Python，包装器再启动 TRELLIS Python；不要把两个环境的依赖混装。沿用已有单卡授权与 `VIEWFORGE_GPU_LOCK`，TRELLIS 推理额外取得场景侧同一张卡的锁。

```bash
# 在实验 checkout 中；先按现有配置激活 ViewForge 环境
cd object-reconstruction
source configs/local.env
source scripts/env.sh
export VIEWFORGE_ROOT=/path/to/isolated/trellis-trial/viewforge
export ROOMCANVAS_HOME=/workspace/geyinuo/RoomCanvas

# 先检查照片、蒙版、现有 TRELLIS 环境和授权 GPU
python scripts/run.py --backend trellis --object <物体目录名> --attempt trellis-a01 --check

# 写入新的 runs 目录；同一个 attempt 不覆盖重跑
python scripts/run.py --backend trellis --object <物体目录名> --attempt trellis-a01
```

可用 `--images <照片ID> ...` 限定确认照片；实际第一张以 `inputs.json` 顺序为准。`--parent-run` 在 TRELLIS 实验中不支持。`configs/default.yaml` 中的 `trellis` 配置默认 `1024_cascade`、2048 贴图、50,000 面目标，seed 为 42；具体耗时、显存和效果须实测，不能套用 H100 宣传数据。

环境要求：`ROOMCANVAS_HOME` 中已有 `runtime/trellis-env`、`backends/TRELLIS.2`、TRELLIS／DINOv3／稀疏解码器权重。可用 `TRELLIS_PYTHON` 覆盖解释器路径；权重和本地编译库仍按现有服务器布局读取。全部使用现有本地权重，不下载模型或调用付费 API。

## API 与网页验证

使用独立测试后端，保持正式 7862 服务不变：

```bash
export VIEWFORGE_BACKEND=trellis
python scripts/web.py --host 127.0.0.1 --port 7863
```

独立数据根目录需事先准备；若复用已有 BiRefNet 环境与权重，只为测试根目录的 `envs` 和 `weights` 建立指向既有资源的链接，照片、cache、logs、runs 均留在测试根目录，不链接到正式数据目录。

浏览器仍走现有“添加物体”。`GET /viewforge/objects/capabilities` 告知当前新建任务使用第一张照片；任务进度不再显示 DA3／COVER。`GET /viewforge/assets/<run>` 给 TRELLIS 结果返回能力信息，供预览、PBR 导入和补拍按钮使用；旧结果读取保持兼容。

本机预览服务应指向测试后端／测试 SSH 隧道：

```bash
python3 web/scripts/serve.py --port 7881 --viewforge http://127.0.0.1:<测试隧道端口>
```

原有“导入物体随光照变化”开关仍控制旧顶点色资产；TRELLIS 原生 PBR 保持受光，避免开关关闭时把纹理抹成白色。模型本身若猜错粗糙度、金属度或未见面，本次接入不会自动修正。

## 验证状态与后续

- CPU 验证覆盖确认蒙版合成、首图选择及未用照片记录、后端调度、缺失 Gaussian 的处理、共享启动器失败时不误报成功，以及真实 GLB 的 PBR 贴图通过实测缩放导出后保持一致。
- Python 3.12 下后端 CPU **54 项**、网页 **217 项**、本机服务 **12 项**通过；未修改房间侧模型算法。首次本地 Python 3.10 测试环境的 SciPy wheel 与系统不兼容，改用隔离的 Python 3.12 环境后旧 COVER 测试通过，没有为此改项目依赖。
- 后续再研究多视角参考图、真正的多视角几何融合、适配其他后端的补拍策略，以及保留 PBR 的轻量碰撞／预览网格。

### 真实 GPU 试跑

通过本机已配置的 `gynserver`，在服务器新目录 `/workspace/geyinuo/roomcanvas-trellis-20261027-_7w1rz47/` 建立独立源码和数据副本；只复制既有沙发测试照片与蒙版，不改正式照片、运行结果、仓库或 7862 服务。使用正式配置授权的 GPU 0 和共享锁，GPU 1 未参与。

| 项目 | 本次结果 |
| --- | --- |
| 完成运行 | `viewforge/runs/20261027_sofa_trial_a02/` |
| 输入 | 一张既有沙发照片，使用原确认蒙版；未调用图像生成 API |
| 配置 | seed 42、`1024_cascade`、2048 贴图、50,000 面目标、现有 low-VRAM 模式 |
| 硬件 | 单张 RTX 3090；未测连续采样意义上的峰值显存 |
| 总耗时 | **218.201 秒**，包含本轮模型加载、生成及导出；不是多样本性能基准 |
| 输出 | `result.glb` **9,577,776 字节**，1 个 mesh、1 个材质；基础色和 metallic／roughness 贴图各一份 |
| 能力边界 | 没有 Gaussian；`cover_status=unsupported`，不伪造补拍方向 |

首轮 `a01` 因手动试跑命令未设置线程限制，加载时开了 138 个线程、进展缓慢，主动停止该实验 worker，保留失败记录。`a02` 使用 4 个 OMP／MKL 线程完成；包装器也已补上相同的缺省值，用户显式设置仍优先。没有停止正式服务或其他作业。

### 浏览器验收

将真实生成 GLB 和运行记录复制到仓库外 `/tmp/roomcanvas-trellis-preview/`，通过临时 API `127.0.0.1:17862` 与网页服务 `127.0.0.1:17880` 验证。没有用合成模型替代这次浏览器验收的重建结果。

- 模型与坐标轴在尺寸预览中正常显示；补拍及推荐视角入口关闭。
- 按 X 轴标定宽度 **2 米**，得到深约 **0.819 米**、高约 **0.532 米**；这些来自模型比例，不代表实物比例准确。
- 原 office 布局没有得到有效落点；用网页“一键清空”后，成功导入、通过支撑／碰撞检查并确认摆放。这里没有验证所有家具拥挤摆放情况。
- 旧“导入物体随光照变化”开关未勾选时，实际导入材质仍是 `MeshStandardMaterial`，源 PBR 保留，没有退回 Basic／顶点色显示。
- 对同一物体单独采样，开灯／环境时中心区域平均 RGB 约 **162.11**，关灯并移除环境时为 **0**。这是受光路径验证，不是材质物理准确性或“比旧模型更真实”的证明。
- 浏览器无页面异常。截图和报告位于 `/tmp/roomcanvas-trellis-preview/browser/`：`dimensions.png`、`placed.png`、`lit.png`、`dark.png`、`report.json`。临时目录不是长期存档，结果和私人截图不加入 Git。

最初沙发试跑确认两个入口能够复用同一份 TRELLIS.2 推理代码与权重，并接入独立物体的标定和摆放；当时尚未比较同物体的旧结果。后续已有 [历史结果对照](OBJECT_RECONSTRUCTION_COMPARISON.md)，仍未测量几何真值误差、材质真值或重复运行稳定性。本次未合并、提交、推送或更新正式后端。

### 当前可试用的隔离入口

完成上述本机验证后，启动了服务器隔离测试 API，供继续上传照片；本机网页已从临时本地 API 改为通过独立 SSH 隧道连接 GPU 测试后端。

| 项目 | 当前设置 |
| --- | --- |
| 网页 | <http://127.0.0.1:17880/web/editor/?room=office>，可用“导入物体”选择 `sofa_trial` 或“添加物体”上传新照片 |
| 网页代理 | `python3 web/scripts/serve.py --port 17880 --viewforge http://127.0.0.1:17865` |
| SSH | `gynserver` 的现有主连接新增 `127.0.0.1:17865 → 远端 127.0.0.1:17863`；原有 7865 映射保留 |
| 测试 API | 服务器 `127.0.0.1:17863`，进程 70043；日志在实验目录 `api.log` |
| 数据 | 实验目录下 `viewforge/`；`envs`、`weights`、`third_party` 链接到既有只读推理资源，输入／cache／logs／runs 独立 |
| 沙发试跑结束时的状态 | 正式 checkout 为干净的 main；正式 7862 `/health` 为 200；当时两卡均恢复空闲。后续独立物体批次的资源状态见下文 |

这些临时进程和 SSH 映射不会在电脑／容器重启后自动恢复。停止测试时只停止上述实验 API 和本机 17880 预览进程，并可用 `ssh -O cancel -L 127.0.0.1:17865:127.0.0.1:17863 gynserver` 移除测试映射；保留模型、运行记录和正式连接。关闭前先确认测试 API 没有新提交的重建任务。

### 更多独立物体：四次单图验证

2026-10-27 先按用户要求完成 CPU 输入检查并停止；用户通知有一张卡空闲后，重新检查发现空闲的是 **GPU 1**（`GPU-d11de16f-4152-ddf4-5114-1a44c295f40f`），约 24 GB 可用。随后只在这张卡上顺序运行四次独立重建，继续使用 ViewForge 共享锁和场景侧对应 GPU 锁。GPU 0 上的其他作业没有停止或改动。

以下是三类物体、四次独立单图测试，**没有融合四张照片**，也未把场景资产渲染计作新增物体样本。每次使用复制到隔离数据根目录的原照片及既有确认蒙版，照片／蒙版尺寸、非空 RGBA 与二值 alpha 检查均通过，原始输入指纹保存在 `plan.json`。本轮验证从确认后的输入开始，没有重新执行上传或 BiRefNet 抠图。

配置均为 seed 42、`1024_cascade`、2048 贴图、50,000 面目标。每个任务都重新加载模型；下表总耗时包含加载、生成及导出，不是常驻服务吞吐量或峰值显存基准。

| 样本／label | 来源 | 总耗时 | 三角面 | 重建／网页验收 |
| --- | --- | --- | --- | --- |
| 毛绒玩具正面 `plush_front` | `stuffed_toy/images/1.png` | 283.308 秒 | 47,020 | 通过 |
| 同一玩具另一角度 `plush_second_view` | `stuffed_toy/images/2.png` | 296.998 秒 | 47,675 | 通过 |
| GT3 玩具车 `gt3` | `GT3玩具车_001.png` | 254.109 秒 | 46,907 | 通过 |
| Cody 手办 `cody` | `Cody/images/IMG_6147.jpg` | 253.025 秒 | 48,235 | 通过 |

四份结果均通过以下检查：

- GLB 2.0 头、非空有限网格、有效 UV 和正尺寸。每份有 1 个 mesh、1 个 PBR 材质、基础色与 metallic／roughness 贴图，未输出法线贴图。
- 使用真实结果通过网页尺寸预览、保存标定、一键清空后的房间摆放。GT3 用 X 轴 0.3 米，其余用 Z 轴 0.3 米；这些只是流程测试值，**不是实物测量**。缩放导出的尺寸正确，几何、材质和贴图的原始二进制数据保持一致。
- 导入材质保持 `MeshStandardMaterial`／`pbr`，无需补算法线；旧受光开关关闭时仍保留 PBR。没有 Gaussian，补拍与 COVER 入口关闭，四次浏览器检查均无页面异常。
- 独立受光探针中，开灯时物体中心区域平均 RGB 分别约 39.90、37.82、9.70、23.65，关灯并移除环境后均为 0。该检查证明受光路径有效，不证明物理材质准确，也不能据此比较不同物体的材质优劣。
- 对照原输入和原生 glTF 的 +Z、+X、−Z、斜视渲染，确认有完整体积与可辨认主体。坐标方向不等于语义上的正面／背面，GT3 的车头朝 −Z。没有扫描真值或尺寸真值，未计算形状误差。

外观检查发现的限制：

| 样本 | 可用部分 | 仍需改进 |
| --- | --- | --- |
| 两组毛绒玩具 | 头、耳朵、红心、四肢及不可见侧均生成了立体形状 | 毛绒偏光滑／发亮；正面输入的背面出现条痕。换输入视角后头身及宽深比例变化，单轴标定不能修正这些比例差异 |
| GT3 | 车身、四轮、尾翼轮廓可辨认 | 车灯、玻璃及车牌小字细节简化，不能只看金属反光就判断还原准确 |
| Cody | 人物、服装、头顶叶片、四肢与底座可辨认 | 底座文字严重变形，手指、面部与小叶片细节简化；贴图增强本身不能保证修好已经变形的文字几何 |

**结论：独立物体入口复用场景侧 TRELLIS.2 的技术链路已在这四次额外测试中跑通。** PBR 保留和受光正常，但毛绒材质、文字和未见面仍有明显限制。随后已用同物体历史 MV-SAM3D 结果做了 [实际对照](OBJECT_RECONSTRUCTION_COMPARISON.md)：毛绒与沙发是同图单张对比，GT3／Cody 的图数不同；新流程没有全面胜出，保留默认后端。光影增强后续应分别验证粗糙度／金属度、法线或细表面结构、输入光照残留，而不是把“已有 PBR”视为足够真实。

结果与复现信息：

- 模型根目录：`/workspace/geyinuo/roomcanvas-trellis-20261027-_7w1rz47/viewforge/runs/`。运行名为 `20261027_eval_<label>_5a7bzwku_validation-a01`，label 见上表；原输入、正式结果与服务未改动。
- 服务器记录目录：`/workspace/geyinuo/roomcanvas-trellis-20261027-_7w1rz47/validation-20261027-5a7bzwku/`。实际执行的是 `run_authorized_gpu1.py`，原 `run_when_authorized.sh` 没有执行；批次已结束，没有后台排队重建。
- `plan.json` 记录实际 GPU 和成功状态；`artifact-audit.json` 检查 GLB；`calibration-audit.json` 检查真实缩放导出；`validation-summary.json` 汇总网页与人工外观检查。CPU 脚本自己的“待人工检查”状态不代表最终汇总未验收。
- 每份 `reconstruction/generation.json` 的包装器及共用启动器 SHA-256 与当前本地分支文件一致，确认没有误用旧结果或换成另一套模型。
- 本机对比图 `comparison.jpg`、单样本对比图、四方向渲染与网页报告在 `/tmp/roomcanvas-trellis-validation-20261027/`；临时结果、私人图片与模型均不加入 Git。
- 批次结束后 GPU 1 恢复约 24 GB 空闲，两把测试锁已释放，正式与隔离 `/health` 均为 200。本轮 CLI 使用 GPU 1；原隔离 API 仍沿用上次的 GPU 0 配置，未重启或切卡。网页可以读取和导入这些已完成结果，新增 GPU 任务需重新检查空闲卡。
