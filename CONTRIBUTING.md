# 参与开发

按任务查找指南和维护契约，见[文档总索引](docs/README.md)。Android SDK、构建和模拟器的配置见 [Android App 说明](android-app/README.md)。

## 流程

1. 从最新的 `main` 拉分支，一个功能一个分支：`feat/…`、`fix/…`、`docs/…`。移动文件、更新文档随相关功能一起提交，不单独开 PR。
2. 提交前运行与 CI 相同的检查（只需运行改动涉及的部分）：
   ```bash
   # 网页（Node 24、Python 3，不用装依赖）
   node --test 'web/editor/tests/*.mjs' 'web/scripts/test_*.mjs' 'web/mobile/tests/*.mjs'
   python3 -m unittest discover -s web/scripts
   python3 scripts/fetch_samples.py   # 示例房间的模型在 sample-rooms release，已有的不重复下载；私有仓库先 gh auth login
   node web/scripts/check_room.mjs --scene-dir samples/room3
   # 房间重建（在 room-reconstruction/ 下）
   uv run ruff check . && uv run pytest -n auto
   # 物体重建 API（在 object-reconstruction/ 下，CPU 即可，与 CI 同一组）
   for suite in api assets dimensions objects masks capture runner cover_scene mvsam_pbr da3_arrays collision_proxy reconstruction_quality; do python -m unittest discover -s tests -p "test_${suite}.py"; done
   # 手势（在 gesture/ 下）
   npm ci && npm run typecheck && npm test && npm run check:resources && npm run build
   # Android App（在 android-app/ 下，CI 不运行）：使用 JDK 21 构建，Java/Kotlin 源码目标为 17
   ./gradlew :app:testDebugUnitTest :app:assembleDebug
   ```
   改动网页界面时，在本地打开页面确认效果，见 [README](README.md#快速开始)。光照相关的浏览器检查见 [网页编辑器](web/README.md#测试)。
3. 开 PR，写清改了什么、怎么验证的。CI 通过、仓库所有者确认后 squash 合并并删除分支。`main` 不接受直接推送。

## 约定

- **重建核心**：`room-reconstruction/` 和 `object-reconstruction/` 的重建核心文件尽量保持稳定；必要的修改遵循所在模块原有的代码风格，并同步更新对应模块的说明。
- **不进仓库**：新的扫描数据、照片、运行结果、模型权重和 `.env`。现有的 `samples/`（物品清单和缩略图）以及手势模块随版本提供的识别模型和 WASM 资源保留，来源和规则见各模块 README。物体重建的示例照片 `object-reconstruction/data/example/` 不进仓库，是 `object-example-data` release 的附件，获取方式见 [目录结构](object-reconstruction/docs/DIRECTORY_LAYOUT.md)。示例房间的模型 `samples/*/Room.glb` 不进仓库，是 `sample-rooms` release 的附件，仓库里只有清单 `samples/models.json`；新增或更换模型见 [示例房间的模型](web/README.md#示例房间的模型)。
- **GPU 作业**：每个作业只使用一张空闲 GPU，通过共享的 GPU 锁排队；结果写到新目录，不覆盖已有结果。
- **手势识别包**：修改 `gesture/src` 中被打包的代码后，按 [web/vendor/gesture](web/vendor/gesture/README.md) 的说明重新构建 `web/vendor/gesture/` 并一起提交。

