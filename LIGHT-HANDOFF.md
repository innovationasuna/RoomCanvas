# 光影增强交接

更新：2026-10-19。分支 `feat/static-ambient-occlusion`，HEAD `7b4377b`；本轮代码、文档和 vendor **均尚未提交／推送**。用户最后要求继续完成，此处记录完成后的状态。

## 当前结果

P0 基线工具、P1 通用校准与可回退导入 PBR 实验、P2 两种 AO 的首轮对照及原生阴影检查已实现并验证。目标是通用场景、低交互开销，保留原有半球光与两盏平行光的类型和位置，无逐房间补丁。**烘焙 GI 不在范围内**，未引入路径追踪或高成本 GI。

参数、测量及来源见 [光影调研](docs/LIGHTING_RESEARCH.md)，完整操作与验收命令见 [web/README](web/README.md#通用光影增强)。旧 [全仓库交接](docs/HANDOFF.md) 有历史服务信息；本轮没有核对或修改远程运行状态。

| 优先级 | 已实现 | 验证及边界 |
| --- | --- | --- |
| P0 | 可重放相机／布局／显隐、模型 SHA256、固定截图、整帧跨 pass 统计、CPU 提交及异步 GPU query | 两房间五档位；空闲 650 ms 无新帧；GPU 不可用／disjoint 不伪装成零耗时 |
| P1 光照 | 通用 original / initial / balanced 档，一次生成 128 面尺寸 PMREM | 对照后默认 balanced，深色钢琴和窗帘层次更易辨认；不是从照片恢复照明 |
| P1 材质 | “导入物体随光照变化（实验）”：保留已有 PBR、转换 unlit、补法线、受光阴影、原显示回退 | 合成顶点色 GLB 走真实导入／放置／开关流程；原模式开／关灯均 192，PBR 约 173.82 / 0，回退恢复 192 / 192 |
| P2 AO | 相同低分辨率、半径及合成的 GTAO / N8AO；停止 350 ms 后补算 | 没有观察到替换默认方案的稳定优势，继续默认 GTAO；移动暂停，松手后更新 |
| P2 阴影 | 2048² PCFSoft、边界拟合阴影相机、像素尺度偏移 | 原参数近景对照及移动／放置更新检查；透射玻璃、透明预览、碰撞代理排除 AO |

两个房间原有显示材质均是 PBR：room3 运行时 54 Standard + 4 Physical，office 74 Standard + 10 Physical；加载后均有几何法线。导入旧显示是 Basic，受光实验默认关闭，以免拍摄颜色再次受光变暗。摆放中切换会保留草稿并提示先结束摆放。

## 默认参数与入口

| URL 档位 | 半球 / 主光 / 补光 | 曝光 | 环境 |
| --- | --- | ---: | ---: |
| 默认或 `lighting=balanced` | 1.1 / 3.0 / 0.65 | 1.1 | 0.35 |
| `lighting=initial`（第一版增强） | 2.5 / 2.4 / 1.4 | 1.15 | 0.18 |
| `lighting=off`（完整原始） | 2.5 / 2.4 / 1.4 | 1.15 | 0 |

正常启动：`python3 web/scripts/serve.py` → `http://127.0.0.1:7880/web/`，无需额外后端或构建步骤。本轮临时 7881 在收尾停止，原有 7880 保留；请求队列修复需重启旧 serve.py 才生效。

- `ao=off` / `ao=n8ao`：关闭 AO / 对照 N8AO；默认 GTAO。
- `env=off`、`shadows=original`：分项对照；比较算法时使用相同 lighting 档。
- `materials=pbr`：预选导入受光实验，也可从更多工具切换。
- `lightingLab=1`：才开放 `roomLightingLab` 的状态重放、材质审查、镜头回放及 GPU 计时；正常页面无该测试接口。

## 关键代码与兼容

- `web/editor/scene-editor.js`：现有渲染／导入生命周期的接入、只读 roomEditor、显式 lab。
- `lighting-profiles.mjs`、`environment-lighting.mjs`、`lighting-settings.mjs`：档位、PMREM、原阴影校准。
- `static-lighting.mjs`、`settled-render.mjs`：有限静态 AO，半宽／半高、长边最多 960、混合 0.35；后台暂停，截图保留效果。
- `render-metrics.mjs`：在交互／静态 AO／截图各阶段外重置并汇总 renderer.info，修复原末个 pass 的 renderCalls=1 误导；CPU 提交不等于 GPU 或端到端帧耗。
- `import-materials.mjs`：原显示与受光版本独立，原材质／贴图不被修改；补法线克隆几何，碰撞代理不变；受光卡片沿用当前环境。
- `web/scripts/check_lighting.mjs`、`check_import_lighting.mjs`：可重放的浏览器验收，Playwright 只是开发依赖。
- `publish.py` 更新旧预览的 vendor；`serve.py` 请求队列增至 64，避免并行模块连接重置。编辑器缓存版本 app-38。

引擎保持 Three.js r180。N8AO 固定 1.10.2 / commit `6481f6b39f6ec0301b43648492833cdb8bcd99ac`，只取独立 Pass，移除未用 N8AOPostPass 入口并对齐 import map，不引入完整 postprocessing 框架。adapter 已补其空 dispose 的资源释放，关闭透明自动探测、时域累积和内部 gamma。源码与许可证／npm 标记差异见 [vendor 说明](web/vendor/n8ao/README.md)。

## 已跑验证与结果位置

- 前端 **166/166**；Python **12/12**；33 个 JS/MJS 模块语法通过。
- room3 **23/23**（9 条原模型提示）；office **18/18**（1 条原模型提示）。几何、布局与碰撞算法未改。
- 两房间五档位：1440×1000、DPR 1、实际画布 1414×704，Chrome 无头、ANGLE Metal / Apple M5、Three r180，手势摄像头未开。每档 60 次同轨迹镜头请求、5 次有限静态补算，另记加载到 settled 与首次初始化。
- 默认 GTAO 预热后静态补算：room3 CPU p50/p95 5.70/6.20 ms、GPU 12.16/14.06 ms；office CPU 13.90/16.10 ms、GPU 9.01/9.11 ms。CPU/GPU 可重叠，不能相加或推导稳定 FPS；这是单机短序列结果。
- 普通页面的默认档、无 lab 接口、暖光、空闲、家具移动、松手补算、取消通过；导入另验摆放草稿保留及切回原显示。

原始报告与私人截图均在仓库外，不加入 Git：

| 路径 | 内容 |
| --- | --- |
| `/tmp/roomcanvas-lighting-final/` | 五档位 report.json、模型指纹、固定状态、整体／近景截图 |
| `/tmp/roomcanvas-lighting-glass-check/` | 最后补充透射玻璃排除后的两种 AO 回归 |
| `/tmp/roomcanvas-lighting-shadow-check/` | 原阴影近景对照 |
| `/tmp/roomcanvas-import-lighting-final/` | 最终导入／受光／回退验收与像素响应 |

临时目录不是长期存档，需保留时复制到仓库外稳定目录。重跑命令见 web README；本机已有 Playwright 模块在 `/Users/lyk/.cache/uv/archive-v0/V2lEP-Ob1puP69RiKEEa-/playwright/driver/package`，Chrome 在 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。这是本机验收配置，不写入产品代码。

## 后续验收与限制

1. 用户截图的床面细小黑点未在固定镜头稳定复现；需保存同一视角进一步定位，不宣称所有伪影已消除。
2. 真人手势并行、更多设备及不同 DPR／大画布未量测；未测实际显存字节数，不能把纹理数量当显存大小。
3. 本轮只读查询 7865 隧道的物体目录为 0 项。合成实验验证路径生效；真实重建颜色的二次明暗和纹理／金属表面需要有资产后视觉验收，暂保留实验开关。
4. 共同规则已覆盖当前两个场景，不等于证明所有未来场景更真实。未做反照率分离；通用环境不是局部真实反射或 GI。
5. 后续提交前审阅整批未提交更改、vendor 来源与许可、生成物排除。本轮没有提交、推送、合并、发布或操作重建服务器任务。

常用检查：`node --test 'web/editor/tests/*.mjs'`、`python3 -m unittest discover -s web/scripts`，以及 `node web/scripts/check_room.mjs --scene-dir samples/room3` / `samples/office`。
