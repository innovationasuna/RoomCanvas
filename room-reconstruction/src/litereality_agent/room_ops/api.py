"""Scene-definition and compilation API for LiteReality-Agent.

A room is defined by a compact, editable **program**: `Room.py` (the assembler + a semantic
SHELL) plus per-object `object.py`/GLBs and a manifest. `room_ops` is the library that
(a) **exports** that definition from a scan and (b) **compiles** it to a previewable `room.glb`.
It's the room analog of an SDK + compiler — `Room.py` is authored against it, and it builds the
artifact. This is the one place scene definition lives.

LAYER 2 — a library used by scene_init, authoring and scripts/ops. It should depend on
nothing else in this repo.

ONE tool, two consumers:
  • `scene_init`       — exports the SEED `Room.py` + builds the first `room.glb` (once)
  • `authoring`        — re-compiles the agent's edited `Room.py` → `room.glb` EVERY loop iteration

Public API (everything else — export_room, build_room, wall_*, materials… — stays importable):
    export_scene(scan)              scan → Room/<scan>/   (Room.py + SHELL + manifest)
    compile_room(room_dir)          Room.py → <preview>/Room.glb   (assemble in Blender, baked)
    bake_room(blend, glb)           bake SHELL node materials into the glb (faithful preview)
    compress.compressed(glb, out)   Room.glb → the Draco copy `litereality view` serves

`build_from_room` / `bake_glb` spawn Blender, so they run as subprocesses; the helpers wrap them.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

_HERE = Path(__file__).resolve().parent

__all__ = ["export_scene", "compile_room", "bake_room", "blender_bin"]


def blender_bin() -> str:
    """Resolve the Blender executable through the room-ops path configuration.

    This used to fall back to the bare string `"blender"`, which is not a path: with Blender
    installed as a macOS app bundle and nothing on PATH, `subprocess.run` raised
    `FileNotFoundError: 'blender'` from inside the bake, *after* the room had already compiled.
    `$LR_BLENDER` is kept as an accepted spelling for callers that used it.
    """
    v = os.environ.get("LR_BLENDER", "").strip()
    if v:
        return str(Path(v) / "blender") if Path(v).is_dir() else v
    from litereality_agent.room_ops.paths import find_blender

    return find_blender()


def export_scene(scan: str, out_root: "Path | None" = None) -> "Path | None":
    """scan → `Room/<scan>/` definition (Room.py + SHELL + manifest). Returns the Room dir."""
    from litereality_agent.room_ops.export import export_room

    return export_room.export(scan, out_root)


def compile_room(
    room_dir,
    out_dir=None,
    *,
    bake: bool = True,
    blender: "str | None" = None,
    regenerate: bool = False,
) -> "Path | None":
    """Compile a `Room/` definition → `Room.glb` (the scene-definition compiler).

    Runs `build_from_room` (materialize each object.py + assemble the SHELL in Blender), then
    optionally `bake_room` (flatten node-graph SHELL materials so the glb == the render). Returns
    the `Room.glb` path, or None if assembly or the requested bake failed.
    """
    room_dir = Path(room_dir)
    default_preview = room_dir.parent / "room_preview"
    preview = Path(out_dir) if out_dir else default_preview
    if preview.resolve() == default_preview.resolve():
        # Direct callers (including the live unbaked preview) can replace the tool's output.
        (room_dir / ".compile_stamp").unlink(missing_ok=True)
    blend = preview / "Room.blend"
    cmd = [sys.executable, "-m", "litereality_agent.room_ops.compile.build_from_room", "--room", str(room_dir)]
    if bake:
        cmd.append("--require-blend")
    if out_dir:
        cmd += ["--out", str(out_dir)]
    if regenerate:
        cmd.append("--regenerate")
    if subprocess.run(cmd).returncode != 0:
        return None
    glb = preview / "Room.glb"
    if not glb.is_file() or not glb.stat().st_size:
        return None
    if bake:
        rc = bake_room(blend, glb, blender=blender, required=True)
        if rc:
            print(f"Material bake failed (exit {rc}); see {preview / 'bake.log'}", file=sys.stderr)
            return None
    _record_build(room_dir, glb)
    return glb


SEED_GLB = "scene_init/scene_stage/room_init/room_preview/Room.glb"


def _glb_tree(path) -> dict:
    """{node name: parent name or None} from a GLB's JSON chunk (no mesh data is read)."""
    import json
    import struct

    with open(path, "rb") as f:
        length = struct.unpack("<I", f.read(20)[12:16])[0]
        nodes = json.loads(f.read(length)).get("nodes", [])
    parent = {c: k for k, node in enumerate(nodes) for c in node.get("children", [])}
    return {node.get("name"): (nodes[parent[k]].get("name") if k in parent else None)
            for k, node in enumerate(nodes) if node.get("name")}


def _record_build(room_dir: Path, glb: Path) -> None:
    """Trace the parts a build of the authored room has beyond the seed room, so the replay can show
    each part from the first build that contains it. Only for <scene>/realism_authoring/room."""
    room_dir = Path(room_dir).absolute()
    if room_dir.parent.name != "realism_authoring":
        return
    scene = room_dir.parent.parent
    try:
        from litereality_agent import telemetry

        before, after = _glb_tree(scene / SEED_GLB), _glb_tree(glb)
        added = sorted(n for n, p in after.items() if n not in before and (p is None or p in before))
        telemetry.record_artifact(scene / "scene_init" / "obj_stage" / "traces", "room_built", glb,
                                  at=Path(glb).stat().st_mtime, added=added,
                                  path=str(Path(glb).relative_to(scene)))
    except Exception:  # noqa: BLE001 — a replay record never fails a build
        pass


def bake_room(blend, glb, *, blender: "str | None" = None, resolution: int = 1024,
              required: bool = False) -> int:
    """Bake a preview from its .blend. Required callers check freshness at assembly time.

    A standalone bake of a legacy preview without a .blend is an optional no-op.
    """
    blend, glb = Path(blend), Path(glb)
    log_path = glb.parent / "bake.log"
    if not blend.is_file() or (required and not blend.stat().st_size):
        if required:
            log_path.write_text(f"Required bake input missing or empty: {blend}\n")
            return 1
        return 0
    # Blender's bake floods stdout with per-object `Fra: … | Updating Images | Loading bake_…`
    # progress. bake_room runs on EVERY `compile` the authoring/materials agent makes, so if that
    # inherits the parent stdout it drowns the step log (authoring.log hit 164 MB this way). Route
    # it to a sibling bake.log — same precedent as the render engine's render.log — so the step log
    # stays readable and the bake output is still there to inspect on failure.
    with tempfile.TemporaryDirectory(dir=glb.parent, prefix=".bake-") as folder, log_path.open("w") as log:
        baked = Path(folder) / glb.name
        rc = subprocess.run(
            [
                blender or blender_bin(),
                "-b",
                str(blend),
                "--python-exit-code",
                "1",
                "--python",
                str(_HERE / "compile" / "bake_glb.py"),
                "--",
                str(baked),
                str(resolution),
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
        ).returncode
        if rc:
            return rc
        if not baked.is_file() or not baked.stat().st_size:
            print(f"Blender produced no baked {glb.name}", file=log)
            return 1
        baked.replace(glb)
        from litereality_agent.room_ops.compile.records import record_compilation

        record_compilation(glb, "baked")
        return 0
