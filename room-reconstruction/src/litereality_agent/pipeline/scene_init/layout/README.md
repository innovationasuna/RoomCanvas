# Layout repair

Layout repair adjusts extracted boxes before crops, reference images, and object
reconstruction are generated.

[stage.run_layout](stage.py) is called by
[scene_init/flow.py](../flow.py). It applies geometry checks and optional
agent-assisted corrections, then writes the repaired object data and shell.
The caller enforces [layout validation](validation.py); unresolved errors or
fidelity violations are not accepted as a completed ingest.

## Components

| Module | Responsibility |
|---|---|
| [adapter.py](adapter.py) | Convert extracted scene data to/from a semantic shell |
| [adjust.py](adjust.py) | Check layout geometry and evaluate edits |
| [repair.py](repair.py) | Propose placement, size, and optional duplicate-removal actions |
| [converge.py](converge.py) | Iterate repairs and enforce cumulative fidelity limits |
| [agent.py](agent.py) | Propose evidence-based changes |
| [report.py](report.py) | Draw before/after plans |

The pass records `layout_baseline.json`, `layout_shell.json`, and
`layout_report.json` in the scene-data directory. The baseline ties repairs to
the extracted source; changing that source requires re-extraction.
An exception is returned as an error and rejected by the caller's validation.

## Merge guards

[ingest/merge_boxes.py](../ingest/merge_boxes.py) runs before layout.
Its wall guard refuses a merge edge when the segment between box centres
crosses a wall segment. Vertical grouping checks separately prevent stacked
units from being merged into one tall object.

## Configuration

These defaults are read by the implementation when no override is supplied:

| Variable | Default | Effect |
|---|---|---|
| `LR_LAYOUT` | `1` | Enable layout repair |
| `LR_LAYOUT_AGENT` | `1` in `stage.run_layout` | Enable evidence-assisted repair |
| `LR_LAYOUT_DROP` | `0` | Permit duplicate removal when enabled |
| `LR_LAYOUT_VIZ` | `1` | Draw before/after plans |
| `LR_BOX_MERGE_WALL_GUARD` | `1` | Refuse merges across walls |

Disabling a pass does not bypass the pipeline's required validation.
Layout uses boxes and shell geometry; it does not replace final
[mesh collision](../../../../../doc/QC/collision_check.md) or
[support checks](../../../../../doc/QC/supporting_relationship.md).
