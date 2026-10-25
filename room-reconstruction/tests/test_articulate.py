"""The articulation pass: which objects it asks about, how answers become cuts, the URDF."""

from __future__ import annotations

import json
import math
import xml.etree.ElementTree as ET

from litereality_agent.pipeline.realism_authoring.articulate import candidates, judge, urdf


def obj(oid, category, low, high, **extra):
    return {"id": oid, "category": category, "bbox_min": low, "bbox_max": high, **extra}


def room():
    return {"objects": [
        obj("Floor0", "floor", [-2, -2, 0], [2, 2, 0]),
        obj("Wall0", "wall", [-2, 2, 0], [2, 2.1, 2.5]),
        obj("Door0", "door", [0, 2, 0], [0.8, 2.1, 2], source_glb="Door0.glb"),
        obj("Pedestal0", "cabinet", [1, 1, 0], [1.5, 1.5, 0.6], rests_on="Floor0"),
        obj("Table1", "table", [-1, -1, 0], [0.7, 0.1, 0.75], source_glb="Table1.glb"),
        obj("Laptop0", "laptop", [-0.5, -0.5, 0.75], [-0.17, -0.24, 1.0], rests_on="Table1"),
        obj("Mouse0", "mouse", [0, 0, 0.75], [0.06, 0.1, 0.8], rests_on="Table1"),
        obj("Socket0", "socket", [0, 2, 0.3], [0.1, 2, 0.4], attached_to="Wall0"),
        obj("Whiteboard0", "board", [-1, 1.9, 1], [0.1, 2, 1.9], attached_to="Wall0"),
        obj("Coat0", "coat", [0, 1.8, 0.8], [0.4, 2, 1.7], attached_to="Door0"),
        obj("Cable0", "cable", [-1, -1, 0], [0.5, 0, 0.7], attached_to="Table1"),
    ]}


def test_candidates_are_furniture_and_things_not_shell_openings_fixtures_or_accessories():
    found = {c["id"]: c for c in candidates.find_candidates(room())}
    # Wall-mounted furniture stays (a wall cabinet opens); a coat on a door, a cable, a socket,
    # the door itself (already hinged) and a mouse (too small) do not.
    assert sorted(found) == ["Laptop0", "Pedestal0", "Table1", "Whiteboard0"]
    assert found["Table1"]["rebuilt"] == "asset"
    assert found["Pedestal0"]["size"] == [0.5, 0.5, 0.6]
    assert found["Laptop0"]["label"] == "laptop"


BOX = {"min": [-0.25, -0.25, 0.0], "max": [0.25, 0.25, 0.6]}


def test_a_drawer_and_a_door_become_cuts_snapped_to_the_box_axes():
    reply = """Looking at the photos... {"openable": true, "reason": "a pedestal",
      "parts": [
        {"name": "Drawer 1", "found": true, "joint": "prismatic", "box_min": [-0.24, -0.27, 0.4],
         "box_max": [0.24, -0.22, 0.58], "slide_axis": [0.05, -0.99, 0], "travel_m": 0.35,
         "pose_in_model": "closed", "reason": "top drawer"},
        {"name": "Door_1", "found": true, "joint": "revolute", "box_min": [-0.24, -0.26, 0.0],
         "box_max": [0.24, -0.22, 0.38], "hinge_point": [-0.24, -0.24, 0.2],
         "hinge_axis": [0, 0, 1], "open_degrees": 95, "pose_in_model": "open", "open_now": 20},
        {"name": "Drawer_2", "found": false, "reason": "the model is one block"},
        {"name": "Flap", "found": true, "joint": "revolute", "box_min": [0, 0, 0],
         "box_max": [0.1, 0.1, 0.1], "hinge_point": [0, 0, 0], "hinge_axis": [1, 1, 0],
         "open_degrees": 90},
        {"name": "Lid", "found": true, "joint": "revolute", "box_min": [3, 3, 3],
         "box_max": [4, 4, 4], "hinge_point": [3, 3, 3], "hinge_axis": [1, 0, 0],
         "open_degrees": 90}]}"""
    plan = judge.parse_plan(reply, BOX)
    assert plan["openable"]
    drawer, door = plan["parts"]
    assert drawer["name"] == "Drawer_1" and drawer["joint"] == "prismatic"
    assert drawer["axis"] == [0.0, -1.0, 0.0] and drawer["limit"] == 0.35
    assert drawer["box_min"][1] == -0.27  # inside the 5 cm margin: kept as answered
    assert drawer["box_max"][2] == 0.58  # 2 cm below the top: kept
    assert door["box_min"][2] == -0.01  # at the bottom: pushed past it
    assert drawer["origin"] == [0.0, -0.245, 0.49]
    assert door["axis"] == [0.0, 0.0, 1.0] and door["origin"] == [-0.24, -0.24, 0.2]
    assert math.isclose(door["limit"], math.radians(95))
    assert math.isclose(door["open_now"], math.radians(20))
    assert drawer["covers_opening"] and door["covers_opening"]  # unless Astra says otherwise
    screen = judge.parse_plan(json.dumps({"openable": True, "parts": [{
        "name": "Screen_1", "joint": "revolute", "box_min": [-0.2, 0.2, 0.1], "box_max": [0.2, 0.25, 0.4],
        "hinge_point": [0, 0.22, 0.1], "hinge_axis": [1, 0, 0], "open_degrees": 120,
        "covers_opening": False}]}), BOX)["parts"][0]
    assert screen["covers_opening"] is False
    reasons = {r["name"]: r["reason"] for r in plan["rejected"]}
    assert reasons["Drawer_2"].startswith("not in the model")
    assert "axis" in reasons["Flap"]
    assert "outside" in reasons["Lid"]


