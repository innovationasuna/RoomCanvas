# 单独物体重建流水线

独立物体使用 **BiRefNet → DA3 → MV-SAM3D → 颜色烘焙 → COVER → 实测标定与摆放**。一张照片即可运行，也支持多角度照片和补拍。服务部署与接口见 [物体重建](OBJECT_RECONSTRUCTION.md)，环境配置见 [运行说明](../object-reconstruction/docs/VIEWFORGE_RUNTIME.md)。

## 输入与重建

1. 网页上传 1–40 张 JPEG / PNG，以独立物体名存入 `$VIEWFORGE_ROOT/data/inputs/`。
2. BiRefNet 生成同尺寸 RGBA 蒙版，用户确认保留哪些照片；重建绑定已确认的照片与蒙版签名。
3. 作业等待 GPU 锁，取得锁后检查可用显存。每次运行创建新目录，不覆盖已有结果。
4. DA3 估计照片深度、相机与 pointmap。MV-SAM3D 使用这些几何条件和原照片生成 mesh 与 Gaussian；默认 seed 42、50 / 25 步和 entropy 加权，算法参数直接交给上游。
5. 原生 Gaussian 颜色烘焙导出带 UV 贴图的 `result.glb`；同次生成 `result.ply`，供 Gaussian 展示与 COVER 使用。
6. COVER 计算下一次补拍方向并保存 `cover/preview.json`。补拍保留原照片、顺序与首张锚点，在新目录完整重跑。
7. 用户填写 X / Y / Z 任一边长，标定到米制尺寸，再在浏览器中摆放。

## 颜色烘焙

配置位于 [`configs/default.yaml`](../object-reconstruction/configs/default.yaml)：

```yaml
mesh_export:
  mode: baked_pbr
  texture_size: 2048
  roughness: 1.0
  metallic: 0.0
  texture_padding: nearest
```

[`mvsam_pbr.py`](../object-reconstruction/scripts/mvsam_pbr.py) 适配上游导出：关闭 mesh 后处理，保留相同几何；通过现有 gsplat 非 packed 渲染路径生成虚拟观察，UV 展开后优化颜色贴图。只填充未覆盖的 UV 缝隙，不改动已有 texel。UV 缓存按源几何哈希校验，避免误用其他网格。

颜色来自 Gaussian decoder，旧顶点色来自 mesh decoder，因此烘焙不仅是颜色的存储格式变化。固定粗糙度／金属度不代表恢复了真实材料属性，基础色也可能保留生成或拍摄光照。

缺少依赖或烘焙失败会使作业失败，不静默回退到顶点色。显式 `mode: vertex_color` 可用于已有流程或排查；它不要求烘焙依赖。

## 输出与显示契约

| 产物 | 含义 |
| --- | --- |
| `result.json`、`config.yaml`、`inputs.json` | 运行状态、耗时、参数、源照片与代码版本 |
| `reconstruction/result.glb` | 完整几何及 2048² 颜色贴图，PBR 粗糙度 1、金属度 0 |
| `reconstruction/result.ply` | Gaussian，保留补拍与 Gaussian 展示能力 |
| `reconstruction/materials.json` | 烘焙状态、方法、纹理大小、耗时；成功后资产接口才标记 `material_mode=pbr` |
| `reconstruction/vertex-color.glb` | 同次原始几何对照，用于确认烘焙没有改变物体形状 |
| `reconstruction/baking-*` | 本次 Gaussian、mesh 与已校验 UV 缓存，供故障排查 |
| `cover/preview.json` | 模型坐标转换、尺寸预览与 COVER 补拍方向 |

旧的轻量 GLB 生成器会把贴图转回顶点色，所以烘焙结果使用完整 GLB 作为预览。尺寸预览与场景导入保留原 PBR 颜色贴图，补齐缺失法线，响应场景灯光并接收阴影；标记为烘焙 PBR 的资产不受旧版顶点色对照开关影响。

单独物体的 TRELLIS、TRELLIS 多图融合与分区材质尝试已清理。房间重建在 `room-reconstruction/` 内使用自己的 TRELLIS 流程，见 [房间重建](ROOM_RECONSTRUCTION.md)。
