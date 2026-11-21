# Architecture

The module separates capture processing, agent authoring, room operations, and
model execution. [pipeline/stages.py](src/litereality_agent/pipeline/stages.py)
defines the standard stage order:

```text
ingest → reconstruct → seed → author → publish → simulate (optional)
```

`simulate` is non-required: a bare CLI `run` includes it, but its failure is
nonfatal unless strict mode is selected. `--through publish` stops before it.

Stages expose `run(context, options) -> StageResult`.
[PipelineRunner](src/litereality_agent/pipeline/runner.py) handles prerequisites,
reuse, failures, and state in `<scene>/.litereality/pipeline.json`.

## Package ownership

Paths below are relative to [src/litereality_agent](src/litereality_agent/).

| Package | Responsibility |
|---|---|
| `cli.py` | Installed `litereality` commands |
| `settings.py` | Typed settings and environment loading |
| `pipeline/scene_init/` | Ingest, layout repair, reconstruction, seed room |
| `pipeline/realism_authoring/author/` | Evidence, authoring, optional refinement/materials/quality passes |
| `pipeline/realism_authoring/small_objects/` | Per-object keep, discard, or rebuild |
| `pipeline/realism_authoring/articulate/` | Identify, cut, and animate openable parts |
| `pipeline/realism_authoring/live/` | Authoring viewer |
| `pipeline/room_qc/` | Validation, placement correction, and publication |
| `pipeline/simulate/` | Optional MuJoCo export and shake check |
| `agent/` | Agent sessions, providers, capability tools, and traces |
| `room_ops/` | Portable room representation, compilation, rendering, export |
| `models/` | Detection, embeddings, reference images, and object generation |
| `runtimes/` | Hosted execution and deployment setup |

The small-object and articulation passes are not separate stages in
`pipeline/stages.py`: `author` runs them on its build before its one check, and
again on the build its repair makes
([passes.py](src/litereality_agent/pipeline/realism_authoring/passes.py)), and
`publish` publishes the room they complete. The
[server runner](server/run_room.py) configures a single-machine environment and can
also run either pass on its own over a finished room. See the
[project workflow](../docs/ROOM_RECONSTRUCTION.md) for their inputs and output selection.

## Agent providers

[agent/providers](src/litereality_agent/agent/providers/) accepts a `SessionSpec`
and normalizes provider events. The default is Codex with `gpt-6-astra`.
[models.env](models.env) and [settings.py](src/litereality_agent/settings.py)
configure per-role providers and models; Claude remains an explicit alternative.
Author, materials, quality, and refinement have explicit Codex defaults;
the procedural role inherits the general provider unless overridden.

Codex exposes capability tools over stdio MCP through
[tools/mcp_server.py](src/litereality_agent/agent/tools/mcp_server.py).
Claude hosts them in process. Provider capabilities differ: Codex does not report
cost or offer the Claude pre-tool hook/tool allowlist, and enforces a hard session
limit. Call sites inspect the provider's declared capabilities.

Object refinement creates a per-object render tool; Codex serves it through
[object_server.py](src/litereality_agent/pipeline/realism_authoring/author/object_server.py).

## Tool and dependency boundaries

[default_registry.py](src/litereality_agent/agent/tools/default_registry.py)
registers six tools: `fetch_material`, `render`, `critic`, `select_views`,
`grid`, and `check_collisions`. Compilation is shared implementation called
by render, not a registered tool.

Pipeline code owns workflow decisions. Agent tools own reusable capabilities;
`room_ops` owns the portable room format; model packages own inference;
runtime adapters own execution location. Dependency boundaries are checked in
[test_architecture.py](tests/test_architecture.py).

## Configuration and execution

Settings precedence is:

```text
process environment > .env > models.env > typed defaults
```

[models/registry.py](src/litereality_agent/models/registry.py) selects inference runtimes.
Configured Modal credentials select hosted TRELLIS; otherwise `TRELLIS_PYTHON`
is required. DINO also supports an explicit `LR_DINO_BACKEND=local` override.
Heavy local models use separate Python environments.

## Validation and outputs

Object checks run in
[reconstruct/mesh_qc](src/litereality_agent/pipeline/scene_init/reconstruct/mesh_qc/).
Assembled-room checks run in
[room_qc](src/litereality_agent/pipeline/room_qc/), including finite support contact,
exported articulation, and mesh collision checks. Publication applies acceptance
to the final export; simulation separately requires a clean load check.

See [room operations](src/litereality_agent/room_ops/README.md) for the editable
format and [README outputs](README.md#outputs) for the scene-package layout.
