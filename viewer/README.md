# ViewForge 补拍查看器

独立 Babylon.js **8.2.0** 查看器；GLB、Gaussian 和补拍相机箭头共用右手场景。

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
