# Render comparison engine

Render the current `Room.py` and compare it with capture images from the same
camera poses. [compose.py](compose.py) provides the Python API;
[__main__.py](__main__.py) provides the CLI.

## Modes

| Mode | Python function | Annotation |
|---|---|---|
| `scene` | `render_scene(room, frames)` | Visible object labels |
| `wall` | `render_wall(room, frames)` | All visible wall outlines |
| `wall-focus` | `render_wall_focus(room, frames, wall)` | One wall |
| `object` | `render_object(room, frames, obj)` | One object's bounding box |
| `ref` | `render_wall_reference(room, walls)` | Orthographic/stitch and wall-focused reference pairs |

A wall outside a frame has no projected outline. Choose visible frames with
`select_views`; absence of an outline is not evidence that the wall is missing.
Batch frame lists to share scene construction.

## CLI

From `room-reconstruction/`, replace `<room>` with an editable room directory:

```bash
uv run python -m litereality_agent.agent.tools.render.source scene --room <room> --frames 10,20
uv run python -m litereality_agent.agent.tools.render.source wall --room <room> --frames 10,20
uv run python -m litereality_agent.agent.tools.render.source wall-focus --room <room> --frames 10 --wall Wall2
uv run python -m litereality_agent.agent.tools.render.source object --room <room> --frames 10 --object Table0
uv run python -m litereality_agent.agent.tools.render.source ref --room <room> --walls Wall0,Wall2
```

Frame modes accept comma-separated indices, ranges such as `0-40`, or `all`.
Omit `--walls` in `ref` mode for all walls. All modes accept `--scan` and
`--out` overrides.

## Python

```python
from litereality_agent.agent.tools.render.source import render_scene, render_wall_reference

room = "run/<scene>/realism_authoring/room"
pairs = render_scene(room, [10, 20])
surfaces = render_wall_reference(room, ["Wall0", "Wall2"])
```

Calls return mappings of frame/surface keys to image paths. Default outputs are
under the room's sibling `_image_render_tool/` directory.

## Prerequisites and limits

The room definition, its referenced assets, Blender, and capture frames/camera
metadata must be available. Scan discovery is shared with the capability tools.
Surface comparisons additionally need rectified surface references; wall-reference
evidence is built and cached by [wall_refs.py](wall_refs.py).

[surface_compare.py](surface_compare.py) renders orthographic surfaces using
[shared surface geometry](../../shared/image_selection/README.md#surface-comparison).
Missing stitches can leave a surface without a paired comparison. Alignment of
camera poses does not remove reconstruction or calibration error.

The higher-level [render tool](../tool.py) adds automatic frame selection and
compile-freshness handling.
