# 单独物品重建流水线

本文面向维护物品服务与编辑器导入功能的开发者。拍照、标定和服务接口见[物品重建与补拍](OBJECT_RECONSTRUCTION.md)。环境和命令行重建见[运行说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md)。

## 输入与重建

1. 网页可选择 1–40 张照片。HEIC / HEIF 在浏览器本地转成 JPEG。服务接收 JPEG / PNG，也能识别 HDR JPEG 中的 MPO 主图。
2. 服务在 `$VIEWFORGE_ROOT/data/inputs/<物品>/` 保留收到的原文件（含 MPO 辅助图）。重建只取主图，按 EXIF 校正方向并保存 RGB PNG。辅助图不占用拍摄视角。
3. BiRefNet 生成与照片同尺寸的 RGBA 蒙版。用户确认保留的照片后，重建校验照片与蒙版签名。已有的有效蒙版可以复用，全部命中时只进行 CPU 检查。
4. 重建作业取得共享 GPU 锁后检查可用显存，在独立运行目录执行 DA3 和 MV-SAM3D。DA3 估计深度、相机与 pointmap。
5. MV-SAM3D 用原照片和几何条件生成 mesh 和 Gaussian。默认 seed 为 42，两阶段分别运行 50 / 25 步，使用 entropy 加权。配置中的 `mv` 参数直接传给上游。
6. 将 Gaussian 外观烘焙为 UV 颜色贴图，输出网格和 Gaussian PLY。正式模型发布后，COVER 计算下一次补拍方向。
7. 用户量出 X / Y / Z 对应的任一条边即可完成米制标定。补拍在新目录完整重跑，保留先前照片的顺序和首张锚点。房间中的原实例沿用原模型与标定。

## 颜色烘焙

[默认配置](../object-reconstruction/configs/default.yaml)如下。

```yaml
mesh_export:
  mode: baked_pbr
  texture_size: 2048
  roughness: 1.0
  metallic: 0.0
  texture_padding: nearest
```

[烘焙适配器](../object-reconstruction/scripts/mvsam_pbr.py)关闭 mesh 后处理以保留几何。它调用 gsplat 的非 packed 渲染路径生成虚拟视角，展开 UV 并优化颜色贴图。填充仅作用于未覆盖的 UV 缝隙，缓存按源几何哈希校验。

烘焙颜色来自 Gaussian decoder，旧版顶点色来自 mesh decoder。材质统一使用粗糙度 1、金属度 0，颜色可能保留生成或拍摄时的明暗，无法据此推断分区材质属性。

默认模式缺少依赖或烘焙失败时，重建作业失败。需对照旧流程时可显式配置 `mode: vertex_color`，该模式无烘焙依赖。

## 输出与显示契约

以下路径相对于本次运行目录。

| 文件 | 含义 |
| --- | --- |
| `result.json`、`config.yaml`、`inputs.json` | 状态、耗时、实际参数、源照片和代码版本记录 |
| `asset.json` | 已发布模型的文件清单、坐标变换、材质能力 |
| `reconstruction/result.glb` | 完整几何。默认 PBR 模型含 2048² 颜色贴图 |
| `reconstruction/result.ply` | 供显示与 COVER 使用的 Gaussian |
| `reconstruction/materials.json` | 烘焙状态、方法、纹理大小和耗时。成功后资产接口标记 `material_mode=pbr` |
| `reconstruction/vertex-color.glb` | 同次运行的原几何对照，用于检查形状 |
| `reconstruction/baking-*` | 本次 Gaussian、mesh 及经校验的 UV 缓存 |
| `reconstruction/collision.glb`、`reconstruction/collision-glb.json` | 可选的无材质碰撞模型及生成报告 |
| `cover/preview.json` | 显示坐标与补拍方向。可在发布后补充建议 |

### 模型何时可导入

| `result.json` 标志 | 读取含义 |
| --- | --- |
| `mesh_ready` | 重建步骤结束，GLB 与 PLY 已写出且非空。继续等待发布校验。 |
| `asset_ready` | 发布成功。目录与尺寸接口允许读取模型或标定。 |
| `recommendation_ready` | COVER 已成功生成建议。建议可以稍于模型就绪。 |

发布点是 `asset.json` 的原子写入。服务先校验 GLB、Gaussian、材质能力与显示坐标，再公开模型。COVER 随后只更新建议、状态与消息。补拍失败也可继续使用先前发布的模型。[发布与旧结果读取](../object-reconstruction/scripts/asset_state.py)

### 显示、碰撞与兼容

- 烘焙 PBR 始终用完整 GLB 预览与显示，避免轻量生成器把贴图转回顶点色。编辑器补齐缺失法线，保留贴图，模型响应光照并接收阴影。旧版顶点色可切换受光。
- 碰撞与支撑检测优先取 `collision.glb`。简化按连通部件进行，核对拓扑、包围盒与双向表面误差。超出容差则沿用该部件的原几何。
- 生成碰撞模型失败时，完整模型仍可发布。导入端找不到可用代理时，依次尝试 `preview.glb`、完整模型。[代理生成](../object-reconstruction/scripts/collision_proxy.py) · [编辑器导入](../web/editor/object-import.mjs)
- 旧结果尚无新版发布标记时，以完整 GLB 为读取条件，包括历史 `status=complete` 结果和无状态文件的旧导入模型。

以下测试从 `object-reconstruction/` 运行，使用 Open3D 验证薄腿、孔洞和桌面支撑。

```bash
python -m unittest discover -s tests -p test_collision_proxy.py
```

### DA3 数组与兼容

NPZ schema 2 只存一份 NHWC 的 `float32` pointmap。坐标轴沿 OpenCV 的右、下、前。MV-SAM3D 用转置视图读取 NCHW。读取器也接受旧的双布局或仅有 NCHW 的文件。[DA3 读取器](../object-reconstruction/scripts/da3_arrays.py)

COVER、场景合并和姿态优化继续按需读取 `depth`、`extrinsics`、`intrinsics`、`image_files`。在模块目录运行下列 CPU 基准，可用已有 NPZ 比较两种数组的峰值内存、字节数、读写时间和误差。

```bash
python scripts/benchmark_da3_arrays.py --input-npz '<已有 DA3 NPZ 路径>'
```

单独物品的单图／多图 TRELLIS、分区材质试验决策见[历史交接记录](history/PROJECT_HANDOFF_2026-11-03.md)。房间流水线使用 TRELLIS 的场景见[房间重建](ROOM_RECONSTRUCTION.md)。
