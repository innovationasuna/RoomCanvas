"""The validation gate judges the CLAIMS the author made against the geometry the build wrote."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from litereality_agent.pipeline.room_qc import validate as V


def _obj(i, cat, mn, mx, **kw):
    return {"id": i, "category": cat, "bbox_min": list(mn), "bbox_max": list(mx),
            "top_z": mx[2], "center": [(a + b) / 2 for a, b in zip(mn, mx)], **kw}


def _layout(objs):
    return {"bounds": {"min": [-3, -3, 0.0], "max": [3, 3, 2.7]}, "objects": objs}


FLOOR = _obj("Floor0", "floor", (-3, -3, -0.01), (3, 3, 0.0))
TABLE = _obj("Table0", "table", (0, 0, 0.0), (1.2, 0.8, 0.75))


def test_a_seated_prop_passes():
    mug = _obj("Mug0", "mug", (0.2, 0.2, 0.75), (0.28, 0.28, 0.85), rests_on="Table0")
    assert V.check_support([FLOOR, TABLE, mug], 0.0) == []


def test_a_floating_prop_is_named_with_the_drop():
    mug = _obj("Mug0", "mug", (0.2, 0.2, 0.80), (0.28, 0.28, 0.90), rests_on="Table0")
    f = V.check_support([FLOOR, TABLE, mug], 0.0)
    assert [x["kind"] for x in f] == ["floating"] and f[0]["gap_m"] == 0.05


def test_a_sunk_prop_and_an_undeclared_one_are_both_findings():
    mug = _obj("Mug0", "mug", (0.2, 0.2, 0.70), (0.28, 0.28, 0.80), rests_on="Table0")
    lamp = _obj("Lamp0", "lamp", (0.5, 0.5, 0.75), (0.6, 0.6, 1.1))
    kinds = sorted(x["kind"] for x in V.check_support([FLOOR, TABLE, mug, lamp], 0.0))
    assert kinds == ["sunk", "undeclared_support"]


def test_a_prop_hanging_off_its_support_is_flagged():
    mug = _obj("Mug0", "mug", (1.15, 0.2, 0.75), (1.35, 0.28, 0.85), rests_on="Table0")
    assert [x["kind"] for x in V.check_support([FLOOR, TABLE, mug], 0.0)] == ["off_support"]


def test_floor_standing_furniture_is_checked_against_the_floor_without_a_claim():
    chair = _obj("Chair0", "chair", (2, 2, 0.10), (2.5, 2.5, 0.9))
    f = V.check_support([FLOOR, TABLE, chair], 0.0)
    assert f and f[0]["kind"] == "floating" and f[0]["rests_on"] == "floor"


def test_box_overlaps_are_advisory_and_skip_support_pairs():
    mug = _obj("Mug0", "mug", (0.2, 0.2, 0.75), (0.28, 0.28, 0.85), rests_on="Table0")
    chair = _obj("Chair0", "chair", (0.5, 0.3, 0.0), (1.0, 0.9, 0.9))     # tucked under the table
    ov = V.check_overlaps([FLOOR, TABLE, mug, chair])
    assert [(o["id"], o["with"]) for o in ov] == [("Table0", "Chair0")]


def test_the_verdict_blocks_on_support_but_not_on_boxes(tmp_path: Path, monkeypatch):
    import numpy as np
    import trimesh
    monkeypatch.setattr(V, "mesh_clashes", lambda *args: [])
    room = tmp_path / "room"
    room.mkdir()
    (room / "Room.py").write_text("SHELL = {}\n")
    prev = tmp_path / "room_preview"
    prev.mkdir()
    chair = _obj("Chair0", "chair", (0.5, 0.3, 0.0), (1.0, 0.9, 0.9))
    mug = _obj("Mug0", "mug", (0.2, 0.2, 0.80), (0.28, 0.28, 0.90), rests_on="Table0")
    (prev / "room_layout.json").write_text(json.dumps(_layout([FLOOR, TABLE, chair, mug])))
    (prev / "manifest.json").write_text('{"assets": []}')
    def export():
        scene = trimesh.Scene()
        for obj in [FLOOR, TABLE, chair, mug]:
            lo, hi = np.array(obj["bbox_min"]), np.array(obj["bbox_max"])
            mesh = trimesh.creation.box(extents=hi-lo)
            mesh.apply_translation((lo+hi)/2)
            mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi/2, [1,0,0]))
            scene.add_geometry(mesh, node_name=obj["id"])
        scene.export(prev / "Room.glb")
    export()
    rep = V.validate(room, prev)
    assert rep["ok"] and not rep["pass"]
    assert [f["kind"] for f in rep["failing"]] == ["no_downward_support_contact"]
    assert rep["counts"]["overlap"] == 1                      # reported, not blocking
    assert V.main(["--room", str(room), "--preview", str(prev)]) == 2
    assert (prev / "validation.json").is_file()
    mug["bbox_min"][2], mug["bbox_max"][2] = 0.75, 0.85
    (prev / "room_layout.json").write_text(json.dumps(_layout([FLOOR, TABLE, chair, mug])))
    export()
    assert V.main(["--room", str(room), "--preview", str(prev)]) == 0


def test_no_build_is_a_clear_error_not_a_pass(tmp_path: Path):
    rep = V.validate(tmp_path / "room", tmp_path / "nowhere")
    assert not rep["ok"] and not rep["pass"] and "compile" in rep["error"]


@pytest.mark.parametrize("second", [{"small_marker": True}, {}, {"source_glb": "mug.glb"}],
                         ids=["marked", "hand-built", "premade"])
def test_props_on_one_table_block_only_when_their_meshes_intersect(tmp_path, second):
    import numpy as np
    import trimesh

    (tmp_path / "Room.py").write_text("SHELL = {}\n")
    (tmp_path / "manifest.json").write_text('{"assets": []}')
    for x, clash in [(0.25, True), (0.4, False)]:
        mugs = [_obj(f"Mug{i}", "mug", (left, .2, .75), (left + .1, .3, .85),
                     rests_on="Table0", handle=f"CupHandle{i}", **props)
                for i, (left, props) in enumerate([(.2, {"small_marker": True}), (x, second)])]
        objects = [FLOOR, dict(TABLE, rests_on="Floor0"), *mugs]
        scene = trimesh.Scene()
        for obj in objects:
            name = obj.get("handle") or obj["id"]
            scene.graph.update(frame_from=obj.get("rests_on", "world"), frame_to=name)
            lo, hi = np.array(obj["bbox_min"]), np.array(obj["bbox_max"])
            mesh = trimesh.creation.box(extents=hi-lo)
            mesh.apply_translation((lo+hi)/2)
            mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi/2, [1, 0, 0]))
            scene.add_geometry(mesh, node_name=name + "_box", parent_node_name=name)
        scene.export(tmp_path / "Room.glb")
        (tmp_path / "room_layout.json").write_text(json.dumps(_layout(objects)))
        report = V.validate(tmp_path, tmp_path)
        assert report["finite_support"]["pass"]
        assert report["pass"] is (not clash)
        assert [(f["kind"], f["id"], f["with"]) for f in report["failing"]] == (
            [("object_clash", "Mug1", "Mug0")] if clash else [])


def test_registered_blind_stays_in_the_opening_sweep_and_beams_in_structure(tmp_path):
    import trimesh

    from litereality_agent.agent.tools.check_collisions.source import collision_mesh as cm

    objects = [{"id": "Window0", "category": "window", "handle": "WindowHandle"},
               {"id": "Shade0", "category": "blind", "attached_to": "Window0"},
               {"id": "Beam0", "category": "beam"}]
    scene = trimesh.Scene()
    scene.add_geometry(trimesh.creation.box(), node_name="window_sash", parent_node_name="WindowHandle")
    scene.graph.update(frame_from="world", frame_to="WindowHandle")
    scene.graph.update(frame_from="window_sash", frame_to="Shade0")
    scene.add_geometry(trimesh.creation.box(), node_name="shade_mesh", parent_node_name="Shade0")
    scene.add_geometry(trimesh.creation.box(), node_name="Beam0")
    scene.export(tmp_path / "Room.glb")
    (tmp_path / "room_layout.json").write_text(json.dumps(_layout(objects)))
    bodies = cm.build_bodies(tmp_path / "Room.glb", {})
    assert not bodies["furniture"] and len(bodies["structure"].faces) == 12
    assert len(bodies["leaves"]["Window0"].faces) == 24
    assert not cm.open_clearance(bodies, {})
