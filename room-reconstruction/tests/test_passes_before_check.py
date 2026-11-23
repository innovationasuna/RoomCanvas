"""The author stage completes its room (small objects, then openable parts) before the one check, does
both again on the repaired room, and publish publishes that room."""

import json
from pathlib import Path

import pytest

from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.realism_authoring import acceptance as A
from litereality_agent.pipeline.realism_authoring import passes
from litereality_agent.pipeline.result import StageStatus
from litereality_agent.pipeline.room_qc import publish

SMALL = "realism_authoring/small_objects/room_preview"
PARTS = "realism_authoring/articulate/room_preview"


def context(tmp_path):
    c = RunContext("test", tmp_path / "capture", tmp_path / "scene", tmp_path)
    for room in (c.seed_room, c.authored_room):
        room.mkdir(parents=True)
        (room / "Room.py").write_text("SHELL = {}")
        (room / "manifest.json").write_text('{"assets": []}')
    (c.object_root / "traces").mkdir(parents=True)
    return c


def built(c):
    c.preview_dir.mkdir(parents=True, exist_ok=True)
    for name in ("Room.blend", "Room.glb", "room_layout.json"):
        (c.preview_dir / name).write_text(f"build {name}")
    (c.preview_dir / "manifest.json").write_text(json.dumps(
        {"assets": [{"object": "Storage0", "glb": "Object/Storage0.glb", "kind": "static"}]}))


def trace(c):
    return [json.loads(line) for line in (c.object_root / "traces" / "trace.jsonl").read_text().splitlines()]


class Steps:
    """What finish did, in order: builds, the passes and their room, the check, the repair."""

    def __init__(self, c, monkeypatch, passed=False, edits=True):
        self.c, self.order, self.checked = c, [], []

        def build(context, module, args, **kwargs):
            self.order.append("build")
            built(c)
            return 0, None

        def complete(context, preview, options):
            self.order.append("passes")
            room = c.scene_dir / PARTS
            room.mkdir(parents=True, exist_ok=True)
            for name in ("Room.glb", "room_layout.json", "manifest.json"):
                (room / name).write_text(f"complete {name}")
            return {"room": PARTS, "small_objects": "ok", "articulate": "ok"}, room

        def assess(context, preview, evidence, room=None):
            self.order.append("check")
            self.checked.append(room)
            return {"schema": A.SCHEMA, "accepted": passed, "status": "accepted" if passed else "needs_repair",
                    "fingerprint": A.fingerprint(c.authored_room, preview)}

        async def repair(*args, **kwargs):
            self.order.append("repair")
            if edits:
                (c.authored_room / "Room.py").write_text("SHELL = {'repaired': True}")

        monkeypatch.setattr(A, "run_module", build)
        monkeypatch.setattr(A, "_complete", complete)
        monkeypatch.setattr(A, "assess", assess)
        monkeypatch.setattr(A, "repair", repair)


def test_the_check_reads_the_room_the_passes_completed(tmp_path, monkeypatch):
    c = context(tmp_path)
    steps = Steps(c, monkeypatch, passed=True)
    report = A.finish(c, {})
    assert steps.order == ["build", "passes", "check"]
    assert steps.checked == [c.scene_dir / PARTS] and report["passes"]["room"] == PARTS
    # The round's model for the replay is the room that was checked, not the bare build.
    rounds = list((c.authoring_root / "acceptance").glob("attempt-*/round_00/Room.glb"))
    assert [p.read_text() for p in rounds] == ["complete Room.glb"]
    assert json.loads((c.preview_dir / "author_acceptance.json").read_text())["passes"]["articulate"] == "ok"


def test_the_repaired_room_goes_through_the_passes_again_and_is_not_checked_again(tmp_path, monkeypatch):
    c = context(tmp_path)
    steps = Steps(c, monkeypatch)
    report = A.finish(c, {})
    assert steps.order == ["build", "passes", "check", "repair", "build", "passes"]
    assert report["status"] == "repaired" and A.done(report)
    kinds = [r["kind"] for r in trace(c) if r["kind"] in ("repair_start", "repair_done")]
    assert kinds == ["repair_start", "repair_done"]
    assert report["repair_changed"] is True and trace(c)[-1]["changed"] is True


def test_a_repair_that_changed_nothing_says_so(tmp_path, monkeypatch):
    """Out of budget before any edit, or only looking: the result is the checked room built again."""
    c = context(tmp_path)
    Steps(c, monkeypatch, edits=False)
    report = A.finish(c, {})
    assert report["status"] == "repaired" and report["repair_changed"] is False
    done = [r for r in trace(c) if r["kind"] == "repair_done"]
    assert [(r["status"], r["changed"]) for r in done] == [("repaired", False)]


