"""Read a room GLB with trimesh without letting a node named `world` take the scene over.

trimesh names the root of every scene it loads `world` and does not rename a glTF node of that name
(`exchange/gltf`: "we may stomp on it"): the node and the root become one frame, and every object
then hangs from wherever that node was. TRELLIS meshes carry such a node (their root empty), so a
room with one imported as it was, e.g. a rebuilt small object, read as chairs a metre in the air
and outside the room, though the file itself is right. `load` reads such a file with the node
renamed (in memory; the file is not changed); any other file is loaded as it is.
"""

from __future__ import annotations

import io
import json
import struct
from pathlib import Path

ROOT = "world"  # trimesh's base frame


def renamed(data: bytes) -> bytes | None:
    """The GLB with its nodes named `world` renamed, or None if it has none (or is not a GLB)."""
    if data[:4] != b"glTF" or len(data) < 20:
        return None
    length, kind = struct.unpack("<II", data[12:20])
    if kind != 0x4E4F534A:
        return None
    doc = json.loads(data[20:20 + length])
    nodes = doc.get("nodes", [])
    taken = {node.get("name") for node in nodes}
    hits = [node for node in nodes if node.get("name") == ROOT]
    if not hits:
        return None
    for k, node in enumerate(hits):
        name = f"{ROOT}_node{k or ''}"
        while name in taken:
            name += "_"
        node["name"] = name
        taken.add(name)
    chunk = json.dumps(doc, separators=(",", ":")).encode()
    chunk += b" " * (-len(chunk) % 4)
    rest = data[20 + length:]
    return (struct.pack("<4sII", b"glTF", 2, 20 + len(chunk) + len(rest))
            + struct.pack("<II", len(chunk), 0x4E4F534A) + chunk + rest)


def load(path, **kwargs):
    """trimesh.load of a GLB (other files as they are), a `world` node renamed first."""
    import trimesh

    path = Path(path)
    if path.suffix.lower() == ".glb":
        fixed = renamed(path.read_bytes())
        if fixed is not None:
            return trimesh.load(io.BytesIO(fixed), file_type="glb", **kwargs)
    return trimesh.load(str(path), **kwargs)
