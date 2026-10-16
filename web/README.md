# web/

浏览器里的家具布置编辑器：选中家具，移动、旋转、升降、换墙、收进仓库再放回，带逐三角面的碰撞和支撑面检测，可撤销，布局存在浏览器里并能导入导出 JSON。纯前端，Three.js r180（`vendor/`，与 npm `three@0.180.0` 逐字节相同），没有构建步骤。

## 一个房间需要什么

房间目录里放两个文件：

- `Room.glb`：重建结果；
- `room_objects.json`：物体清单，用 `scripts/room_objects.py` 从重建的 `room_layout.json` 生成。

清单里记录每个物体是房间结构、门窗、固定设施（插座、灯、窗帘、暖气片等，留在房间里），还是可移动家具，以及哪些东西要一起移动（桌子连同桌上的东西、书架连同书）、挂在哪面墙上、上面哪些部件能放东西。家具名默认按类别自动起（“柜子 1”）；在 `groups` 里给某组加 `"name": "钢琴"` 就用手写的名字，重新生成时会保留。

编辑器打开房间时还会自动处理几件事：从椅子网格里找座面；把墙角的短墙连到两侧长墙上，剖墙时一起隐藏；把没记录墙的窗帘归到它前面的墙。

打开方式：`editor/?scene=<房间目录相对 editor/ 的路径>`，例如 `editor/?scene=../../samples/room3`。要放到仓库外的某个房间目录旁边，用 `python3 web/scripts/publish.py --scene-dir <房间目录>`。

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
| `editor/tests/` | 单元测试（Node 自带测试框架） |
| `scripts/room_objects.py` | `room_layout.json` → `room_objects.json` |
| `scripts/check_*.mjs` | 用真实模型在 CPU 上检查：`check_room` 适用于任何房间，其余四个针对 office |
| `scripts/publish.py` | 把编辑器复制到某个房间目录旁边 |

## 测试

```bash
node --test 'web/editor/tests/*.mjs'
python3 -m unittest discover -s web/scripts
node web/scripts/check_room.mjs --scene-dir samples/room3      # 约 30 秒
for c in collision wall_mount seat_support gravity; do node web/scripts/check_$c.mjs --scene-dir samples/office; done
```

CI 全部都跑。

## 已知问题

- **重模型会卡**：碰撞检查里的“网格包含”判断对每个三角面做射线测试。room3 共 57 万个三角面，选中床约 4 秒，钢琴、椅子 2–5 秒。
- **重建本身的误差**：重建结果里家具之间常有几毫米到几厘米的互相穿插（room3 有 9 处）。这些原本就交叠的网格对不算碰撞，其余照常检查。白板、书架这类插进墙的，打开时显示“待调整”，挪开即可。
