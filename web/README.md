# web/

浏览器里的家具布置编辑器：选中家具，移动、旋转、升降、换墙、收进仓库再放回，带逐三角面的碰撞和支撑面检测，可撤销，布局存在浏览器里并能导入导出 JSON。纯前端，Three.js r180（`vendor/`，与 npm `three@0.180.0` 逐字节相同），没有构建步骤。

## 一个房间需要什么

房间目录里放两个文件：

- `Room.glb`：重建结果；
- `room_objects.json`：物体清单，用 `scripts/room_objects.py` 从重建的 `room_layout.json` 生成。

清单里记录每个物体是房间结构、门窗、固定设施（插座、灯、窗帘、暖气片等，留在房间里），还是可移动家具，以及哪些东西要一起移动（桌子连同桌上的东西、书架连同书）、挂在哪面墙上、上面哪些部件能放东西。小物件那一步用 TRELLIS 重建的物件（`room_layout.json` 里标了 `rebuilt`）单独成组，可以单独移动；它放在家具上时，家具移动会带着它走。家具名默认按类别自动起（“柜子 1”）；在 `groups` 里给某组加 `"name": "钢琴"` 就用手写的名字，重新生成时会保留。

编辑器打开房间时还会自动处理几件事：从椅子网格里找座面；把墙角的短墙连到两侧长墙上，剖墙时一起隐藏；把没记录墙的窗帘归到它前面的墙。

打开方式：`editor/?scene=<房间目录相对 editor/ 的路径>`，例如 `editor/?scene=../../samples/room3`。要放到仓库外的某个房间目录旁边，用 `python3 web/scripts/publish.py --scene-dir <房间目录>`。

## 手势和导入物体

`scripts/serve.py` 在仓库根目录起网页服务，同时把 `/viewforge/layouts/` 下的读请求（物体目录、尺寸、模型）转给 ViewForge 服务器（默认 SSH 隧道 `127.0.0.1:7865`）。

- **手势**：手势页（`gesture/`，ViewForge 带来的）用 iframe 嵌入编辑器，在浏览器里识别手势，按 `viewforge-gesture-v1` 协议发指针帧；编辑器的接收端在 `editor/gesture-bridge.mjs`，消息和 ViewForge 布局页的接收端一致，手势页不用改。手的指针覆盖整个编辑器页面，像鼠标一样：指向按钮捏合就是点击；移动模式下捏住仓库卡片拖出（家具先挂在指针上，手移进房间才出现；在仓库上方松手等于没拿），卡片多时先捏“仓库”按钮展开全部；捏住家具拖动，保持抓住的位置，不会跳到手指中心。拖动中只预览；松手后家具停在原地成为预览，做完整的支撑和碰撞检查，再捏住可以继续移动或切到旋转；在预览上轻捏一下（600 毫秒内、几乎不动）就是“放置并落下”（手势识别偶尔把捏合误判成松开，所以松手本身不确认）。去拿另一件时，上一件预览能放就先放下；放不下或还在检查就不拿新的，并提示原因，预览不会被悄悄退回仓库。旋转是手横扫整个画面转一圈。编辑器自己卡顿时迟到的手势帧照常按顺序处理，2 秒以上才算丢手（ViewForge 是 250 毫秒；拿起家具时换材质会卡一下，按 250 毫秒会把拖动中断）。观察模式两指捏合环绕、三指平移。手势页的“取消当前操作”取消这次摆放。嵌在手势页里时编辑器直接打开房间。
- **导入物体**：工具栏“导入物体”列出 ViewForge 的重建结果；在 ViewForge 里标定过的自动填好尺寸，没标定的填一条实测边长（和 ViewForge 布局页一样）。显示用完整模型，碰撞和支撑用它的轻量预览（同一坐标，三角面约 1/40）。导入后放在离房间中心最近的空地上，再用手势或鼠标摆放。导入要重建碰撞索引，room3 约 10 秒。

## 文件

| 位置 | 内容 |
|---|---|
| `index.html` | 示例房间首页 |
| `editor/scene-editor.js` | 主程序：加载房间、选择、视角、仓库栏、放置流程 |
| `editor/room-catalog.mjs` | 读 `room_objects.json`，生成可编辑清单、墙面归属 |
| `editor/placement.mjs`、`drop-placement.mjs` | 落到支撑面、自动找座面、贴墙、换墙、掉落 |
| `editor/collision.mjs` | 逐三角面的连续碰撞 |
| `editor/wall-visibility.mjs` | 剖墙、墙角连接 |
| `editor/layout.mjs` | 布局数据、撤销重做、导入导出 |
| `editor/placement-*.mjs`、`joystick-ui.mjs` | 预览后确认的放置流程、控制卡、摇杆 |
| `editor/gesture-bridge.mjs` | 手势页协议的接收端：抓取、移动、旋转、松手，相机环绕和平移 |
| `editor/viewforge-import.mjs` | 读 ViewForge 物体目录和尺寸，算真实尺寸的放置矩阵 |
| `editor/tests/` | 单元测试（Node 自带测试框架） |
| `scripts/room_objects.py` | `room_layout.json` → `room_objects.json` |
| `scripts/check_*.mjs` | 用真实模型在 CPU 上检查：`check_room` 适用于任何房间，其余四个针对 office |
| `scripts/publish.py` | 把编辑器复制到某个房间目录旁边 |
| `scripts/serve.py` | 本机网页服务，转发 ViewForge 的读请求 |

## 测试

```bash
node --test 'web/editor/tests/*.mjs'
python3 -m unittest discover -s web/scripts
node web/scripts/check_room.mjs --scene-dir samples/room3      # 约 30 秒
for c in collision wall_mount seat_support gravity; do node web/scripts/check_$c.mjs --scene-dir samples/office; done
```

CI 全部都跑。

## 已知问题

- **iframe 太矮时够不着仓库**：编辑器最矮 640 像素，手势页窗口太小时仓库会在 iframe 可见区域以外，手的指针到不了。
- **导入的物体不保存**：布局保存、导出只含房间原有家具；刷新后导入的物体要重新导入。以后有了后端再存。

- **重模型的检查要等一会儿**：落点的完整碰撞检查在后台线程（`editor/collision-worker.mjs`，同一份代码和三角面，结果相同）里做，页面不冻住；钢琴、琴凳这类紧挨着的重网格约 1–2 秒，期间预览是黄色“检查中”，确认按钮写“检查中…”，这时确认会在检查完后自动放下。用方向按钮逐步挪动、鼠标悬停摆放时的碰撞检查仍在页面线程，重网格挨着时还会顿一下；要更快需要给重网格做简化碰撞外形。
- **重建本身的误差**：重建结果里家具之间常有几毫米到几厘米的互相穿插（room3 有 9 处）。这些原本就交叠的网格对不算碰撞，其余照常检查。白板、书架这类插进墙的，打开时显示“待调整”，挪开即可。
