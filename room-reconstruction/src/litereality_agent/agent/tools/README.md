# Agent capability tools

[default_registry.py](default_registry.py) registers the tools used by authoring,
materials, and quality passes. The default provider is Codex, which exposes them
through [mcp_server.py](mcp_server.py) over stdio MCP. The Claude provider hosts
the tools in process. File and shell access depend on the selected provider.

## Tools

| Tool | Behaviour |
|---|---|
| [fetch_material](fetch_material/) | Fetch a PBR texture set, optionally recoloured |
| [select_views](select_views/) | Select capture frames for a room, wall, or object |
| [render](render/) | Build and compare a target with capture images |
| [grid](grid/) | Add a metric grid to a surface reference |
| [critic](critic/) | Grade images against a stated goal |
| [check_collisions](check_collisions/) | Mesh collision checks; optional box approximation |

[compile](compile/) is shared implementation used by render, not a registered tool.

## Implementation

- [base.py](base.py): declarative tools and parameter models.
- [registry.py](registry.py): registry and schema construction.
- [_scene.py](_scene.py): active-room resolution.
- [_vlm.py](_vlm.py): vision calls.
- [render/source](render/source/README.md): frame and surface comparison engine.
- [select_views/source](select_views/source/): visibility ranking.

## Shared geometry and evidence

| Module | Responsibility |
|---|---|
| [shared/config.py](shared/config.py) | Paths and rendering configuration |
| [shared/scan.py](shared/scan.py) | Scan inference and per-scan configuration |
| [shared/overlay.py](shared/overlay.py) | Wall-plane projection |
| [shared/image_selection](shared/image_selection/README.md) | Surface geometry and comparison |
| [shared/stitch_wall_image](shared/stitch_wall_image/) | Rectified capture stitches |

Compilation and texture recipes remain in `room_ops`, which owns the room format.
See the [tool guides](../../../../doc/Tools/) for behaviour and examples.
