"""Assemble reconstructed assets into the editable seed scene."""

from pathlib import Path

from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.result import StageResult, StageStatus


def saved(context: RunContext, model: str, glb: Path, **data) -> None:
    """Record when a room model the replay shows was written (seed / round / final)."""
    from litereality_agent import telemetry

    if glb.is_file():
        telemetry.record(context.object_root / "traces", "model_saved", at=glb.stat().st_mtime,
                         model=model, path=str(glb.relative_to(context.scene_dir)), **data)


def complete(context: RunContext) -> bool:
    return (context.seed_room / "Room.py").is_file() and (context.scene_dir / "scene.json").is_file()


def run(context: RunContext, options: dict) -> StageResult:
    from litereality_agent.pipeline.scene_init import paths
    from litereality_agent.pipeline.scene_init.artifacts import ensure_stage_links, finalize
    from litereality_agent.room_ops import compile_room, export_scene

    ensure_stage_links(context.scan)
    paths.set_scan(context.scan)
    room = export_scene(context.scan)
    if room is None or not (Path(room) / "Room.py").is_file():
        return StageResult("seed", StageStatus.FAILED, error="seed export did not produce Room.py")
    artifacts = {"room": str(room)}
    warnings: list[str] = []
    if options.get("preview", True):
        try:
            preview = compile_room(Path(room), bake=True)
            if preview:
                artifacts["preview"] = str(preview)
                saved(context, "seed", context.seed_room.parent / "room_preview" / "Room.glb")
        except Exception as exc:
            warnings.append(f"seed preview unavailable: {exc}")
    package = finalize(context.scan, capture_mode=options.get("capture_mode", "link"))
    artifacts["manifest"] = str(package.manifest)
    return StageResult("seed", StageStatus.COMPLETED, artifacts=artifacts, warnings=warnings)
