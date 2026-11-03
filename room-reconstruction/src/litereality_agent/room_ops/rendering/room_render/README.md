# Capture-camera rendering

[render_room_cameras.py](render_room_cameras.py) renders an assembled
`RoomScene` at ARKit capture poses. It adds lighting and selects EEVEE or CYCLES.
For an authored `Room.py`, use the
[render comparison engine](../../../agent/tools/render/source/README.md).

## Standalone assembly rendering

The low-level script needs a builder that creates a `ROOM` scene object.
Set `SB_ROOM_PY` explicitly to the
[room assembler](../../compile/build_room.py); the default `room.py` path
is not a file supplied at the module root.

From `room-reconstruction/`, with Blender on `PATH`:

```bash
SB_ROOM_PY="$PWD/src/litereality_agent/room_ops/compile/build_room.py" \
blender -b --python src/litereality_agent/room_ops/rendering/room_render/render_room_cameras.py -- \
  /path/to/capture /path/to/packed-assets /path/to/render-output 0,8,30 EEVEE 2
```

The assets directory must contain the packed `manifest.json` and its GLBs.

| Positional argument | Meaning |
|---|---|
| `scan_dir` | Capture directory |
| `assets_dir` | Packed asset directory |
| `out_dir` | Render destination |
| `frames` | `all`, an evenly spaced count, a range, or comma-separated indices |
| `engine` | `EEVEE` (default) or `CYCLES` |
| `res_div` | Integer resolution divisor, default 1 |
| `mode` | `render` (default) or `describe` for manifests without image rendering |

For one exact frame, use a comma-list form such as `30,`; a bare `30` means
a count of evenly spaced cameras.

## Outputs and annotation

Rendering writes `frame_NNNNN.png`, `scene_manifest.json`, and
`render_manifest.json`. Building the scene also exports `room.glb`.
Images rotate 90 degrees clockwise by default to match upright capture photos;
the Python `render_room_from_cameras` API accepts `rotate=False`.

With Pillow available, annotate existing renders:

```bash
uv run python src/litereality_agent/room_ops/rendering/room_render/annotate_views.py /path/to/render-output /path/to/capture
```

[annotate_views.py](annotate_views.py) writes `annotated/`, `sidebyside/`, and
`svg/` outputs. The manifests record visible objects, label locations, and
editing metadata. The render function also returns timing statistics for the
current invocation.
