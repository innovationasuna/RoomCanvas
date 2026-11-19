"""Stable stage input identities; timestamps never prove that content is unchanged.

An identity covers the content a stage reads and the model settings it consumes. It leaves out
the stage's own outputs, its options (the runner compares those itself), source code and where
the job directory lives: a mismatch makes the stage start over, so anything hashed here that does
not decide the result becomes a paid rerun.
"""

from pathlib import Path

from litereality_agent import artifact_cache
from litereality_agent.pipeline.context import RunContext

# The model choices each stage's code reads (directly or as the environment it exports). Agent
# roles fall back to `agent_provider`, and a Codex role runs `codex_model` at `codex_effort`.
AGENT = ("agent_provider", "codex_model", "codex_effort", "harness_model")
SETTINGS = {
    "ingest": ("image_provider", "image_model", "dino_model", "dino_embed_model", "chair_judge_model"),
    # Classification, procedural objects, and chair QC's regenerated references.
    "reconstruct": (*AGENT, "procedural_provider", "procedural_model", "image_provider", "image_model"),
    # Authoring and its refine/materials/quality passes.
    "author": (*AGENT, "author_provider", "refine_provider", "materials_provider", "quality_provider"),
}


def _files(path: Path) -> dict:
    if path.is_file():
        return {path.name: artifact_cache.file_hash(path)}
    if not path.is_dir():
        return {"missing": True}
    return {str(p.relative_to(path)): artifact_cache.file_hash(p)
            for p in sorted(path.rglob("*")) if p.is_file()
            and not any(part.startswith((".", "_")) for part in p.relative_to(path).parts)}


def _key(context: RunContext, path: Path) -> str:
    try:
        return str(path.relative_to(context.scene_dir))
    except ValueError:
        return path.name  # the capture lives beside the job, not inside it


def input_fingerprint(context: RunContext, stage: str, options: dict) -> str:
    work = context.object_root / "object_init"
    simulation_room = context.seed_room if options.get("from_seed") else context.authored_room
    simulation_preview = (context.seed_room.parent / "room_preview" if options.get("from_seed")
                          else context.preview_dir)
    inputs = {
        "ingest": [context.capture_dir],
        # What reconstruct reads from ingest: object/opening refs, the chair grouping and the chair
        # references TRELLIS builds from. Chair QC regenerates a failing chair's reference, but
        # the stage's fingerprint is taken again when it ends, so only a kill in between restarts.
        "reconstruct": [work / "object_refs", work / "opening_refs", *[
            work / "chair_clusters" / context.scan / name for name in
            ("chair_clusters.json", "references", "nano_banana_normalized_1024")]],
        "seed": [context.object_root / "reconstructed_objs", work / "input" / "scene_data"],
        # Not surface_ref: author writes it, and a killed first run must resume, not restart.
        "author": [context.seed_room, context.capture_dir],
        "publish": [context.authored_room],
        "simulate": [simulation_room, *[simulation_preview / name for name in
                      ("Room.glb", "room_layout.json", "manifest.json")]],
    }
    if stage not in inputs:
        raise ValueError(f"unknown pipeline stage: {stage}")
    return artifact_cache.fingerprint({
        "version": 2, "stage": stage,
        "inputs": {_key(context, path): _files(path) for path in inputs[stage]},
        "settings": {key: getattr(context.settings, key) for key in SETTINGS.get(stage, ())},
    })
