# 参与开发

1. 从最新的 `main` 拉分支，一个功能一个分支：`feat/…`、`fix/…`、`docs/…`。挪文件、改文档跟着相关功能一起提交，不单独开 PR。
2. 提交前跑和 CI 一样的检查（只跑改到的部分即可）：
   ```bash
   # 网页（Node 24、Python 3，不用装依赖）
   node --test 'web/editor/tests/*.mjs'
   python3 -m unittest discover -s web/scripts
   node web/scripts/check_room.mjs --scene-dir samples/room3
   # 重建（在 room-reconstruction/ 下）
   uv run ruff check . && uv run pytest -n auto
   ```
   改了网页界面的，本地打开看一眼，见 [README](README.md#快速开始)。
3. 开 PR，写清改了什么、怎么验证的。CI 通过、仓库所有者确认后，squash 合并并删除分支。`main` 不能直接推送。

导入完整历史的 `feat/integrate-viewforge` 是例外：审阅通过后应使用普通 merge commit，保留 ViewForge 和手势提交的父链；不要 squash 或 rebase 合并此分支。其他功能沿用上面的流程。

注意：

- `room-reconstruction/` 里的官方文件尽量少改，必须改的保持官方写法，并在 README 的“对 LiteReality-Agent 改了什么”里补一句。
- 新的扫描数据、照片、运行结果、重建模型权重、`.env` 不进仓库。已有 `samples/`、ViewForge 原上游公开示例，以及手势工程随版本提供的识别模型/WASM 资源保留，来源与规则见各模块 README。
- 3090 上一个作业只用一张空闲 GPU，结果写到新目录，不覆盖旧结果。
