# 物品重建服务（ViewForge）

<a id="物体重建viewforge"></a>

用一张或多张照片生成带纹理的三维模型，输入任一条实测边长，就能按真实尺寸放进房间。服务为网页编辑器的“添加物品”和“从已生成的模型添加”提供 API。

1. **准备照片。** 网页支持 JPEG、PNG、HEIC 和 HEIF。BiRefNet 自动抠图，已有且有效的蒙版可直接复用。
2. **生成模型。** DA3 估计深度，MV-SAM3D 融合视角，输出带颜色贴图的 GLB 与 Gaussian。需要 GPU 的作业通过共享锁排队。
3. **补拍和摆放。** 可按橙色箭头补拍，也可直接标定尺寸并放入房间。

<a id="文档"></a>

| 我想做什么 | 入口 |
| --- | --- |
| 拍照、补拍或调用接口 | [物品重建与补拍](../docs/OBJECT_RECONSTRUCTION.md) |
| 安装服务、连通网页 | [服务器部署与运维](../docs/SERVER_DEPLOYMENT.md) |
| 配置环境、从命令行重建或抠图 | [运行说明](docs/VIEWFORGE_RUNTIME.md) |
| <a id="资产与数值契约"></a>理解颜色烘焙、模型发布、碰撞与数值格式 | [颜色烘焙](../docs/OBJECT_RECONSTRUCTION_PIPELINE.md#颜色烘焙) · [输出与显示契约](../docs/OBJECT_RECONSTRUCTION_PIPELINE.md#输出与显示契约) |
| 查看补拍方向的计算与输出 | [COVER 补拍引导](docs/COVER.md) |
| 找到源码、运行目录或示例照片 | [目录结构](docs/DIRECTORY_LAYOUT.md) |

早期 Gradio 页面和 Babylon 查看器见[归档说明](legacy/README.md)。许可见 [LICENSE](LICENSE)。
