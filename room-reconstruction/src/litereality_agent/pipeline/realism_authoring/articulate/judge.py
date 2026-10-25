"""What Astra is asked about each object, and how its answers become a cutting plan.

Two read-only image questions per object, through `ask_images` (the `agent` role: Codex / GPT-6
Astra):

1. decide: does the real object have parts that open, and where are they in the model? Asked on
   metric orthographic renders of the model alone, beside photos of the real thing. This is the
   piano trial's method 2 (2026-10-19) with the object left open instead of fixed to a piano.
2. check: after the cut, the model closed and opened beside a photo; each part is kept only if
   it opens like the real one. A part that opens wrongly is worse than one that does not open.

Coordinates are the object's own frame: its origin and turn in the room, metres, Z up. The cut
is an axis-aligned box in that frame, so every hinge and slide is snapped to one of its axes.
"""

from __future__ import annotations

import math
import re

from litereality_agent.pipeline.realism_authoring.small_objects.judge import parse_json

MAX_PARTS = 8
SNAP = 0.9  # an axis whose largest component is below this is not along a box axis
SNAP_EDGE, EDGE = 0.015, 0.01  # metres: a box edge this near the object's outside goes past it

DECIDE = """\
One object in a 3D reconstruction of a real room: "{label}" (id {id}, category {category}),
about {size} metres (width x depth x height). We want the parts of it that open in real life
(hinged doors, drawers, lids, a laptop screen, a fallboard, flaps) to open in a room editor too,
by cutting them out of the CURRENT 3D MODEL and putting them on hinges or slides.

IMAGE 1 is an orthographic render of the model alone, looking along +Y: X to the right, Z up.
IMAGE 2 looks along +X: the horizontal axis is Y (labelled on the grid), Z up. Both carry a grid
in metres in the object's own frame; the model lies in X {x0:.3f}..{x1:.3f}, Y {y0:.3f}..{y1:.3f},
Z {z0:.3f}..{z1:.3f}. IMAGE 3 shows the model in perspective from its four diagonals (which
side is its front is for you to see). The remaining images are real photos of this object.{existing}

Decide from the PHOTOS whether the real object has parts a person opens. Fixed panels, open
shelves, cushions, decorations and anything you cannot see clearly do not count, nor do caps,
stoppers and covers that come off rather than open on the object (a bottle cap, a pen cap). For each part
that does open, look at where it is IN THE MODEL; if the model has no surface for it that a box
could cut out (a solid lump, a smooth blob where the part should be), set "found": false rather
than guessing.

For each found part give:
- "box_min", "box_max": an axis-aligned box in the object's frame that contains EVERYTHING that
  moves with the part (a laptop lid with the screen on its inside, a door with its handle, a
  drawer front with its handle) and as little of the rest as possible;
- "joint": "revolute" (it swings) or "prismatic" (it slides, like a drawer);
- revolute: "hinge_point" on the hinge line, "hinge_axis" along it, "open_degrees" > 0. Rotation
  follows the right-hand rule about hinge_axis: choose the axis sign so that turning by
  +open_degrees opens the part outward, away from the body (a lid hinged along X at its back
  that lifts its front edge turns about [-1, 0, 0]);
- prismatic: "slide_axis" pointing out of the body, "travel_m" > 0;
- "pose_in_model": "closed" or "open"; if open, "open_now" is how far it is open now (degrees
  or metres along the same axis), and the cut part is first moved back to closed;
- "covers_opening": true when, closed, the part covers a hollow in the body that shows once it
  opens (a drawer front, a cabinet door, a piano lid); false when nothing is behind it (a
  laptop screen, a flap).

At most {max_parts} parts. Name each with a short English word and a number (Door_1, Drawer_2,
Lid_1, Screen_1).

Answer with JSON only:
{{"openable": true | false, "reason": "<one sentence>",
  "parts": [{{"name": "Drawer_1", "found": true, "joint": "prismatic",
    "box_min": [x, y, z], "box_max": [x, y, z], "slide_axis": [x, y, z], "travel_m": 0.3,
    "pose_in_model": "closed", "covers_opening": true, "reason": "<one sentence>"}},
   {{"name": "Door_1", "found": true, "joint": "revolute", "box_min": [...], "box_max": [...],
    "hinge_point": [x, y, z], "hinge_axis": [x, y, z], "open_degrees": 90,
    "pose_in_model": "closed", "covers_opening": true, "reason": "..."}}]}}"""

EXISTING = """
These parts of the model already open and must not be listed again: {names}."""

CHECK = """\
We cut parts out of a 3D model of "{label}" (id {id}, category {category}) and put them on
hinges or slides: {parts}. IMAGE 1 shows the model CLOSED from its four diagonals, IMAGE 2 the
same four views fully OPENED (the front may be on any side).
The remaining images are photos of the real object.

For each part, keep it only if, opened, it moves like that part of the real object (the right
panel, hinged on the right edge or sliding the right way, by a plausible amount) and nothing
looks broken: no large piece of the body torn off with it, no part flying through the body or
off into the room. Some roughness at the cut edges is fine. A part that opens wrongly is worse
than one that does not open.

Answer with JSON only:
{{"parts": {{"<name>": {{"keep": true | false, "reason": "<one sentence>"}}}}}}"""


def _fmt(values) -> str:
    return " x ".join(f"{v:.2f}" for v in values)