def test_nothing_to_open_and_names_kept_unique():
    assert judge.parse_plan('{"openable": false, "reason": "a chair", "parts": []}', BOX) == {
        "openable": False, "reason": "a chair", "parts": [], "rejected": []}
    part = {"found": True, "joint": "prismatic", "box_min": [-0.2, -0.25, 0], "box_max":
            [0.2, -0.2, 0.2], "slide_axis": [0, -1, 0], "travel_m": 0.3}
    reply = json.dumps({"openable": True, "parts": [{"name": "Drawer", **part}] * 2})
    assert [p["name"] for p in judge.parse_plan(reply, BOX)["parts"]] == ["Drawer", "Drawer_2"]


def test_check_keeps_only_parts_answered_yes():
    reply = '{"parts": {"Drawer_1": {"keep": true, "reason": "slides out"}, ' \
            '"Door_1": {"keep": false, "reason": "hinged on the wrong side"}}}'
    verdicts = judge.parse_check(reply, ["Drawer_1", "Door_1", "Lid_1"])
    assert verdicts["Drawer_1"]["keep"] and not verdicts["Door_1"]["keep"]
    assert verdicts["Lid_1"] == {"keep": False, "reason": "not answered"}


def test_prompts_name_the_object_and_the_parts_that_already_open():
    item = {"id": "Table1", "label": "table", "category": "table", "size": [1.7, 1.1, 0.75]}
    text = judge.decide_prompt(item, BOX, ["Table1_Desktop_Lift"])
    assert "Table1_Desktop_Lift" in text and "1.70 x 1.10 x 0.75" in text
    assert "X -0.250..0.250" in text
    assert "Drawer_1 (slides)" in judge.check_prompt(item, [{"name": "Drawer_1", "joint": "prismatic"}])


def test_urdf_joint_matches_the_part_node(tmp_path):
    parts = [{"name": "Drawer_1", "joint": "prismatic", "origin": [0.0, -0.245, 0.49],
              "axis": [0.0, -1.0, 0.0], "limit": 0.35},
             {"name": "Door_1", "joint": "revolute", "origin": [-0.24, -0.24, 0.2],
              "axis": [0.0, 0.0, 1.0], "limit": math.radians(95)}]
    path = urdf.write("Pedestal0", parts, tmp_path)
    assert path == tmp_path / "Articulated/Pedestal0/sim/Pedestal0.urdf"
    joints = list(ET.parse(path).getroot().iter("joint"))
    assert [j.find("child").get("link") for j in joints] == ["Pedestal0_Drawer_1", "Pedestal0_Door_1"]
    assert {j.find("parent").get("link") for j in joints} == {"Pedestal0_Hinges"}
    assert joints[0].get("type") == "prismatic"
    assert joints[0].find("origin").get("xyz") == "0 -0.245 0.49"
    assert joints[1].find("axis").get("xyz") == "0 0 1"
    assert math.isclose(float(joints[1].find("limit").get("upper")), math.radians(95), rel_tol=1e-5)
