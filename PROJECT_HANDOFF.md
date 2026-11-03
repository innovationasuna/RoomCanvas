# 项目交接

更新：2026-11-03。当前工作分支 `feat/objects-trellis`。独立物体重建的既定方向是 **MV-SAM3D 几何 + 颜色烘焙 + 场景受光**；TRELLIS 单图保留为可选后端，多图 TRELLIS 已停止接受新任务。

## 本轮源码更新

- 已抓取 GitHub 最新引用，将 `origin/main` **`b50b622`** 合入当前分支，合并提交 **`b2d42b9`**；远程功能分支仍为 `75998bb`，本轮没有推送。
- 主分支新增扫描上传／房间重建工作流、新版网页工作区、一键服务器安装和 `serve.py --ssh`。保留本分支的 TRELLIS 可选入口、GPU 双锁、原生 PBR 材质、尺寸标定和结果兼容逻辑。
- 恢复了更新前尚未提交的 MV 烘焙、历史多图兼容、材质实验脚本与文档。它们仍未提交，不要用 `reset --hard` 清理。具体实现见 [物体流程](docs/OBJECT_RECONSTRUCTION_PIPELINE.md)、[MV 烘焙实验](docs/OBJECT_MVSAM_PBR_EXPERIMENT.md)。沿用上游对旧交接／重构历史文档的删除，交接以本文件为准。

## 已完成的图像归档与材质实验

