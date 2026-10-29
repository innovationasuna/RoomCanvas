# Room operations

`room_ops` owns the portable room definition, compilation, rendering, and export.
Pipeline scheduling and agent/model execution belong outside this package.

## API and commands

```python
from litereality_agent.room_ops import compile_room, export_scene

room = export_scene("<scene>")
if room is not None:
    glb = compile_room(room)
```

The export expects prepared scan/reconstruction artifacts. From
`room-reconstruction/`, the corresponding module entry points are:

```bash
uv run python -m litereality_agent.room_ops.export.export_room --scan <scene>
uv run python -m litereality_agent.room_ops.compile.build_from_room --room <room>
```

[api.py](api.py) exposes the Python functions.
`compile_room` assembles and, by default, bakes the room; the direct
`build_from_room` command performs assembly.
Importing this package does not start Blender.

## Editable format

```text
room/
├── Room.py
├── Room.md
├── manifest.json
└── Objects/
    ├── Procedural/<name>/
    └── Static/<name>/
```

`Room.py` defines the semantic shell and placements. `manifest.json` maps
objects to RoomPlan detections. Procedural packages retain `object.py`,
editing notes, and texture recipes; static packages retain a source GLB and
a rebuild wrapper. Object packages may also carry `sim/` physics sidecars.

The scene package's `scene.json` supplies capture and artifact paths; it is
distinct from the room's object manifest.

## Compiled output

The default sibling `room_preview/` contains `Room.glb`, `Room.blend`,
`room_layout.json`, `manifest.json`, and compiled objects under `Object/`.
These outputs are rebuilt from the editable room.

## Modules

| Module | Responsibility |
|---|---|
| [manifest.py](manifest.py) | Scene-package schema and discovery |
| [paths.py](paths.py) | Input/output and Blender paths |
| [surfaces.py](surfaces.py) | Surface discovery |
| [compile](compile/) | Object and room compilation, texture baking |
| [export](export/) | Room definition and MuJoCo export |
| [rendering](rendering/) | Camera renders and object turntables |
| [walk](walk/) | Serve a GLB in the browser viewer |

See [MuJoCo export](../../../doc/Sim-Ready-intergration/Mujoco.md) for physics
sidecars and [validation](../../../doc/QC/supporting_relationship.md) for
support/articulation checks.
