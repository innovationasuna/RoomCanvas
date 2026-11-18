"""One publication recorder for direct CLI assembly and wrapped compilation."""
import os
from pathlib import Path

from litereality_agent import telemetry


def record_compilation(artifact: Path, phase: str) -> None:
    artifact = Path(artifact).resolve()
    configured = os.environ.get("LR_SCENE")
    roots = ([Path(configured).resolve()] if configured else []) + list(artifact.parents)
    for scene in roots:
        traces = scene / "scene_init/obj_stage/traces"
        if traces.is_dir() and artifact.is_relative_to(scene):
            telemetry.record_artifact(traces, "artifact_published", artifact,
                                      path=str(artifact.relative_to(scene)), phase=phase)
            return
