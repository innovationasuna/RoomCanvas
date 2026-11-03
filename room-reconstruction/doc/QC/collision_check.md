# Collision checks

Room validation checks the compiled meshes, so a chair beneath a table is not
rejected merely because their bounding boxes overlap.

## Validate a compiled room

From `room-reconstruction/`:

```bash
uv run python -m litereality_agent.pipeline.room_qc.validate --room run/<scene>/realism_authoring/room
```

[validate.py](../../src/litereality_agent/pipeline/room_qc/validate.py) reads the
sibling `room_preview/` by default; use `--preview` to select another build.
It writes `validation.json`. Exit codes are 0 for pass, 2 for blocking findings,
and 1 when validation cannot run.

Blocking collision findings include `object_clash`, `wall_clash`,
`opening_blocked`, `open_swing_blocked`, and mesh-check failures.
Unavailable mesh checking is a failure. Bounding-box overlaps and manifold
diagnostics are reported separately; support and articulation also participate in
the overall verdict.

The geometry implementation is
[collision_mesh.py](../../src/litereality_agent/agent/tools/check_collisions/source/collision_mesh.py).
The agent's `check_collisions` tool uses mesh checks by default and offers
`method="box"` for a coarse shell-based check.

## Placement correction

[correct.py](../../src/litereality_agent/pipeline/room_qc/correct.py) plans
bounded XY moves for `object_clash` and `wall_clash`. It respects anchored
objects and leaves unresolvable cases in the report.

```bash
uv run python -m litereality_agent.pipeline.room_qc.correct --room run/<scene>/realism_authoring/room
uv run python -m litereality_agent.pipeline.room_qc.correct --room run/<scene>/realism_authoring/room --apply
```

The first command prints a plan; `--apply` writes placement changes to `Room.py`.
`--max-nudge` defaults to 0.30 m. Correction does not rebuild the room or certify
a pass; recompile and validate the resulting artifact. Its exit code alone is
not an acceptance signal.

For arithmetic diagnostics without mesh contact testing,
[checks.py](../../src/litereality_agent/pipeline/room_qc/checks.py) accepts
`--room`, or `--layout` together with `--shell`.

See [support checks](supporting_relationship.md) for contact and attachment rules.
