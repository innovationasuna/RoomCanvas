"""A room GLB with a node named `world` (a TRELLIS mesh's root) is read as it is, not round it."""

import json
import struct

import numpy as np
import trimesh

from litereality_agent.room_ops import glb


def room(path):
    """A chair beside a plant whose imported root empty kept TRELLIS's name, `world`."""
    scene = trimesh.Scene()
    scene.graph.update(frame_to="Plant0", frame_from="world")
    scene.graph.update(frame_to="plant_root", frame_from="Plant0",
                       matrix=trimesh.transformations.scale_and_translate(0.5, (-3, 0, 0)))
    scene.add_geometry(trimesh.creation.box((1, 1, 1)), node_name="leaf", geom_name="leaf",
                       parent_node_name="plant_root")
    scene.graph.update(frame_to="Chair0", frame_from="world",
                       matrix=trimesh.transformations.translation_matrix((2, 0, 0)))
    scene.add_geometry(trimesh.creation.box((1, 1, 1)), node_name="seat", geom_name="seat",
                       parent_node_name="Chair0")
    data = scene.export(file_type="glb")
    length = struct.unpack("<I", data[12:16])[0]
    doc = json.loads(data[20:20 + length])
    for node in doc["nodes"]:  # the room's own root is no `world`; the plant's root empty is
        node["name"] = {"world": "Room", "plant_root": "world"}.get(node.get("name"), node.get("name"))
    chunk = json.dumps(doc).encode()
    chunk += b" " * (-len(chunk) % 4)
    rest = data[20 + length:]
    path.write_bytes(struct.pack("<4sII", b"glTF", 2, 20 + len(chunk) + len(rest))
                     + struct.pack("<II", len(chunk), 0x4E4F534A) + chunk + rest)
    return path


def seat(scene):
    node = next(n for n in scene.graph.nodes_geometry if scene.graph[n][1] == "seat")
    transform, name = scene.graph[node]
    return scene.geometry[name].copy().apply_transform(transform).bounds


def test_a_node_named_world_does_not_move_the_rest_of_the_room(tmp_path):
    path = room(tmp_path / "Room.glb")
    assert not np.allclose(seat(trimesh.load(str(path), force="scene")), [[1.5, -.5, -.5], [2.5, .5, .5]])
    assert np.allclose(seat(glb.load(path, force="scene")), [[1.5, -.5, -.5], [2.5, .5, .5]])
    assert glb.renamed(path.read_bytes()) is not None and b'"world_node"' in glb.renamed(path.read_bytes())
    assert glb.renamed(b"not a glb") is None
