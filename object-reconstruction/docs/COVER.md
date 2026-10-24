# COVER 补拍引导

当前补拍算法和命令行继续保留；旧 Gradio 界面已弃用，归档在 `legacy/`。RoomCanvas 的“添加物体”已接入补拍：结果一步画出推荐方向的箭头、可切到推荐视角，“补拍”上传新照片后按 `--parent-run` 重建（见 [物体重建](../../docs/OBJECT_RECONSTRUCTION.md)）。以下原网页步骤仅为历史记录。

保留 MV-SAM3D 的全量重建，使用 NBV-Gym `6e5e5ef48a59f369a821802842504668eac23325` 原版 COVER 为当前模型选择下一拍摄方向。代码与许可证在 `scripts/vendor/cover/`。不使用 Nerfstudio 训练循环，也不读取尚未加入本轮的照片。

## 原网页操作（已弃用）

1. 在历史结果中选中已有重建，点击“基于这次结果补拍”。
2. GLB 或 Gaussian 都显示同一个朝向物体的相机箭头；点击箭头查看推荐取景，“返回概览”恢复之前视角。
3. 上传 JPEG/PNG，点击“准备预览”，查看蒙版后点击“开始重建”。仅缺失的 mask 调用 BiRefNet。
4. 重建完成后自动计算 COVER 并更新预览。旧结果和原照片保留，每轮记录父运行和照片 ID。评分失败时模型仍可用，可以单独重试。

原始上传存入对象的 `originals/`，EXIF 转正副本进入 `images/`，映射保存在 `imports/`。运行的 `inputs.json` 记录顺序及父运行，运行输入以稳定序号复制，首图不变。

## 独立入口

在运行 checkout 中显式加载本机配置及环境：

```bash
source configs/local.env
source scripts/env.sh
python scripts/run_cover.py --run-dir "$VIEWFORGE_ROOT/runs/<run-id>"
```

单次作业使用配置中一张已授权 GPU，独立入口自动取得与重建相同的 GPU 锁。`--lock-held` 只供已持锁的运行器内部调用。

评分前执行已有照片投影检查。候选是 24 方位 × 3 仰角（0/20/40°），排除与已拍方向小于 5°以及空投影。保留原始 128 方向分箱、两个投影阶段的不同参数、alpha 合成和 `alpha > 0` 像素平均，选择最低分，不额外做 mask 加权或遮挡修正。

每次尝试单独保存到 `cover/attempts/`；`cover/result.json` 包含方法版本、投影检查、候选分数与最佳候选，`cover/preview.json` 包含该运行资产及坐标变换、推荐相机。检查失败不会产生占位箭头。

## 验证与限制

- `scripts/check_cover_parity.py` 独立对比原版与适配器；合成场景和实际模型均已运行。
- `tests/test_cover_core.py`、`test_cover_scene.py`、`test_capture.py` 覆盖公式、坐标、同名/错误上传、父子轮次及评分失败；旧界面回调测试保留在 `legacy/tests/`。
- 旧查看器源码与离线 bundle 归档在 `legacy/viewer/` 和 `legacy/scripts/assets/`，不再发布或由 API 服务加载。

COVER 是原版覆盖指标，不是重建误差或精度。投影轮廓检查只用于发现坐标错误。样例 4→5→6 闭环验证软件可运行；这些已有照片并非现场按推荐方向采集，不构成质量收益验证。
