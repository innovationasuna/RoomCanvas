# 物体重建（ViewForge）

RoomCanvas 的物体重建服务：用几张照片重建出带纹理的三维模型，按一条实测边长标定到真实尺寸，再放进房间。服务以无界面 API 的形式提供给网页编辑器的“添加物品”和“从已生成的模型添加”。

```text
照片 → BiRefNet 抠图 → DA3 深度 + MV-SAM3D 多视角重建 → COVER 补拍建议 → 实测尺寸标定 → 放进房间
```

- **自动抠图**：BiRefNet 逐张生成前景蒙版，已有的蒙版直接复用。
- **多视角重建**：融合多张照片的几何与纹理，输出 GLB 网格和 Gaussian；1 张照片也能重建。
- **补拍引导**：计算下一张照片的最佳拍摄方向，补拍后在原结果基础上重建。
- **真实尺寸**：填一条实测边长即可把模型标定到米制。
- **GPU 排队**：所有作业通过共享 GPU 锁排队，一次使用一张卡。

照片导入接受 JPEG 和 PNG，也兼容被图片库识别为 MPO 的 HDR JPEG（`.jpg` / `.jpeg`）。
重建使用主图，按 EXIF 校正方向后保存为 RGB PNG；原文件及其 HDR 辅助图完整保留，不将辅助图作为额外拍摄视角。

## 资产与数值契约

`result.json` 分别记录 `mesh_ready`（重建产物完整）、`asset_ready`（正式资产发布完成）和
`recommendation_ready`（COVER 建议可用）。`asset.json` 的原子写入是发布点：完整 GLB、Gaussian、
材质能力和显示坐标验证成功后，catalog 与尺寸接口才允许导入或标定。COVER 后续完成或失败只更新建议，
不会改动已经发布的坐标、材质能力和标定。历史 `status=complete` 结果以及无状态文件的旧导入模型继续可读。
补拍仍创建新 run，已放进房间的旧实例保留原契约。

默认 PBR 重建保留完整 `result.glb` 用于显示，另生成无材质 `collision.glb` 用于碰撞和支撑检测。
代理逐连通部件简化，检查拓扑、包围盒与双向表面误差；检查不通过的部件保留原几何。
报告保存在 `reconstruction/collision-glb.json`。历史无代理结果依次回退到 `preview.glb` 和完整模型。
可用 `python -m unittest discover -s tests -p test_collision_proxy.py` 在带 Open3D 的重建环境验证薄腿、孔洞和桌面支撑。

DA3 NPZ schema 2 仅存一份 NHWC `float32` pointmap，坐标仍为 OpenCV 的右、下、前。
MV-SAM3D 使用转置视图读取，同时兼容历史双布局和仅 NCHW 的 NPZ；COVER、场景合并和姿态优化只读取
保留的 depth、extrinsics、intrinsics、image_files 字段。`scripts/benchmark_da3_arrays.py --input-npz <已有文件>`
可复现旧/新数组的峰值内存、字节数、读写时间和数值误差对照，无需加载模型或使用 GPU。

## 文档

| 文档 | 内容 |
| --- | --- |
| [物体重建](../docs/OBJECT_RECONSTRUCTION.md) | 服务部署、接口与在编辑器中的使用 |
| [运行说明](docs/VIEWFORGE_RUNTIME.md) | 环境配置、命令行重建与自动抠图 |
| [COVER 补拍引导](docs/COVER.md) | 补拍方向的计算与输出 |
| [目录结构](docs/DIRECTORY_LAYOUT.md) | 本模块的代码组织 |

早期的 Gradio 页面和 Babylon 查看器归档在 [`legacy/`](legacy/README.md)。

许可见 [LICENSE](LICENSE)。
