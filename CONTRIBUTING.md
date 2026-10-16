# 参与开发

1. 从最新的 `main` 拉分支，一个功能一个分支：`feat/…`、`fix/…`、`docs/…`。挪文件、改文档跟着相关功能一起提交，不单独开 PR。
2. 提交前跑和 CI 一样的检查（只跑改到的部分即可）：
   ```bash
   # 网页（Node 24、Python 3，不用装依赖）
   node --test 'web/editor/tests/*.mjs'
   python3 -m unittest discover -s web/scripts
   node web/scripts/check_room.mjs --scene-dir samples/room3
   # 重建（在 reconstruction/ 下）
   uv run ruff check . && uv run pytest -n auto
   ```
   改了网页界面的，本地打开看一眼，见 [README](README.md#打开网页)。
3. 开 PR，写清改了什么、怎么验证的。CI 通过、仓库所有者确认后，squash 合并并删除分支。`main` 不能直接推送。

注意：

- `reconstruction/` 里的官方文件尽量少改，必须改的保持官方写法，并在 README 的“对 LiteReality-Agent 改了什么”里补一句。
- 扫描数据、照片、运行结果、模型权重、`.env` 不进仓库。`samples/` 是唯一的例外，规则见 README。
- 3090 上一个作业只用一张空闲 GPU，结果写到新目录，不覆盖旧结果。
