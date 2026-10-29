# Procedural object generation

[generate.py](generate.py) builds routed objects from category specifications,
RoomPlan dimensions, and clean reference images.
[category_specs.py](category_specs.py) defines geometry, materials, orientation,
and motion for each supported category. The
[complexity router](../../pipeline/scene_init/reconstruct/classify/classify_complexity.py)
chooses procedural or TRELLIS reconstruction.

## Run

Use a configured Blender installation and signed-in Codex CLI.
The pipeline defaults to Codex / `gpt-6-astra`; `--provider` or
`LR_PROCEDURAL_PROVIDER` selects a provider explicitly.
Claude remains available through the same launcher.

From `room-reconstruction/`, after ingest and routing:

```bash
uv run python -m litereality_agent.models.object_generation.generate \
  --work run/<scene>/scene_init/obj_stage/object_init --only storage --dry-run
uv run python -m litereality_agent.models.object_generation.generate \
  --work run/<scene>/scene_init/obj_stage/object_init --skip-existing
```

| Option | Default / meaning |
|---|---|
| `--work` | Object-init tree; otherwise derived from the pipeline environment |
| `--out` | Output root; defaults to `reconstructed_objs` beside the work tree |
| `--scan` | Limit scans |
| `--only` | Limit categories |
| `--openings` | Generate doors/windows from opening references |
| `--concurrency` | 2 |
| `--retries` | 1 |
| `--max-turns` | 80 |
| `--max-budget-usd` | Optional provider-dependent budget; unset by default |
| `--provider` | `codex` or `claude` |
| `--model` | Claude model override; Codex uses `LR_CODEX_MODEL` instead |
| `--skip-existing` | Reuse complete outputs |
| `--dry-run` | List jobs and print a composed prompt without generation |

Provider capabilities differ; a cost budget is not enforced by Codex.
See [agent providers](../../../../ARCHITECTURE.md#agent-providers).

## Outputs

Each `<out>/<name>/` contains the GLB, `object.py`, `object.md`, textures,
and render-check previews. Moving parts carry `articulation_type`,
`articulation_axis`, `limit_min`, and `limit_max` extras plus animation.
Static objects have no required joints.

The output root receives `procedural_report.json` or `openings_report.json`.
[sim](sim/) supplies physics compilation and checks; a joint animation alone
does not establish simulation readiness.

## Bundled agent helpers

[articulated-glb-agent](articulated-glb-agent/) contains the runtime skill and
Blender helper scripts used by `generate.py`.
The separate [batch_glb.py](articulated-glb-agent/batch_glb.py) accepts arbitrary
images and still uses Claude Agent SDK directly; it is not the default
provider-aware reconstruction launcher.

Its inputs are image paths/directories. `--out-base` selects an output root;
otherwise it writes beside each image in `<name>_glb/`.
It supports `--concurrency`, `--retries`, `--skip-existing`, and `--dry-run`,
and writes `batch_glb_report.json`. Completion requires a nontrivial GLB,
at least two PNG previews, `object.py`, and `object.md`.
