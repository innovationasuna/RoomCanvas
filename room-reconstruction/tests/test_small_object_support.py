"""The small-object pass must leave surviving members of mixed stacks supported."""

import json
import subprocess

import pytest

from litereality_agent.pipeline.realism_authoring.small_objects.run import BLENDER_OPS, Pass
from litereality_agent.pipeline.room_qc.support_audit import audit
from litereality_agent.room_ops.paths import find_blender


@pytest.fixture
def book_stack(tmp_path):
    preview = tmp_path / "preview"
    preview.mkdir()
    objects = []
    for name, category, low, high, props in [
        ("Floor0", "floor", [-2, -2, -.1], [2, 2, 0], {}),
        ("Table0", "table", [-1, -1, 0], [1, 1, .75],
         {"rests_on": "Floor0", "placeable_surface": True}),
        ("Book0", "book", [-.2, -.15, .75], [.2, .15, .79],
         {"rests_on": "Table0", "small_marker": True}),
        ("Book1", "book", [-.2, -.15, .79], [.2, .15, .83], {"rests_on": "Book0"}),
        ("Book2", "book", [-.2, -.15, .83], [.2, .15, .87],
         {"rests_on": "Book1", "small_marker": True}),
    ]:
        objects.append({"id": name, "category": category, "bbox_min": low, "bbox_max": high, **props})
    (preview / "room_layout.json").write_text(json.dumps({"objects": objects, "cameras": []}))
    paths = {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring"}
    (tmp_path / "scene.json").write_text(json.dumps({"paths": paths}))
    run = Pass(tmp_path)
    run.find()
    for item in run.items:
        item["views"] = []
        if item["id"] == "Book1":
            item["decision"] = {"decision": "procedural"}
    run.decide()
    return run


def test_mixed_stack_keeps_only_the_support_needed_by_a_survivor(book_stack):
    run = book_stack
    base, middle, top = run.items
    assert base["kept_for"] == "Book1" and "still supports Book1" in run.outcome(base)
    assert run.undone() == ["Book0"]
    assert run.plan(run.items) == ([{"id": "Book2", "members": ["Book2"]}], [])
    trace = run.scene_dir / "scene_init/obj_stage/traces/trace.jsonl"
    row = next(r for r in map(json.loads, trace.read_text().splitlines()) if r["name"] == "Book0")
    assert (row["method"], row["reason"]) == ("kept", "still supports Book1")

    middle["decision"] = {"decision": "drop"}
    # A noncandidate can also keep a whole chain of lower supports alive.
    run.layout["objects"].append({"id": "Other", "rests_on": "Book2"})
    run.decide()
    assert run.undone() == ["Book0", "Book1", "Book2"]
    assert run.plan(run.items) == ([], [])
    run.layout["objects"].pop()
    run.decide()
    assert not run.undone()
    assert [i["id"] for i in run.plan(run.items)[0]] == [i["id"] for i in (base, middle, top)]


@pytest.mark.blender
def test_mixed_stack_has_finite_support_after_blender_applies_the_drop(book_stack, tmp_path):
    run = book_stack
    final = tmp_path / "final"
    drop, replace = run.plan(run.items)
    request = {"layout": str(run.preview / "room_layout.json"), "out_dir": str(final),
               "drop": drop, "replace": replace}
    script = tmp_path / "apply_stack.py"
    script.write_text(f"request = {request!r}\nops = {str(BLENDER_OPS)!r}\n" + """
import bpy, json, runpy
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for item in json.loads(open(request["layout"]).read())["objects"]:
    handle = bpy.data.objects.new(item["id"], None)
    bpy.context.scene.collection.objects.link(handle)
    handle["room_id"] = item["id"]
    for key in ("category", "rests_on", "small_marker"):
        if key in item:
            handle[key] = item[key]
    if item.get("rests_on"):
        handle.parent = bpy.data.objects[item["rests_on"]]
    low, high = item["bbox_min"], item["bbox_max"]
    bpy.ops.mesh.primitive_cube_add(size=1, location=[(a+b)/2 for a, b in zip(low, high)])
    mesh = bpy.context.object
    mesh.dimensions = [b-a for a, b in zip(low, high)]
    mesh.parent = handle
bpy.context.view_layer.update()
runpy.run_path(ops)["apply"](request)
""")
    proc = subprocess.run([find_blender(), "-b", "--python-exit-code", "1", "--python", str(script)],
                          capture_output=True, text=True, timeout=90)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    layout = json.loads((final / "room_layout.json").read_text())
    entries = {entry["id"]: entry for entry in layout["objects"]}
    assert "Book2" not in entries and entries["Book1"]["rests_on"] == "Book0"
    report = audit(final, strict=True)
    assert report["pass"], report["support_findings"]
    check = next(c for c in report["checks"] if c["id"] == "Book1")
    assert check["contact_samples"] > 0 and check["center_over_contact_hull"]
