"""Which authored objects the small-object pass looks at, and which ones form one stack.

Pure functions over `room_layout.json`; nothing here opens Blender or calls a model.

A candidate is an object the author stage built from primitives that a person could pick up or
move: not the room shell, not a door or window, not a reconstructed asset (it already has a
`source_glb`), not a fixed installation (sockets, switches, lights, vents), not anything mounted
on a wall or the ceiling (curtains, pictures, wall shelves), and not furniture that holds other
things (`placeable_surface`). There is no size threshold; Astra decides per item. A box the author
marked with `RoomScene.mark_small` (`small_marker`) is always one: the author put it there for
this pass to rebuild, and only its rebuild or its removal is asked about (`marker`).

Objects stacked on each other (a pile of books, a loose score on the top book) are judged and
rebuilt as one item: an object that rests on another candidate and covers most of it, while
being at least a third of its area, joins its support's stack if both have the same marker status
and neither has a model supplied for that individual object.
"""

from __future__ import annotations

import re
from collections import Counter

SHELL = {"wall", "floor", "ceiling"}
OPENINGS = {"door", "window"}
STRUCTURE = SHELL | {"bulkhead", "boxed_services", "column", "beam"}
FIXED = {"socket", "switch", "light", "light_fixture", "vent", "detector", "panel", "radiator",
         "air_conditioner", "trim", "skirting", "trunking", "conduit", "ceiling_grid"}
STACK_COVER = 0.6  # the upper object lies at least this much inside its support's footprint
STACK_AREA = 0.3  # and is at least this fraction of the support's area


def footprint(item: dict) -> tuple[float, float, float, float]:
    (x0, y0, _), (x1, y1, _) = item["bbox_min"], item["bbox_max"]
    return x0, y0, x1, y1


def area(box) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def overlap(a, b) -> float:
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def is_candidate(item: dict, objects: dict[str, dict]) -> bool:
    if item.get("small_marker"):
        return True
    category = item["category"]
    if item.get("source_glb") or category in STRUCTURE | OPENINGS | FIXED:
        return False
    if item.get("placeable_surface"):
        return False
    mount = objects.get(item.get("attached_to") or "")
    return not (mount and mount["category"] in STRUCTURE)


def stacks_on(upper: dict, lower: dict) -> bool:
    a, b = footprint(upper), footprint(lower)
    if area(a) <= 0 or area(b) <= 0:
        return False
    return overlap(a, b) >= STACK_COVER * area(a) and area(a) >= STACK_AREA * area(b)


def label(name: str) -> str:
    """'StackedBook00' -> 'stacked book', for prompts and the detector."""
    words = re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z]+", re.sub(r"[\d_]+", " ", name))
    return " ".join(word.lower() for word in words) or name.lower()


def find_candidates(layout: dict, supplied: set[str] | None = None) -> list[dict]:
    """One entry per item to judge: a single object, or a stack named after its bottom object."""
    objects = {item["id"]: item for item in layout["objects"]}
    chosen = {oid: item for oid, item in objects.items() if is_candidate(item, objects)}
    below = {}
    for oid, item in chosen.items():
        support = item.get("rests_on")
        if supplied and (oid in supplied or support in supplied):
            continue
        if (support in chosen and bool(item.get("small_marker")) == bool(chosen[support].get("small_marker"))
                and stacks_on(item, chosen[support])):
            below[oid] = support

    def bottom(oid):
        seen = set()
        while oid in below and oid not in seen:
            seen.add(oid)
            oid = below[oid]
        return oid

    members: dict[str, list[str]] = {}
    for oid in chosen:
        members.setdefault(bottom(oid), []).append(oid)

    result = []
    for root in sorted(members):
        ids = sorted(members[root], key=lambda oid: (chosen[oid]["bbox_min"][2], oid))
        items = [chosen[oid] for oid in ids]
        low = [min(item["bbox_min"][k] for item in items) for k in range(3)]
        high = [max(item["bbox_max"][k] for item in items) for k in range(3)]
        categories = Counter(item["category"] for item in items)
        category = categories.most_common(1)[0][0]
        base = chosen[root]
        pose = base.get("marker_pose") if len(ids) == 1 else None
        result.append({
            "id": root,
            "label": label(root) if len(ids) == 1 else f"stack of {label(root).split()[-1]}s",
            "category": category,
            "members": ids,
            "bbox_min": [round(v, 4) for v in low],
            "bbox_max": [round(v, 4) for v in high],
            "size": pose["size"] if pose else [round(h - lo, 4) for lo, h in zip(low, high)],
            "rests_on": base.get("rests_on"),
            "attached_to": base.get("attached_to"),
            "support_part": base.get("support_part"),
            # Both always present, so an item that stops being a marker or changes its
            # description is not the same candidate any more (pass_cache.carry).
            "marker": bool(base.get("small_marker")),
            "marker_pose": pose,
            "description": "; ".join(item["description"] for item in items
                                     if item.get("description")),
        })
    return result
