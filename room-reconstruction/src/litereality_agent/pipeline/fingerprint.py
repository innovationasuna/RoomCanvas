"""Stable stage input identities; timestamps never prove that content is unchanged."""

from pathlib import Path

from litereality_agent import PACKAGE_ROOT, artifact_cache
from litereality_agent.pipeline.context import RunContext


def _files(path: Path) -> dict:
    if path.is_file():
        return {path.name: artifact_cache.file_hash(path)}
    if not path.is_dir():
        return {"missing": True}
    return {str(p.relative_to(path)): artifact_cache.file_hash(p)
            for p in sorted(path.rglob("*")) if p.is_file()
            and not any(part.startswith((".", "_")) for part in p.relative_to(path).parts)}


def input_fingerprint(context: RunContext, stage: str, options: dict) -> str:
    work = context.object_root / "object_init"
    simulation_room = context.seed_room if options.get("from_seed") else context.authored_room
    simulation_preview = (context.seed_room.parent / "room_preview" if options.get("from_seed")
                          else context.preview_dir)
    inputs = {
        "ingest": [context.capture_dir],
        # Classifier writes routing inside work; hash actual evidence, not its own output/logs.
        "reconstruct": [work / name for name in ("object_refs", "chair_clusters", "opening_refs")],
        "seed": [context.object_root / "reconstructed_objs", work / "input" / "scene_data"],
        "author": [context.seed_room, context.capture_dir, context.authoring_root / "surface_ref"],
        "publish": [context.authored_room],
        "simulate": [simulation_room, *[simulation_preview / name for name in
                      ("Room.glb", "room_layout.json", "manifest.json")]],
    }
    if stage not in inputs:
        raise ValueError(f"unknown pipeline stage: {stage}")
    model_config = {key: getattr(context.settings, key) for key in
                    ("agent_provider", "author_provider", "codex_model", "harness_model",
                     "procedural_model", "image_provider", "image_model", "dino_model")}
    return artifact_cache.fingerprint({
        "version": 1, "stage": stage, "options": {k: v for k, v in options.items() if k != "force"},
        "inputs": {str(path): _files(path) for path in inputs[stage]},
        "config": model_config,
        "code": {str(p.relative_to(PACKAGE_ROOT)): artifact_cache.file_hash(p)
                 for p in sorted(PACKAGE_ROOT.rglob("*.py")) if "__pycache__" not in p.parts},
    })