def decide_prompt(item: dict, box: dict, existing: list[str]) -> str:
    (x0, y0, z0), (x1, y1, z1) = box["min"], box["max"]
    return DECIDE.format(label=item["label"], id=item["id"], category=item["category"],
                         size=_fmt(item["size"]), x0=x0, x1=x1, y0=y0, y1=y1, z0=z0, z1=z1,
                         existing=EXISTING.format(names=", ".join(existing)) if existing else "",
                         max_parts=MAX_PARTS)


def check_prompt(item: dict, parts: list[dict]) -> str:
    described = "; ".join(
        f"{p['name']} ({'swings' if p['joint'] == 'revolute' else 'slides'})" for p in parts)
    return CHECK.format(label=item["label"], id=item["id"], category=item["category"],
                        parts=described)


def snap(vector) -> list[float] | None:
    """The box axis a direction lies along, signed, or None if it lies along none of them."""
    values = [float(v) for v in vector]
    length = math.sqrt(sum(v * v for v in values))
    if len(values) != 3 or length < 1e-9:
        return None
    k = max(range(3), key=lambda i: abs(values[i]))
    if abs(values[k]) / length < SNAP:
        return None
    return [0.0 if i != k else math.copysign(1.0, values[k]) for i in range(3)]


def _point(value) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return None
    try:
        point = [float(v) for v in value]
    except (TypeError, ValueError):
        return None
    return point if all(math.isfinite(v) for v in point) else None


def _name(raw: str, used: set[str]) -> str:
    name = re.sub(r"[^A-Za-z0-9]+", "_", str(raw)).strip("_")[:24] or "Part"
    candidate, n = name, 2
    while candidate in used:
        candidate, n = f"{name}_{n}", n + 1
    used.add(candidate)
    return candidate


def parse_plan(text: str, box: dict, margin: float = 0.05) -> dict:
    """Astra's answer → the parts to cut, each checked against the object's box.

    A part is dropped, with the reason kept, when it was not found in the model, its box is
    empty or outside the object, or its hinge or slide does not lie along a box axis."""
    answer = parse_json(text)
    lo = [v - margin for v in box["min"]]
    hi = [v + margin for v in box["max"]]
    size = max(h - lo_ for lo_, h in zip(box["min"], box["max"]))
    parts, rejected, used = [], [], set()
    for raw in (answer.get("parts") or [])[:MAX_PARTS]:
        if not isinstance(raw, dict):
            continue
        name = _name(raw.get("name", "Part"), used)

        def reject(reason, name=name):
            rejected.append({"name": name, "reason": reason})

        if raw.get("found") is False:
            reject("not in the model: " + str(raw.get("reason", "")))
            continue
        low, high = _point(raw.get("box_min")), _point(raw.get("box_max"))
        if not low or not high:
            reject("no box")
            continue
        # Read off a grid, a box is good to about a centimetre: an edge that close to the
        # object's outside goes past it, or a sliver of the part stays behind on the body.
        low = [box["min"][i] - EDGE if abs(low[i] - box["min"][i]) < SNAP_EDGE else max(low[i], lo[i])
               for i in range(3)]
        high = [box["max"][i] + EDGE if abs(high[i] - box["max"][i]) < SNAP_EDGE else min(high[i], hi[i])
                for i in range(3)]
        if any(h - lo_ < 0.002 for lo_, h in zip(low, high)):
            reject("box empty or outside the object")
            continue
        joint = str(raw.get("joint", "")).lower()
        part = {"name": name, "joint": joint, "box_min": low, "box_max": high,
                "covers_opening": raw.get("covers_opening") is not False,
                "reason": str(raw.get("reason", ""))}
        pose_open = str(raw.get("pose_in_model", "closed")).lower() == "open"
        try:
            open_now = float(raw.get("open_now") or 0) if pose_open else 0.0
        except (TypeError, ValueError):
            open_now = 0.0
        if joint == "revolute":
            axis, hinge = snap(raw.get("hinge_axis") or []), _point(raw.get("hinge_point"))
            try:
                degrees = float(raw.get("open_degrees"))
            except (TypeError, ValueError):
                degrees = 0.0
            if axis is None or hinge is None or not 0 < degrees <= 180:
                reject("hinge not along a box axis, or no opening angle")
                continue
            part.update(axis=axis, origin=hinge, limit=math.radians(degrees),
                        open_now=math.radians(min(max(open_now, 0.0), degrees)))
        elif joint == "prismatic":
            axis = snap(raw.get("slide_axis") or [])
            try:
                travel = float(raw.get("travel_m"))
            except (TypeError, ValueError):
                travel = 0.0
            if axis is None or not 0 < travel <= 1.5 * size:
                reject("slide not along a box axis, or no travel")
                continue
            centre = [(a + b) / 2 for a, b in zip(low, high)]
            part.update(axis=axis, origin=centre, limit=travel,
                        open_now=min(max(open_now, 0.0), travel))
        else:
            reject(f"unknown joint {joint!r}")
            continue
        parts.append(part)
    return {"openable": bool(answer.get("openable")) and bool(parts),
            "reason": str(answer.get("reason", "")), "parts": parts, "rejected": rejected}


def parse_check(text: str, names: list[str]) -> dict[str, dict]:
    """Per part: keep or not, with the reason. A part the answer leaves out is not kept."""
    answer = parse_json(text).get("parts") or {}
    verdicts = {}
    for name in names:
        row = answer.get(name) if isinstance(answer, dict) else None
        keep = isinstance(row, dict) and row.get("keep") is True
        verdicts[name] = {"keep": keep, "reason": str((row or {}).get("reason", "not answered"))}
    return verdicts
