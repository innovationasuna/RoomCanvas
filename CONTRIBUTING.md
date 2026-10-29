# 参与开发

## 流程

1. 从最新的 `main` 拉分支，一个功能一个分支：`feat/…`、`fix/…`、`docs/…`。移动文件、更新文档随相关功能一起提交，不单独开 PR。
2. 提交前运行与 CI 相同的检查（只需运行改动涉及的部分）：
   ```bash
   # 网页（Node 24、Python 3，不用装依赖）
   node --test 'web/editor/tests/*.mjs'
   python3 -m unittest discover -s web/scripts
   node web/scripts/check_room.mjs --scene-dir samples/room3
   # 房间重建（在 room-reconstruction/ 下）
   uv run ruff check . && uv run pytest -n auto
   # 物体重建 API（在 object-reconstruction/ 下，CPU 即可，与 CI 同一组）
   for suite in api assets dimensions objects masks capture runner cover_scene; do python -m unittest discover -s tests -p "test_${suite}.py"; done
   # 手势（在 gesture/ 下）
   npm ci && npm run typecheck && npm test && npm run check:resources && npm run build
   # Android App（在 android-app/ 下，CI 不运行）
   ./gradlew :app:testDebugUnitTest :app:assembleDebug
   ```
   改动网页界面时，在本地打开页面确认效果，见 [README](README.md#快速开始)。光照相关的浏览器检查见 [网页编辑器](web/README.md#测试)。
3. 开 PR，写清改了什么、怎么验证的。CI 通过、仓库所有者确认后 squash 合并并删除分支。`main` 不接受直接推送。

## 约定

- **重建核心**：`room-reconstruction/` 和 `object-reconstruction/` 的重建核心文件尽量保持稳定；必要的修改遵循所在模块原有的代码风格，并同步更新对应模块的说明。
- **不进仓库**：新的扫描数据、照片、运行结果、模型权重和 `.env`。现有的 `samples/`、`object-reconstruction/data/example/` 示例照片，以及手势模块随版本提供的识别模型和 WASM 资源保留，来源和规则见各模块 README。
- **GPU 作业**：每个作业只使用一张空闲 GPU，通过共享的 GPU 锁排队；结果写到新目录，不覆盖已有结果。
- **示例数据**：`samples/room3` 是真实住宅扫描。仓库公开前，须先从 git 历史中移除它。
- **手势识别包**：修改 `gesture/src` 中被打包的代码后，按 [web/vendor/gesture](web/vendor/gesture/README.md) 的说明重新构建 `web/vendor/gesture/` 并一起提交。

