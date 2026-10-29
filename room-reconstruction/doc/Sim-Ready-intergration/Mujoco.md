# MuJoCo export

The optional `simulate` stage converts a compiled room into MJCF bodies,
collision geometry, masses, inertias, and joints. `Room.glb` can already contain
named objects, articulation extras, and animation; it is not a substitute for
the physics scene and its validation.

## Run

From `room-reconstruction/`:

```bash
uv run litereality stage simulate run/<scene>
uv run litereality stage simulate run/<scene> --shake
uv run litereality run scans/<scene> --through simulate
uv run litereality stage simulate run/<scene> --from-seed
```

A bare CLI `run` also attempts this non-required stage; use `--through publish`
to omit it, or `--strict` to make an attempted simulation failure fatal.
The default source is the authored room; `--from-seed` uses the seed room.
Outputs go to `realism_authoring/mujoco/` or `mujoco_seed/`, respectively.
Both require an existing `Room.py` and compiled `Room.glb`. The stage runner
still requires `publish` to be complete, including with `--from-seed`. For a
seed-only export, use the direct exporter below with the seed room path recorded
in `scene.json`.

Direct export is also available:

```bash
uv run python -m litereality_agent.room_ops.export.mujoco_scene --room run/<scene>/realism_authoring/room
uv run python -m litereality_agent.room_ops.export.mujoco_shake --scene run/<scene>/realism_authoring/mujoco/scene.xml --cutaway --video shake.mp4
```

## Physics inputs

| Input | Purpose |
|---|---|
| `Room.py` / `SHELL` | Wall segments, openings, floor and ceiling heights |
| `room_layout.json` | Object poses, categories, support and attachment relationships |
| `Room.glb` | Named visual geometry |
| Object package `sim/<name>.physics.json` | Per-link physical properties, colliders, and joints |

[Object simulation code](../../src/litereality_agent/models/object_generation/sim/)
generates physics sidecars. The
[scene exporter](../../src/litereality_agent/room_ops/export/mujoco_scene.py)
places those properties into the room using matched object/room nodes.
Derived mass scales with volume; authored mass is retained. Placed geometry is
used to recompute inertia, and collider bounds are checked against the room layout.

If a sidecar is missing, unreadable, or cannot be placed, the exporter reports
the fallback. It can derive mass from category assumptions, decompose geometry,
and recover articulation from object extras. These estimates are not equivalent
to measured physical properties.

## Bodies and joints

- Structure uses static geometry derived from the shell, with wall openings cut out.
- Supported movable objects receive free joints.
- Wall/ceiling attachments remain static.
- Articulated parts receive hinge or slide joints. Sidecar joints carry their
  authored axes, pivots, limits, damping, and friction.
- Sidecar joints with effort values receive motors. Velocity values are stored
  as actuator user data for controllers, not enforced as MJCF velocity limits.
  Joints recovered only from extras do not receive invented effort limits.

Visual meshes are separate from collision geometry. Convex decomposition preserves
concave free space more closely than a single convex hull.
`--no-decompose` disables this for fallback geometry; use it only when that
approximation is acceptable.

The additional
[articulation pass](../../src/litereality_agent/pipeline/realism_authoring/articulate/)
can cut moving parts from an authored mesh, animate them, and write joint URDFs
for the browser editor. Those joint descriptions do not supply mass or collision
properties. The server writes this pass to a separate output tree; the standard
`simulate` stage still reads the authored or seed room.

## Validation and outputs

The output directory contains `scene.xml`, `meshes/`, and `export_report.json`.
The [stage implementation](../../src/litereality_agent/pipeline/simulate/__init__.py)
requires `loads_clean=true`; an absent/failed load check or initial
interpenetrations fail the stage. The report records sidecar coverage, fallback
objects, colliders, and actuated joints.

`--shake` moves the room through driven joints, writes `shake.mp4`, and reports
motion. A failed requested shake command fails the stage. A successful export
does not establish stability under every load or interaction.

See [support checks](../QC/supporting_relationship.md) and
[collision checks](../QC/collision_check.md).
