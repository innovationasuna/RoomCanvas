# Capture utilities

These standalone scripts support capture preparation and inspection.
Run them from `room-reconstruction/`; each script defines its own arguments.

| Script | Purpose |
|---|---|
| [build_meshes.py](capture/build_meshes.py) | Fuse RGB/depth frames into a TSDF mesh |
| [build_pointclouds.py](capture/build_pointclouds.py) | Fuse a coloured point cloud |
| [colorize_pcd.py](capture/colorize_pcd.py) | Colour a scanner point cloud from RGB frames |
| [shrink_scan.py](capture/shrink_scan.py) | Reduce capture data size |
| [layout_batch.py](capture/layout_batch.py) | Run layout processing over captures |

Use `uv run litereality` for pipeline runs.
The [server runner](../server/run_room.py) configures the single-machine workflow;
see the [project guide](../../docs/ROOM_RECONSTRUCTION.md).
