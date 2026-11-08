# Room reconstruction

This module turns an iPhone LiDAR/RoomPlan capture into an editable room for
RoomCanvas: room structure, reconstructed furniture, materials, and optional
small-object and articulated-part passes. It exports Blender and GLB assets for
the browser furniture editor, with an optional MuJoCo export.

For the project's scan-to-editor workflow and GPU server commands, see
[RoomCanvas room reconstruction](../docs/ROOM_RECONSTRUCTION.md).

Based on LiteReality-Agent; see [citation.bib](citation.bib).

## Install

Run the commands below from `room-reconstruction/`. Requirements:

- Python 3.10–3.12 and [uv](https://docs.astral.sh/uv/) 0.9.17 or newer.
- Blender 5.x; set `BLENDER_PATH` to its installation directory.
- A signed-in `codex` CLI on `PATH`. Agent roles default to Codex with
  `gpt-6-astra`; provider and model settings are in [models.env](models.env).
- An image-generation key: `OPENAI_API_KEY`, or `GEMINI_API_KEY` with
  `LR_IMAGE_PROVIDER=gemini`.
- Hosted GPU models on Modal, or a configured local NVIDIA GPU runtime.

Install the application and copy the environment template if `.env` does not exist:

```bash
uv sync --frozen --extra modal --group dev
cp .env.example .env
```

Fill in `.env`:

| Setting | Purpose |
|---|---|
| `BLENDER_PATH` | Directory containing the Blender executable |
| `LR_SCANS_DIR` | Parent directory of captures |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | Reference-image generation |
| `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` | Modal token pair, for hosted inference |
| `MODAL_PROFILE` | Named Modal profile, as an alternative to the token pair |

Follow [Modal deployment](deploy/modal/README.md) to deploy the combined model app,
or [local GPU setup](deploy/local-gpu.md) to configure isolated model environments.
Then check the installation:

```bash
uv run python sanity.py
```

`SANITY_DEEP=1` enables model loading/inference checks and may invoke hosted services.

## Run

The single-machine server entry point is [server/run_room.py](server/run_room.py).
Its runtime paths and full-run, small-object, and articulation modes are documented
in the [RoomCanvas guide](../docs/ROOM_RECONSTRUCTION.md).

For module-level runs, a capture contains `room.usdz`, RGB frames, and camera/depth data:

```bash
uv run litereality run scans/<scene> --through publish
uv run litereality run scans/<scene> --through seed
uv run litereality stage author run/<scene> --force --polish --live
uv run litereality stage publish run/<scene>
uv run litereality view run/<scene>
```

Use the generated directory containing `scene.json` for stage and viewer commands;
its name can differ from the input folder. `--polish` adds object refinement and
materials; `--quality-pass` separately enables model-driven quality review.
`--live` opens the authoring viewer.

The standard stages are `ingest → reconstruct → seed → author → publish`.
The bare `run` command also attempts the non-required `simulate` stage;
`--through publish` stops before it. Simulation can be requested separately:

```bash
uv run litereality stage simulate run/<scene>
uv run litereality stage simulate run/<scene> --shake
```

## Outputs

Under a scene package:

- `scene.json`: capture and artifact paths.
- `scene_init/`: evidence, reconstructed objects, and seed room.
- `realism_authoring/room/`: editable `Room.py` and object assets.
- `realism_authoring/room_preview/`: `Room.glb`, `Room.blend`, and build metadata.
- `realism_authoring/mujoco/`: optional `scene.xml`, meshes, and export report.
- `.litereality/pipeline.json`: stage state for resuming.

The server's articulation pass writes a separate `<run_dir>/articulate/room_preview/`;
it does not replace the standard published preview. Use the output selected by the
RoomCanvas guide. A generated file alone does not establish validation or acceptance.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Agent tools](src/litereality_agent/agent/tools/README.md)
- [Ingest](src/litereality_agent/pipeline/scene_init/ingest/README.md) and
  [layout](src/litereality_agent/pipeline/scene_init/layout/README.md)
- [Object generation](src/litereality_agent/models/object_generation/README.md)
- [Room format and operations](src/litereality_agent/room_ops/README.md)
- [Collision checks](doc/QC/collision_check.md) and [support checks](doc/QC/supporting_relationship.md)
- [MuJoCo export](doc/Sim-Ready-intergration/Mujoco.md)
- [Tests](tests/README.md) and [capture utilities](scripts/README.md)
