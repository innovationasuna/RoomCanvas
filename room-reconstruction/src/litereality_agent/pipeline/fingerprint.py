"""Stable stage input identities; timestamps never prove that content is unchanged.

An identity covers the content a stage reads and the model settings it consumes. It leaves out
the stage's own outputs, its options (the runner compares those itself), source code and where
the job directory lives: a mismatch makes the stage start over, so anything hashed here that does
not decide the result becomes a paid rerun.
"""

from pathlib import Path

from litereality_agent import artifact_cache
from litereality_agent.pipeline.context import RunContext

SETTINGS = {
    "ingest": ("image_provider", "image_model", "dino_model"),
    "reconstruct": ("harness_model", "procedural_model"),
    "author": ("agent_provider", "author_provider", "codex_model", "harness_model", "image_model"),
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
        # Classifier writes routing inside work and chair QC regenerates chair references, so
        # hash only evidence ingest alone writes: object/opening refs and the chair grouping.
        "reconstruct": [work / "object_refs", work / "opening_refs",
                        work / "chair_clusters" / context.scan / "chair_clusters.json"],
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