def run_passes(c, monkeypatch, fail=(), options=None, left=None):
    """passes.run with each pass's module stood in for: it writes its room unless it is to fail."""
    from litereality_agent.pipeline.realism_authoring import pass_cache

    calls = []

    def module(context, name, args, **kwargs):
        short = name.rsplit(".", 1)[-1]
        import os
        calls.append((short, os.environ.get("LR_ARTICULATE_SOURCE")))
        if short in fail:
            return 3, Path(f"{short}.log")
        out = Path(args[args.index("--out") + 1]) / "room_preview"
        out.mkdir(parents=True, exist_ok=True)
        for name in pass_cache.ROOM_FILES:
            (out / name).write_text(f"{short} {name}")
        if short == "articulate" and not left:
            (out.parent / "summary.json").write_text(json.dumps({"attempt_id": os.environ.get("LITEREALITY_RUN_ID"),
                                                                "existing": 2, "added": 1}))
        if left and short in left:  # what the pass could not do, as its summary.json says
            key = "undone" if short == "small_objects" else "failed_objects"
            (out.parent / "summary.json").write_text(json.dumps({key: left[short]}))
        if short == "small_objects":
            receipt = c.authored_room / "Models" / ".sources.json"
            if receipt.exists():
                assert args[args.index("--ready-sources") + 1] == receipt
            pass_cache.record_bundle(out, "key", pass_cache.ROOM_FILES)
            (out.parent / "dependencies.json").write_text(json.dumps({"dependencies": {"preview": {
                name: pass_cache.cache.file_hash(c.preview_dir / name) for name in pass_cache.ROOM_FILES}}}))
        return 0, None

    monkeypatch.setattr(passes, "run_module", module)
    monkeypatch.setenv("LR_ARTICULATE_SOURCE", "/an/operator/setting")
    return passes.run(c, options or {}), calls


def test_the_openable_parts_take_the_small_objects_room_and_both_are_recorded(tmp_path, monkeypatch):
    c = context(tmp_path)
    built(c)
    (c.authored_room / "Models").mkdir()
    (c.authored_room / "Models" / ".sources.json").write_text("{}")
    report, calls = run_passes(c, monkeypatch)
    assert calls == [("small_objects", "/an/operator/setting"), ("articulate", str(c.scene_dir / SMALL))]
    assert report == {"room": PARTS, "small_objects": "ok", "articulate": "ok", "warnings": []}
    # For the check: the build's assets, named where the build has them (not in the pass's Object/).
    asset = json.loads((c.scene_dir / PARTS / "manifest.json").read_text())["assets"][0]
    assert asset["glb"] == "../../room_preview/Object/Storage0.glb"
    assert (c.scene_dir / PARTS / asset["glb"]).resolve() == (c.preview_dir / "Object/Storage0.glb").resolve()
    rows = trace(c)
    assert [(r["kind"], r.get("model")) for r in rows] == [
        ("model_saved", "small_objects"), ("articulate_start", None), ("articulate_done", None),
        ("model_saved", "articulated")]
    assert {r["stage"] for r in rows} == {"author"}  # the replay shows them with the room built
    assert rows[0]["path"] == f"{SMALL}/Room.glb"
    assert rows[-1]["joints"] == 3


def test_a_pass_that_fails_is_left_out(tmp_path, monkeypatch):
    c = context(tmp_path)
    built(c)
    report, calls = run_passes(c, monkeypatch, fail=("small_objects",))
    assert calls[1] == ("articulate", None)  # on the build itself
    assert (report["small_objects"], report["articulate"], report["room"]) == ("failed", "ok", PARTS)
    report, calls = run_passes(c, monkeypatch, fail=("articulate",), options={})
    assert (report["articulate"], report["room"]) == ("failed", SMALL)
    assert any("openable parts" in w for w in report["warnings"])
    report, calls = run_passes(c, monkeypatch, options={"articulate": False})
    assert [name for name, _ in calls] == ["small_objects"]
    assert (report["articulate"], report["room"]) == ("skipped", SMALL)