- 本机图像：`object-reconstruction/visualization/重建效果对比/`，共 **24 张**完整对比图（17 张历史恢复、7 张本轮新增）。部分历史图恢复的是对话完整展示尺寸，不能承诺原临时文件的最高分辨率。来源、哈希和清单在 `00_来源记录/`。
- 本机实验：`object-reconstruction/visualization/material-region-trial-20261103/`，含输入、12 个派生 GLB、属性贴图、渲染报告和 `validation.json`；这些都是 Git 忽略的私人产物，不要提交。
- 服务器成功实验：`gynserver:/workspace/geyinuo/roomcanvas-material-regions-20261103-t5o3mmpw-a04/`。固定 MV 几何与 UV，复用已有 TRELLIS.2 材质入口；玩偶粗糙度接近 1，沙发约 0.82，二者金属度均为 0，空间变化很小，**未验证出明显的逐部位属性改善**。
- 自动推理／导出额外耗时分别约 18.7 秒、54.9 秒，共同加载约 31.4 秒，成功批次共约 128.6 秒；不包含此前 MV 重建和颜色烘焙。该入口不预测法线，织纹法线仅为程序化示意；改基础色的方案另设对照。
- 12 个派生 GLB 保留几何、UV、节点和原始二进制前缀；10 个属性方案保留原颜色。18 组浏览器渲染检查通过，同一物体所有方案的灰模 PNG 哈希一致。原始实验结论见 [MV 烘焙实验末节](docs/OBJECT_MVSAM_PBR_EXPERIMENT.md#2026-11-03-分区属性首轮尝试)。

## 当前功能与部署边界

| 项目 | 已核对的状态 |
| --- | --- |
| 默认后端 | `mvsam3d`；`mesh_export.mode` **仍为 `vertex_color`**，用户选择的烘焙主线尚未切换为默认 |
| 可选颜色烘焙 | `baked_pbr`，纹理 2048；固定 `roughness=1`、`metallic=0`；不自动估计材质属性或去光照 |
| 场景受光 | 顶点色结果可打开旧受光开关；标记 `material_mode=pbr` 的烘焙／TRELLIS 资产保留材质并直接受光，旧开关关闭时也保留 |
| TRELLIS | 单图取确认后保留的首张；不提供 Gaussian 或补拍。`trellis_multi` 只兼容历史结果读取 |
| GPU 调度 | 一次只用一张空闲卡；TRELLIS 同时协调物体全局锁与场景侧每卡锁，取锁后再检查显存 |
| 服务状态 | 本次只读检查服务器回环端口 7862、7866 均未监听；未启动／重启正式服务，未修改模型权重和正式推理环境 |

服务器项目目录 `/workspace/geyinuo/RoomCanvas`；MV 运行目录 `runtime/object-reconstruction/`，TRELLIS Python 为 `runtime/trellis-env/bin/python`。正式启动前核对本机 `serve.py --ssh` 的目标地址与服务器监听位置，按 [部署说明](docs/OBJECT_RECONSTRUCTION.md#部署) 操作，不直接照抄历史隧道端口。

## 同步与恢复

本轮先暂停 Mutagen，备份两端源码和 Git 历史，再逐文件核对 **27 组冲突**。服务器冲突版本均来自其已提交的 `main`；服务器的两项未提交烘焙配置／脚本改动与本机一致，已保留。不要将两份分歧的 Git 检出直接交给双向同步处理。

同步已恢复：`roomcanvas-gynserver`，新 ID `sync_lIVJmi7qlcc48iyeTnDGnQKtwnKvmkfCwMZwlvG76E6`。端点为本机项目 ↔ `gynserver:/workspace/geyinuo/RoomCanvas`，`two-way-safe`、忽略 VCS、Docker 规则、Zstandard；双方连接正常，状态 `Watching for changes`，**0 冲突、0 同步问题**。验收时约 903 个文件、46.7 MB、1 个软链接。

用户已批准重建会话，仅新增 `/object-reconstruction/visualization/` 排除；其余 94 条规则保留。运行环境、数据、样本、模型与凭据继续排除。已有被同步过去的图片副本没有删除。另补 `.gitignore` 以保证手势本地开发日志不进 Git。

服务器 `main` 已通过本地 Git bundle 快进到 `b50b622`（`bundle/main`）；其工作区叠加与本机一致的 TRELLIS／烘焙源码，**不等于服务器 Git 已切换到功能分支**。两端源码一致不要求分支相同；服务器不能在未保存工作区的情况下直接拉取。服务器更新前 stash 引用保存在备份 `server-update-stash-ref.txt`。

本轮备份在本机仓库外：

```text
/Users/lyk/.codex/visualizations/2026/10/26/01a1789d-bfdb-7b23-80cd-3c4991cce4b5/roomcanvas-sync-update-20261103-x2equtyr/
```

含两端源码快照、逐文件哈希、工作区补丁、Git bundle、更新前 Mutagen 配置和 stash 引用。服务器备份在 `/workspace/geyinuo/roomcanvas-sync-backup-20261103-uefl1mc5/`。本机更新前 stash 仍保留，引用见备份 `local-stash-ref.txt`；未删除现有图片、模型或服务数据。

后续 Git 更新前先暂停 `roomcanvas-gynserver`，各自核对 Git 状态、保留未提交工作，整合两端源码后再恢复；VCS 不参与 Mutagen，同步文件不会自动更新另一端 Git 的提交和分支。

## 验证与下一步

本轮验证：网页 Node **254 项**、扫描上传 Node **2 项**、网页 Python **29 项**、物体后端 CPU **73 项**、手势 **102 项**测试通过；手势类型、资源和两种构建通过，嵌入包无额外差异；房间模块 Ruff 通过，服务器 CPU 测试 **795 通过、2 跳过**；room3 实物模型检查 **23/23** 通过。

Chrome 实际导入／摆放、缺失法线补算、受光切换与原显示回退通过；新版首页／编辑器已截图检查，无页面脚本异常，摄像头默认没有开启。旧浏览器验收脚本已适配新版“环境”面板及完整工具模式。截图和报告位于本轮备份 `browser-import/`、`browser-ui.json`。

网页回环测试需绕过本机 HTTP 代理：`NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost python3 -m unittest discover -s web/scripts`。本机房间全套依赖不齐；服务器原测试环境未安装项目，MCP 子进程也不继承 `PYTHONPATH`，因此用临时独立环境引用现有依赖与 `src` 完成全套验证，结束后已删除临时环境。报告为备份中的 `server-snapshot/room-tests-isolated.log`；本轮没有重新进行 GPU 重建或真人手势验收。

1. 先审阅并提交目前未提交的烘焙、材质实验与文档，再决定是否推送功能分支；本轮未推送。
2. 若要将烘焙设为默认，先确认正式 MV 环境具备已验证的烘焙依赖，再单独切换配置并验收实际新任务与前端受光。本次没有执行该切换。
3. 分区属性暂保留为实验。后续优先选已知裸露金属／塑料／布料的混合样本，以固定几何、颜色、相机和光源验证真实收益；法线估计和颜色去光照另行测试，不将贴图存在等同于材质准确。
