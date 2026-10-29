# 物体重建（ViewForge）

RoomCanvas 的物体重建服务：用几张照片重建出带纹理的三维模型，按一条实测边长标定到真实尺寸，再放进房间。服务以无界面 API 的形式提供给网页编辑器的“添加物品”和“导入物品”。

```text
照片 → BiRefNet 抠图 → DA3 深度 + MV-SAM3D 多视角重建 → COVER 补拍建议 → 实测尺寸标定 → 放进房间
```

- **自动抠图**：BiRefNet 逐张生成前景蒙版，已有的蒙版直接复用。
- **多视角重建**：融合多张照片的几何与纹理，输出 GLB 网格和 Gaussian；1 张照片也能重建。
- **补拍引导**：计算下一张照片的最佳拍摄方向，补拍后在原结果基础上重建。
- **真实尺寸**：填一条实测边长即可把模型标定到米制。
- **GPU 排队**：所有作业通过共享 GPU 锁排队，一次使用一张卡。

## 文档

| 文档 | 内容 |
| --- | --- |
| [物体重建](../docs/OBJECT_RECONSTRUCTION.md) | 服务部署、接口与在编辑器中的使用 |
| [运行说明](docs/VIEWFORGE_RUNTIME.md) | 环境配置、命令行重建与自动抠图 |
| [COVER 补拍引导](docs/COVER.md) | 补拍方向的计算与输出 |
| [目录结构](docs/DIRECTORY_LAYOUT.md) | 本模块的代码组织 |

早期的 Gradio 页面和 Babylon 查看器归档在 [`legacy/`](legacy/README.md)。

许可见 [LICENSE](LICENSE)。
