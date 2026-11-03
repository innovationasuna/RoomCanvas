# Support relationships

Objects declare what holds them through `rests_on` or `attached_to` in the
compiled `room_layout.json`. A `support_part` identifies a particular moving
part of a supporter. Validation checks both the relationship graph and the
exported geometry.

## Entry points

From `room-reconstruction/`, validate the compiled room:

```bash
uv run python -m litereality_agent.pipeline.room_qc.validate --room run/<scene>/realism_authoring/room
```

[validate.py](../../src/litereality_agent/pipeline/room_qc/validate.py) calls
[support_audit.audit(preview, strict=True)](../../src/litereality_agent/pipeline/room_qc/support_audit.py)
for finite-mesh contact and
[export_support.check](../../src/litereality_agent/pipeline/room_qc/export_support.py)
for exported nodes and moving-support relationships.
Its `check_support(objs, floor_z)` helper provides bounding-box diagnostics;
it does not take a GLB path.

To run only the support audit:

```bash
uv run python -m litereality_agent.pipeline.room_qc.support_audit \
  --preview run/<scene>/realism_authoring/room_preview \
  --out run/<scene>/realism_authoring/room_preview/support_audit.json --strict
```

The audit reads `Room.glb` and `room_layout.json`; the output's parent directory
must exist. It returns 0 for pass and 2 for failed findings.

## What is checked

- One resolved support relationship per non-root object, without unknown
  supporters or cycles. Floor-standing categories can infer the floor; strict
  mode can infer an opening's wall from its source name. Conflicting explicit
  relationships are rejected.
- Finite mesh distance for attachments, with a 0.01 m threshold in strict mode.
- Downward contact against upward-facing support triangles, with 0.005 m contact
  and sink tolerances in strict mode. Contact coverage and disconnected components
  are checked as well.
- Exported supporter/child nodes must be unambiguous. Moving supports require a
  valid `support_part` and preservation of the child's motion in the GLB.

Findings include `ambiguous_support`, `unknown_support`, `support_cycle`,
`attachment_gap`, `no_downward_support_contact`, and
`support_motion_not_preserved`. Failure to run the strict checks blocks validation.

## Limits and repair

This is a geometric check, not proof that a support is visually correct or can
carry a physical load. Review capture evidence when a support is missing or
implausible. Edit the room or relationship, rebuild, and rerun validation.
There is no automatic support-height snapping entry point in this check.

See [collision checks](collision_check.md) and [MuJoCo export](../Sim-Ready-intergration/Mujoco.md).
