"""The URDF of an object's new joints, in the form the web editor reads (web/scripts/room_objects.py).

The base link is the object's hinge frame (`<id>_Hinges` in Room.glb: the object's origin and
turn in the room, unscaled, Z up). Each cut part is a link named like its Room.glb node, whose
origin is the joint's origin in that frame, so `xyz` here equals the node's translation there.
Only the joints are recorded: inertia and collision stay with the physics export of the
reconstruction, which this pass does not rebuild.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path


def _fmt(values) -> str:
    return " ".join(f"{float(v):.6g}" for v in values)


def part_node(object_id: str, part: str) -> str:
    return f"{object_id}_{part}"


def hinge_frame(object_id: str) -> str:
    return f"{object_id}_Hinges"


def to_urdf(object_id: str, parts: list[dict]) -> str:
    robot = ET.Element("robot", name=object_id)
    ET.SubElement(robot, "link", name=hinge_frame(object_id))
    for part in parts:
        child = part_node(object_id, part["name"])
        ET.SubElement(robot, "link", name=child)
        joint = ET.SubElement(robot, "joint", name=f"{child}_joint", type=part["joint"])
        ET.SubElement(joint, "parent", link=hinge_frame(object_id))
        ET.SubElement(joint, "child", link=child)
        ET.SubElement(joint, "origin", xyz=_fmt(part["origin"]), rpy="0 0 0")
        ET.SubElement(joint, "axis", xyz=_fmt(part["axis"]))
        ET.SubElement(joint, "limit", lower="0", upper=f"{float(part['limit']):.6g}",
                      effort="10", velocity="1")
    ET.indent(robot)
    return ET.tostring(robot, encoding="unicode") + "\n"


def write(object_id: str, parts: list[dict], objects_dir: Path) -> Path:
    """<objects_dir>/Articulated/<id>/sim/<id>.urdf — the layout room_objects.py globs."""
    path = Path(objects_dir) / "Articulated" / object_id / "sim" / f"{object_id}.urdf"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(to_urdf(object_id, parts))
    return path