def test_a_pass_that_left_items_undone_says_which(tmp_path, monkeypatch):
    c = context(tmp_path)
    built(c)
    report, _ = run_passes(c, monkeypatch, left={"small_objects": ["TissueBox0"], "articulate": ["Storage1"]})
    assert (report["small_objects"], report["articulate"], report["room"]) == ("partial", "partial", PARTS)
    assert report["left"] == {"small_objects": ["TissueBox0"], "articulate": ["Storage1"]}
    assert any("TissueBox0" in w for w in report["warnings"]) and any("Storage1" in w for w in report["warnings"])
    assert [r.get("failed") for r in trace(c) if r["kind"] == "articulate_done"] == [1]


@pytest.fixture
def published(tmp_path, monkeypatch):
    """publish.run with its subprocesses stood in for; returns (context, what ran)."""
    from litereality_agent.room_ops import api

    c = context(tmp_path)
    built(c)
    room = c.scene_dir / PARTS
    room.mkdir(parents=True)
    for name in ("Room.blend", "Room.glb", "room_layout.json"):
        (room / name).write_text(f"complete {name}")
    ran = []

    def module(context, name, args, **kwargs):
        ran.append(name.rsplit(".", 1)[-1])
        if ran[-1] == "build_from_room":
            built(c)
        return 0, None

    def save_as(source, target):
        ran.append(("save_as", source))
        Path(target).write_text(Path(source).read_text())
        return 0

    def bake(blend, glb, **kwargs):
        Path(glb).write_text("baked " + Path(blend).read_text())
        return 0

    def again(context, options):
        ran.append(("passes", options))
        return {"room": PARTS, "small_objects": "ok", "articulate": "ok", "warnings": []}

    monkeypatch.setattr(publish, "run_module", module)
    monkeypatch.setattr(api, "save_blend_as", save_as)
    monkeypatch.setattr(api, "bake_room", bake)
    monkeypatch.setattr(passes, "run", again)
    checked = {"schema": A.SCHEMA, "accepted": True, "status": "accepted",
               "fingerprint": A.fingerprint(c.authored_room, c.preview_dir),
               "passes": {"room": PARTS, "small_objects": "ok", "articulate": "ok"}}
    (c.preview_dir / "author_acceptance.json").write_text(json.dumps(checked))
    return c, ran


def test_publish_publishes_the_checked_room_with_its_passes_without_building_again(published):
    c, ran = published
    result = publish.run(c, {"compare_frames": 0})
    assert result.status is StageStatus.COMPLETED
    assert "build_from_room" not in ran and ("save_as", c.scene_dir / PARTS / "Room.blend") in ran
    assert (c.preview_dir / "Room.glb").read_text() == "baked complete Room.blend"
    assert (c.preview_dir / "room_layout.json").read_text() == "complete room_layout.json"
    report = json.loads((c.preview_dir / "acceptance.json").read_text())
    assert report["passes"]["articulate"] == "ok" and publish.complete(c)


def test_publish_builds_a_changed_room_again_and_completes_it_the_same_way(published):
    c, ran = published
    (c.authored_room / "Room.py").write_text("SHELL = {'edited': True}")
    publish.run(c, {"compare_frames": 0})
    assert ran.index("build_from_room") < ran.index(("passes", {"articulate": True}))
    assert (c.preview_dir / "Room.glb").read_text() == "baked complete Room.blend"


def test_a_pass_room_is_checked_from_the_command_line_without_writing_beside_it(tmp_path, monkeypatch):
    c = context(tmp_path)
    built(c)
    room = tmp_path / "elsewhere" / "room_preview"  # an older flow's pass room, outside the scene
    room.mkdir(parents=True)
    for name in ("Room.glb", "room_layout.json"):
        (room / name).write_text(f"pass {name}")
    seen = {}

    def validate(authored, preview):
        seen["room"] = authored
        seen["glb"] = (preview / "Room.glb").read_text()
        asset = json.loads((preview / "manifest.json").read_text())["assets"][0]
        seen["source"] = (preview / asset["glb"]).resolve()
        return {"ok": True, "pass": True, "objects": 0, "declared_support": 0, "failing": [],
                "counts": {"support": 0, "articulation": 0, "mesh_clash": 0, "open_meshes": 0, "overlap": 0}}

    monkeypatch.setattr("litereality_agent.pipeline.room_qc.validate.validate", validate)
    assert passes.main([str(c.authoring_root), str(room)]) == 0
    assert seen == {"room": c.authored_room.resolve(), "glb": "pass Room.glb",
                    "source": (c.preview_dir / "Object/Storage0.glb").resolve()}
    assert sorted(p.name for p in room.iterdir()) == ["Room.glb", "room_layout.json"]
