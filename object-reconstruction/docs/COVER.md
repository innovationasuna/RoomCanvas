# COVER 补拍引导

重建完成后，COVER 为当前模型计算下一张照片的最佳拍摄方向。网页编辑器在结果旁用橙色箭头显示这个方向，“补拍”上传新照片后在原结果基础上重建（见 [物体重建](../../docs/OBJECT_RECONSTRUCTION.md#补拍)）。

COVER 根据当前的重建结果和参与重建的照片计算覆盖评分；评分组件及其许可证在 `scripts/vendor/cover/`，引用见 [项目致谢](../../README.md#致谢)。

## 命令行

```bash
source configs/local.env
source scripts/env.sh
python scripts/run_cover.py --run-dir "$VIEWFORGE_ROOT/runs/<run-id>"
```

单次作业使用配置中的一张 GPU，自动取得与重建相同的 GPU 锁；加 `--wait-gpu` 可在 GPU 被占用时等待。由重建触发的 COVER 沿用重建已持有的锁，不需要额外参数。

## 方法

- 评分前先做已有照片的投影检查，用于发现坐标错误；检查失败时不会给出箭头。
- 候选方向为 24 个方位 × 3 个仰角（0°、20°、40°），排除与已拍方向相差小于 5° 和投影为空的方向。
- 按 128 个方向分箱，对各候选做投影、alpha 合成并对 `alpha > 0` 的像素取平均，选择得分最低（覆盖最少）的方向。

## 输出

- `cover/attempts/`：每次尝试单独保存；
- `cover/result.json`：方法版本、投影检查、候选分数与最佳候选；
- `cover/preview.json`：该结果的资产、坐标变换和推荐相机，网页据此显示箭头。

评分失败时模型照常可用，可以单独重试。

## 测试

- `scripts/check_cover_parity.py` 对比 NBV-Gym 的参考实现与本模块的结果。
- `tests/test_cover_core.py`、`test_cover_scene.py`、`test_capture.py` 覆盖公式、坐标、同名和错误上传、父子轮次及评分失败。
