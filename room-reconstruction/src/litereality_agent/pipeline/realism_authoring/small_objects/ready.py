"""The operator's small-object models made up front (premake), handed to the author session to place.

With LR_SMALL_OBJECTS_MODELS=<dir> (premake's output: <Kind>.glb, its <Kind>.json receipt and
work/<Kind>/reference.png), every model is copied into the room as Models/<Kind>.glb before the
session, and the brief lists them: the session puts each one where the photographs show it with
`RoomScene.place_model` instead of building a stand-in for the pass to swap. A model put in that
way has a `source_glb`, so the small-object pass after the session leaves it alone; a thing the
session still built itself stays a candidate and gets its model by name as before (run.Pass.model).
"""

from __future__ import annotations

import os
from pathlib import Path

import litereality_agent
from litereality_agent import artifact_cache as cache

FOLDER = "Models"  # in the room: Room.py names the models it places by this relative path
TEMPLATE = Path(litereality_agent.__file__).parent / "room_ops" / "compile" / "build_room.py"

PROMPT = """\
READY MODELS for small things in this room are in `{folder}/`, made up front from the operator's
close-ups. Put each one where the photographs show it, in Room.py:
    scene.place_model("<Kind>0", "{folder}/<Kind>.glb", bottom=(x, y, z), size=..., yaw_deg=...,
                      rests_on="<support>")
`bottom` is the centre of its underside on the measured surface; `size` its measured (width,
depth, height), or only its height to keep the model's proportions; `yaw_deg` turns its front
(-Y) the way it faces in the photographs. Name the copies <Kind>, <Kind>0, <Kind>1 ... Use these
models rather than building those things from primitives, and declare their support like any
group. Small things without a model you build as usual: after your session a pass rebuilds them
from the photographs.{template}
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


def describe(glb: Path, folder: Path) -> dict:
    """What the brief says about one model (its copy in the room): its proportions, what it is and
    its reference image (beside its source in `folder`)."""
    from litereality_agent.room_ops import glb as room_glb

    # glTF is Y-up: Blender's width, depth and height are x, z and y here. A TRELLIS model's root
    # is a node named `world`, which trimesh would read as its own root (room_ops/glb).
    x, y, z = room_glb.load(glb, force="scene", skip_materials=True).extents
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
    sources = room / FOLDER / ".sources.json"  # which source each copy was made from
    made = cache.read_json(sources) if sources.is_file() else {}
    made = made if isinstance(made, dict) else {}
    for glb in sorted(p for p in folder.glob("*.glb") if not p.name.startswith(".")):
        target = room / FOLDER / glb.name
        key = cache.file_hash(glb)
        if not target.is_file() or made.get(glb.name) != key:
            target.parent.mkdir(exist_ok=True)
            part = target.with_name(f".{glb.stem}.part.glb")
            try:
                rebuild.drop_fragments(glb, part)
                part.replace(target)
            finally:
                part.unlink(missing_ok=True)
            made[glb.name] = key
            cache.atomic_json(sources, made)
        rows.append(describe(target, folder))
    return rows


def prompt(rows: list[dict], room: Path) -> str:
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
    try:
        current = "def place_model" in (room / "Room.py").read_text(encoding="utf-8")
    except OSError:
        current = True
    template = "" if current else (f" This Room.py predates `RoomScene.place_model`: copy that "
                                   f"method into it from {TEMPLATE}.")
    return PROMPT.format(folder=FOLDER, template=template, rows="\n".join(lines))
