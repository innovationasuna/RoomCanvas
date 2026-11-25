# 2026-11-19 的历史改写：新旧提交哈希对照

2026-11-19 仓库改写过一次 git 历史，把体积很大的示例文件从所有提交里移除：三个示例房间的模型 `samples/office/Room.glb`、`samples/room3/Room.glb`、`samples/room-3934/Room.glb`（含历史上的各个版本），以及物体重建的示例数据 `object-reconstruction/data/example/`。这些文件现在分别在 `sample-rooms` 和 `object-example-data` 两个 release 里，获取方式见 [网页说明](../../web/README.md#示例房间的模型) 和 [物体模块目录结构](../../object-reconstruction/docs/DIRECTORY_LAYOUT.md)。正常克隆的大小从 392 MB 降到约 59 MB。

改写后每个提交的作者、时间、说明和其余文件内容都没有变，但从第一次加入这些文件的提交开始，之后所有提交的哈希都变了。这份文档用来把旧哈希对到新提交上。

## 怎么查

- **在 PR 页面、旧文档或聊天记录里看到一个旧哈希**：在下面的表里找它，同一行就是新哈希。表里没有的（PR 合并前的中间提交）查 [commit-map-2026-11-19.txt](commit-map-2026-11-19.txt)，那里是全部 403 个提交的完整对应。
- **想让本地 git 直接认旧哈希**：仓库里推送了一组替换引用，拉取一次之后，`git show <旧哈希>`、`git log <旧哈希>` 会直接显示对应的新提交。

  ```bash
  git fetch origin 'refs/replace/*:refs/replace/*'
  git show c758383        # 显示改写后的同一个提交
  ```

- **PR 页面上显示的哈希不会变**。每个 PR 页面里“合并为 xxxxxxx”和提交列表仍是旧哈希，点进去看到的是 GitHub 保留的旧提交。
- **不要在旧 PR 页面上恢复分支**：那会把带大文件的旧历史放回仓库。需要旧 PR 里的改动时，从新历史上对应的提交取。

仓库里其他文档提到的旧哈希，凡是分支上的提交都已换成新哈希；重构文档（现存 [编辑器重构验证记录](EDITOR_REFACTOR_VALIDATION.md)）里提到的重构分支内部提交（PR #78 的中间提交）保持旧哈希不变，因为它们和 PR 页面上显示的一致。

映射文件第三列说明提交当时在哪里：`branch` 是分支上的提交，`pull-request` 是只存在于某个 PR 内部的提交（它们的改写版只能通过替换引用找到，不在任何分支上）。

## main（77 个提交，新的在上）

| 旧哈希 | 新哈希 | 日期 | 提交标题 |
| --- | --- | --- | --- |
| `386afac` | `9179937` | 2026-11-19 | chore(objects): keep the example data in a release, not in git (#82) |
| `ac87348` | `87c7d7f` | 2026-11-19 | chore(samples): keep room models in a release, not in git (#80) |
| `c758383` | `9941344` | 2026-11-19 | refactor: harden pipeline and editor reliability (#78) |
| `d8842f6` | `c9a807e` | 2026-11-18 | feat(replay): choose the playback speed (#75) |
| `d7f0be7` | `92135e1` | 2026-11-18 | fix(web): list a room copied into the samples once (#74) |
| `e226f3c` | `f71077a` | 2026-11-17 | feat(samples): add the reconstructed Room_3934 (#73) |
| `78fdaf7` | `8751682` | 2026-11-17 | fix(replay): restore forming effects and smooth the camera (#71) |
| `e790d8f` | `a53c03b` | 2026-11-17 | docs: refresh README with Room_3934 screenshots (#70) |
| `a1ac1c3` | `2e69157` | 2026-11-17 | Revise server deployment and development guidelines (#72) |
| `ac0c44e` | `fc91722` | 2026-11-16 | docs: define repository and server workflow guidelines (#69) |
| `b0ccbeb` | `78a98b0` | 2026-11-15 | feat(web): improve photo imports and reconstruction workspace (#68) |
| `12ccbca` | `e630c74` | 2026-11-13 | fix(replay): watch new reconstructions live on the lab server (#67) |
| `32b6b30` | `62e6f3a` | 2026-11-09 | feat(reconstruction): check the room once, pass or not, without a score (#66) |
| `a447d37` | `4aae5ec` | 2026-11-09 | feat(replay): play reconstructions at real pace and show them clearly (#65) |
| `334d7f4` | `463448f` | 2026-11-09 | feat(reconstruction): record replay timing in the trace (#64) |
| `60672a3` | `d4153da` | 2026-11-09 | feat(web): add room recycle bin and fix selection and grid z-fighting (#63) |
| `b01217f` | `07c9945` | 2026-11-09 | feat: replay forming effect, local room cache and .pcd uploads (#62) |
| `debe48e` | `a2681f4` | 2026-11-09 | feat(web): add physical lighting and hide near walls by default (#61) |
| `b4af56a` | `d577bd8` | 2026-11-08 | feat: default the GPU, build architecture, lock and time zone so only the API key needs filling (#59) |
| `834486a` | `694eafa` | 2026-11-08 | feat: preview mode without a GPU, and one command to view a cloud server (#60) |
| `7e334d3` | `2e1c6f0` | 2026-11-08 | feat: default MODEL_SOURCE to modelscope so no Hugging Face token is needed (#58) |
| `c0b9621` | `1147fca` | 2026-11-08 | docs: recommend MODEL_SOURCE=modelscope, no Hugging Face token needed for SAM 3D (#57) |
| `afaa7ac` | `4171241` | 2026-11-08 | fix: open the SSH tunnel on its own connection (#56) |
| `be74822` | `d59bd40` | 2026-11-08 | feat: slim replay registration, a gateway, and one-command server start (#55) |
| `3f72ff5` | `0150a29` | 2026-11-08 | feat: watch a room reconstruction live and replay it afterwards (#54) |
| `b704786` | `3df6ceb` | 2026-11-03 | feat: enable MV-SAM3D texture baking for standalone object reconstruction (#53) |
| `b50b622` | `abbd001` | 2026-11-03 | docs: rewrite docs, one-command server setup, serve.py --ssh, 物品 wording (#52) |
| `31b97cb` | `ca8f71f` | 2026-11-03 | feat: refresh room workspace and add scan reconstruction workflow (#51) |
| `0b00dc6` | `c602cec` | 2026-10-29 | docs: handoff — #49 merged, server synced, 7862 restarted, replay page sample, lyk's TRELLIS.2 branch (#50) |
| `a310d09` | `ac41633` | 2026-10-28 | ui: one word for room items in all visible text — editor, home page, gesture page (#49) |
| `e0be1a5` | `5459da6` | 2026-10-28 | docs: handoff — #41–#47 merged, server synced, 7862 restart pending (#48) |
| `84a7dba` | `c338e11` | 2026-10-27 | chore: remove dead code — old layout solvers and agent tool, unused constants, Android's unreachable activity, empty viewer/, MV_ROOT (#47) |
| `025d448` | `4ed72d4` | 2026-10-27 | docs: handoff — batch-1 bug fixes (#41–#45), refactor plan, PR titles in English (#46) |
| `e307cad` | `881c74f` | 2026-10-27 | web: one material-layer module; near walls no longer stick solid, carried pieces no longer stay faint (#45) |
| `1e8b5ba` | `481e172` | 2026-10-27 | gesture: turning the camera on keeps a mouse preview; orbit stays off while walking (#44) |
| `0e125fa` | `3c34eea` | 2026-10-27 | web: one version stamp at publish time; published previews ship the hand-tracking model (#43) |
| `62b2cf8` | `ff0071b` | 2026-10-27 | objects: check GPU memory under the lock, cap names at 53, skip the GPU wait for existing masks, 400 on a same-name race (#42) |
| `078a123` | `027ff36` | 2026-10-27 | room-reconstruction: --from resumes the right scene; LITEREALITY_BLENDER may name the binary (#41) |
| `deb869f` | `5afe101` | 2026-10-27 | 服务器目录收拢：RoomCanvas-Reconstruction 进 archive，ViewForge 运行目录并入 runtime (#40) |
| `038f568` | `cd59e40` | 2026-10-27 | Codex 会话默认上限改为 3600 秒；交接记录精修试验 (#38) |
| `dcc8edc` | `83a6d3e` | 2026-10-27 | docs: 交接和 README 更新到 2026-10-27 (#37) |
| `152eb12` | `31c8b27` | 2026-10-27 | web: 近侧墙 实心 / 半透明 / 隐藏 (#36) |
| `e207b99` | `7335289` | 2026-10-27 | web: 漫游 — first-person walk with the keyboard and mouse (#35) |
| `b88815f` | `ff42190` | 2026-10-25 | docs: handoff for 2026-10-25 — where to start, the articulation pass's next fixes (#34) |
| `9ae60cd` | `c0f3372` | 2026-10-25 | room-reconstruction: a full run does the articulation pass by default (#33) |
| `91e32f4` | `25cea21` | 2026-10-25 | room-reconstruction: an articulation pass — Astra decides per object what opens, Blender cuts it out and hinges it (#32) |
| `126eb28` | `6aa5aa3` | 2026-10-24 | web, objects: one photo is enough; the result shows where to shoot next, and 补拍 rebuilds on top of it (#31) |
| `f6447c2` | `d32e0d0` | 2026-10-24 | docs: a fuller README, handoff for #26–#29, a project-wide check; the import-lighting probe renders only the object (#30) |
| `7be1dc6` | `57dfee2` | 2026-10-24 | feat(android-app): Android 房间漫游 App (#29) |
| `493411b` | `3bbdb4d` | 2026-10-23 | gesture: 接入双手操作、场景缩放与竖拇指确认 (#26) |
| `0a6b4f7` | `3f08669` | 2026-10-23 | feat: time lighting grading (#28) |
| `ae1d020` | `2b4ac93` | 2026-10-23 | web: hide warehouse by default and remove pull handle (#27) |
| `6daeb80` | `ba883c1` | 2026-10-20 | docs: handoff — the last two days (#15–#23), what #16 found, server state, open items (#22) |
| `6d56373` | `86ab0ef` | 2026-10-20 | refactor: unify object reconstruction in RoomCanvas and archive legacy ViewForge UI (#23) |
| `4ad1921` | `8a8f7b6` | 2026-10-20 | web: stabilize static lighting during hover and transparency (#21) |
| `2af2798` | `6520e5c` | 2026-10-20 | web: calibrated lighting and static ambient occlusion (#19) |
| `0990c15` | `a7d00e1` | 2026-10-20 | samples: room3's piano opens — the TRELLIS piano of the articulation trial, lid and fallboard on hinges (#20) |
| `3c73407` | `0424312` | 2026-10-19 | web: near walls see-through instead of hidden — with what hangs on them and tall pieces in the way (#18) |
| `b74f107` | `2b479c2` | 2026-10-19 | web: what rests on an opening part moves with it — the office desk top lifts its monitor and cups, a piano lid its scores (#17) |
| `7b4377b` | `b2e00f2` | 2026-10-19 | web: add an object from photos — upload, masks, reconstruction on the ViewForge backend, then into the room (#15) |
| `2a1041d` | `0d2880c` | 2026-10-18 | web: doors, cabinet doors and windows open in preview — joints from the reconstruction's URDFs (#14) |
| `6f5da19` | `71954ea` | 2026-10-18 | refactor: rename reconstruction/ to room-reconstruction/, name docs and the import module by what they do (#13) |
| `feedda9` | `3860b3b` | 2026-10-18 | web: RoomCanvas home page, gestures built into the editor, one colour theme (#12) |
| `e077c91` | `ddf6420` | 2026-10-18 | docs: run ViewForge from RoomCanvas — deployment, portable startup, handoff (#11) |
| `4243a6b` | `c304ae8` | 2026-10-18 | samples: room3 with the small-objects step — 10 pieces rebuilt with TRELLIS, 9 dropped (#10) |
| `f05f14e` | `fb16236` | 2026-10-18 | web: room3 with gestures — the gesture page drives the editor, import ViewForge objects, drop checks in the background (#8) |
| `0815e26` | `b06a189` | 2026-10-18 | docs: handoff — product direction, running ViewForge with gestures (#7) |
| `b5cb24b` | `f166e80` | 2026-10-17 | docs: handoff — one RoomCanvas folder on the server, squash co-author rule (#6) |
| `a75e99c` | `fbae277` | 2026-10-17 | reconstruction: small objects after author — Astra drops, keeps or rebuilds each with TRELLIS (#4) |
| `89e65db` | `5b31973` | 2026-10-17 | feat: integrate viewforge (#5) |
| `9e9a897` | `00ffe75` | 2026-10-17 | docs: handoff — Astra decides per item (drop, procedural or TRELLIS), no fixed thresholds (#3) |
| `6667b65` | `a705907` | 2026-10-17 | docs: handoff — TRELLIS comparison results and the agreed small-object plan (#2) |
| `e705b74` | `40a6e31` | 2026-10-17 | fix: make selecting and moving heavy furniture fast, with the same collision results (#1) |
| `25b1438` | `671f7b1` | 2026-10-16 | Add the room3 and office sample rooms, README, CI |
| `46a3aa8` | `46a3aa8`（未变） | 2026-10-16 | web: furniture layout editor for reconstructed rooms |
| `a47c49e` | `a47c49e`（未变） | 2026-10-16 | reconstruction: run every agent role on Codex (GPT-6 Astra), add 3090 run scripts |
| `3453dd2` | `3453dd2`（未变） | 2026-10-16 | Import LiteReality-Agent 28ffe1f4 (2026-10-03) into reconstruction/ |

## mobile-android-app（不在 main 上的 2 个提交）

| 旧哈希 | 新哈希 | 日期 | 提交标题 |
| --- | --- | --- | --- |
| `8029490` | `e74283d` | 2026-11-16 | feat: update android-app and baking-pipeline, add filament-desktop |
| `ed854e8` | `603e7e1` | 2026-11-08 | feat: update android-app with latest AR viewer and VR walkthrough code, add baking-pipeline |

## wip/objects-trellis-20261103（不在 main 上的 1 个提交）

| 旧哈希 | 新哈希 | 日期 | 提交标题 |
| --- | --- | --- | --- |
| `412e367` | `4cf0dcf` | 2026-11-03 | wip: objects TRELLIS / PBR baking work from the server tree (2026-11-03) |
