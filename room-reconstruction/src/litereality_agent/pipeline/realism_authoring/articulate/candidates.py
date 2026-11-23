"""Which objects the articulation pass asks about.

Pure functions over `room_layout.json`; nothing here opens Blender or calls a model.

A candidate is a piece of furniture or a thing in the room that could have parts a person opens:
not the room shell, not a door or window (the reconstruction already hinges those), not a fixed
installation, not an accessory hung on another object (a coat on a door, a cable on a monitor),
and not something so small that an opening part would not matter in a room editor. Objects that
already have joints stay candidates: Astra is told which parts move and is asked only for the
missing ones (an office desk whose top lifts but whose drawers do not open).
"""

from __future__ import annotations

from litereality_agent.pipeline.realism_authoring.small_objects.candidates import (
    FIXED,
    OPENINGS,
    STRUCTURE,
    label,
)

ACCESSORIES = {"cable", "environment", "shelf_brackets", "bookends", "curtain", "trim",
               "electrical_trunking", "boxed_services"}
MIN_SIZE = 0.2  # metres along the longest side


def is_candidate(item: dict, objects: dict[str, dict]) -> bool:
    category = item["category"]
    if item.get("small_marker") or category in STRUCTURE | OPENINGS | FIXED | ACCESSORIES:
        return False
    if max(h - lo for lo, h in zip(item["bbox_min"], item["bbox_max"])) < MIN_SIZE:
        return False
    mount = objects.get(item.get("attached_to") or "")
    return not (mount and mount["category"] not in STRUCTURE)


def find_candidates(layout: dict) -> list[dict]:
    objects = {item["id"]: item for item in layout["objects"]}
    result = []
    for oid in sorted(objects):
        item = objects[oid]
        if not is_candidate(item, objects):
            continue
        low, high = item["bbox_min"], item["bbox_max"]
        result.append({
            "id": oid,
            "label": label(oid),
            "category": item["category"],
            "members": [oid],
            "bbox_min": [round(v, 4) for v in low],
            "bbox_max": [round(v, 4) for v in high],
            "size": [round(h - lo, 4) for lo, h in zip(low, high)],
            "rests_on": item.get("rests_on"),
            "attached_to": item.get("attached_to"),
            "rebuilt": item.get("rebuilt") or ("asset" if item.get("source_glb") else None),
        })
    return result
