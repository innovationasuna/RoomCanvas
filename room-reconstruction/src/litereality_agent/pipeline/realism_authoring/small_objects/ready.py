"""The operator's small-object models made up front (premake), handed to the author session to place.

With LR_SMALL_OBJECTS_MODELS=<dir> (premake's output: <Kind>.glb, its <Kind>.json receipt and
work/<Kind>/reference.png), each usable model is copied into the room as Models/<Kind>.glb before the
session, and the brief lists them: the session puts each one where the photographs show it with
`RoomScene.place_model` instead of marking a stand-in for the pass to swap. A model put in that
way has a `source_glb`, so the small-object pass after the session leaves it alone; a thing the
session still marked (`RoomScene.mark_small`) or built itself stays a candidate and gets its
model by name as before (run.Pass.model).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from litereality_agent import artifact_cache as cache

FOLDER = "Models"  # in the room: Room.py names the models it places by this relative path
SOURCES = ".sources.json"

PROMPT = """\
READY MODELS for small things in this room are in `{folder}/`, made up front from the operator's
close-ups. Put each one where the photographs show it, in Room.py:
    scene.place_model("<Kind>0", "{folder}/<Kind>.glb", bottom=(x, y, z), size=..., yaw_deg=...,
                      rests_on="<support>")
For a fixed wall light, give its category and the wall it hangs on:
    scene.place_model("WallLamp0", "{folder}/WallLamp.glb", bottom=(x, y, z), size=(w, d, h),
                      yaw_deg=yaw, category="luminaire", attached_to="Wall0")
`bottom` is the centre of its underside on the measured surface; `size` its measured (width,
depth, height), or only its height to keep the model's proportions; `yaw_deg` turns its front
(-Y) the way it faces in the photographs. Name the copies <Kind>, <Kind>0, <Kind>1 ... Use these
listed models for new placements, with `rests_on` for loose objects or `attached_to` for fixed
fixtures. Mark small things without a listed model: `scene.mark_small("<Kind>0", ...)`, one
box at the measured place and size; after your session a pass rebuilds them from the
photographs.
{rows}
"""


def root() -> Path | None:
    """The folder LR_SMALL_OBJECTS_MODELS names, resolved; None when unset."""
    value = os.environ.get("LR_SMALL_OBJECTS_MODELS", "").strip()
    if not value:
        return None
    folder = Path(value).expanduser().resolve()
    if not folder.is_dir():
        raise FileNotFoundError(f"LR_SMALL_OBJECTS_MODELS={value} is not a directory")
    return folder


def describe(glb: Path, folder: Path, *, mesh: Path | None = None) -> dict:
    """What the brief says about one model (its copy in the room): its proportions, what it is and
    its reference image (beside its source in `folder`)."""
    from litereality_agent.room_ops import glb as room_glb

    # glTF is Y-up: Blender's width, depth and height are x, z and y here. A TRELLIS model's root
    # is a node named `world`, which trimesh would read as its own root (room_ops/glb).
    x, y, z = room_glb.load(mesh or glb, force="scene", skip_materials=True).extents
    receipt = cache.read_json(folder / f"{glb.stem}.json")
    inputs = receipt.get("inputs") if isinstance(receipt, dict) else None
    reference = folder / "work" / glb.stem / "reference.png"
    return {"kind": glb.stem, "glb": f"{FOLDER}/{glb.name}",
            "proportions": [round(float(v / max(y, 1e-9)), 2) for v in (x, z, y)],
            "description": (inputs or {}).get("description"),
            "reference": str(reference) if reference.is_file() else None}


def stage(room: Path) -> list[dict]:
    """Copy the models into room/Models/ without their loose pieces (rebuild.drop_fragments; one
    whose source changed is copied again) and describe them; [] when there are none. A copy the
    session already placed stays, so its Room.py still builds."""
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    folder = root()
    if folder is None:
        return []
    rows = []
    available = {}
    sources = room / FOLDER / SOURCES  # which source each copy was made from
    made = cache.read_json(sources) if sources.is_file() else {}
    made = made if isinstance(made, dict) else {}
    for glb in sorted(p for p in folder.glob("*.glb") if not p.name.startswith(".")):
        target = room / FOLDER / glb.name
        try:
            key = cache.file_hash(glb)
            if key is None:
                raise FileNotFoundError(glb)
            if target.is_file() and made.get(glb.name) == key:
                try:
                    rows.append(describe(target, folder))
                    available[glb.name] = key
                    continue
                except Exception:
                    pass  # rebuild an unreadable room copy from its source
            target.parent.mkdir(exist_ok=True)
            part = target.with_name(f".{glb.stem}.part.glb")
            try:
                rebuild.drop_fragments(glb, part)
                row = describe(target, folder, mesh=part)
                part.replace(target)
            finally:
                part.unlink(missing_ok=True)
        except Exception as exc:
            print(f"[ready-models] skipping {glb.name}: {type(exc).__name__}: {exc}",
                  file=sys.stderr, flush=True)
            continue
        available[glb.name] = key
        rows.append(row)
    cache.atomic_json(sources, available)
    return rows


def prompt(rows: list[dict]) -> str:
    """The brief's paragraph for these models ("" without any)."""
    if not rows:
        return ""
    lines = []
    for row in rows:
        w, d, h = row["proportions"]
        line = f"  {row['glb']}: {row['description'] or row['kind']}; width:depth:height {w}:{d}:{h}"
        if row["reference"]:
            line += f"; looks like {row['reference']}"
        lines.append(line)
    return PROMPT.format(folder=FOLDER, rows="\n".join(lines))
