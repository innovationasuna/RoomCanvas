# ViewForge 补拍查看器

单物体 Babylon.js **8.2.0** 查看器（不含房间布局和手势接收端）；GLB、Gaussian 和补拍相机箭头共用右手场景。

GLB 采用渐进预览：有 `assets.glb_preview` 时先显示约 12,000 面的 `reconstruction/preview.glb`，随后后台加载原始 `result.glb`，就绪后在同一场景中替换。切换保留相机、补拍取景和箭头状态；完整模型失败时保留可操作的轻量预览并提供重试。缺少或无法加载轻量文件时直接加载完整模型。只读 state 的 `glbQuality` 为 `preview` / `full`，`assets.glb.status` 表示全量加载状态。构建为脚本和样式添加内容版本，避免浏览器沿用旧查看器。

新重建自动生成轻量文件；已有运行可以在服务器运行环境执行 `python scripts/preview_glb.py --run-dir <运行目录>`，再打开结果。轻量文件保留原场景坐标和顶点颜色，纹理网格在简化时转换为近似顶点颜色；最终显示仍为原始完整 GLB。

实际尺寸标定支持点击彩色三维轴或 X/Y/Z 按钮，输入该方向整体长度（mm/cm/m），保存后统一等比例缩放。用户坐标为右手 Z-up：X 对应显示 +X、Y 对应显示 -Z、Z 对应显示 +Y；模型的 glTF Y-up 坐标约定保持兼容。服务器从原始完整 GLB 的全部网格与节点变换计算包围尺寸，轻量切换不改变尺寸基准。`dimensions-base.json` 缓存基准，`dimensions.json` 保存单轴实测和三轴米制尺寸；每次编辑从原始基准计算，原模型变化后旧标定失效。

`/viewforge/dimensions/<run>` 提供读取与保存/清除接口。GLB、Gaussian、补拍箭头与测量框共享尺寸变换，当前相机和推荐取景同步换算，重新打开会恢复标定。下载实尺 GLB 时给原节点增加米制缩放父节点，保留原二进制几何/纹理；每个导出版本保存为独立 `reconstruction/scaled-<version>.glb`。此功能不改变重建或补拍评分算法。只读 state 的 `metricScale` 与 `dimensions` 可用于检查标定、轴选择和三维标签位置。

```sh
cd viewer
npm ci
npm run check
npm test
npm run build
```

构建生成 `scripts/assets/cover-viewer.html`、`.js`、`.css`、`-LICENSE` 和 `-build.json`。提交构建产物，服务端运行无需 Node 或 npm。JS 是包含固定版本 Babylon 的 IIFE bundle，没有外部模块或 Gradio 内部 chunk 依赖；Gaussian 排序使用 bundle 内代码创建的 Blob worker。

`babylon-ply-fix.mjs` 为固定的 8.2.0 加入窄范围兼容修复：原 PLY header 解析把未知字段（例如 `nx/ny/nz`）的枚举值 85 误判为三阶 SH，导致无 `f_rest_*` 的 SAM3D PLY 渲染出虚假的方向性黑白渐变。构建补丁只识别真实 SH 字段，同时纠正 24 个 SH 系数的二阶边界，保持最高已读阶数；不改变原 PLY、DC 颜色或几何。补丁必须精确匹配固定版本源码，否则构建报错。测试覆盖带 normals 的 DC-only PLY，以及 0/9/24/45 个 SH 系数。

HTML 支持查询参数 `manifest=<同源 JSON URL>&mode=glb|gaussian`。如果宿主把 HTML 作为下载附件，可读取构建 HTML 作为 iframe `srcdoc`，把两个 `./cover-viewer.*` 引用替换为同源绝对文件 URL，并在 bundle 前注入：

```js
window.__VIEWFORGE_VIEWER_CONFIG__ = {
  manifest: "/path/to/preview.json",
  mode: "glb",
  baseUrl: "http://127.0.0.1:7865/"
};
```

宿主通过 `iframe.contentWindow.postMessage({type: "viewforge-mode", mode: "Gaussian"}, location.origin)` 切换模式，兼容 `glb` / `gaussian` 和 `GLB 网格` / `Gaussian`。同一运行内不重建场景或重置相机。带 `manifestUrl` / `url` 可切换结果；相同 URL 需加 `reload: true` 才重新读取。也支持 `type: "viewforge-manifest"` 强制更新。只接收同源父窗口消息。

`window.__viewforgeViewer.state` 是只读快照，包含当前相机、显示模式、Gaussian 加载状态、原生变换、补拍位置/朝向、实际箭头可见性、Babylon 版本以及场景销毁计数。宿主可用于验收，不需要读取 Gradio 实现。

`assets.*.transform` 是原生资产到统一 display 空间的列主序仿射矩阵；推荐相机已经位于 display 空间。查看器不分别居中、缩放或推断物体轴向。Babylon 8.2.0 的 PLY 解码会额外反射 Z，`coordinates.ts` 在 Gaussian 子节点纠正，然后再应用 manifest 父变换；后端不应重复纠正。原始 `.splat` 文件则纠正该格式的 Y 反射。

箭头是可拾取的真实圆柱/圆锥网格，起点为推荐相机位置，沿目标方向伸出。它与模型处于渲染组 0，使用正常深度测试/写入；Gaussian 保留其透明度合成，所以透明区域的遮挡遵循 splat 的透明度。推荐取景时隐藏相机自身箭头，返回概览恢复此前相机和箭头偏好。

初始概览相对推荐方向绕物体 up 轴转 75°、略俯视，并以模型和箭头的共同包围球适配视野，避免唯一推荐初始被物体挡住。交互后仍使用真实遮挡。GLB 的纹理 PBR 材质以 unlit 模式显示已有 albedo，避免对已烘焙外观重复照明、放大三角面阴影；不更改模型或纹理文件。

GLB 支持本项目的内嵌纹理 glTF 2.0；不下载外部纹理、Draco、Meshopt 或 Basis 解码器。若输入依赖这些外部资源，会显示加载失败并在只读 state 中给出原因。Gaussian 数据仅首次选择该模式时读取；切换结果会销毁旧场景、纹理和排序 worker。
