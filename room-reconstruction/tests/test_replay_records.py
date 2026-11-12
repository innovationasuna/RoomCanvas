"""Records the reconstruction replay is timed by: each AI-made object, each saved room model, each
acceptance verdict and the parts each build of the authored room adds, all in trace.jsonl.

The web replay used to infer these from file times, which copying a run changes, and could not show
AI-made objects one by one because only the whole batch was recorded.
"""

from __future__ import annotations

import json
import os
import struct
from types import SimpleNamespace

import pytest

from litereality_agent import telemetry
from litereality_agent.pipeline.realism_authoring.acceptance import _record_round
from litereality_agent.pipeline.scene_init.reconstruct import flow
from litereality_agent.pipeline.scene_init.seed import saved
from litereality_agent.room_ops.api import SEED_GLB, _record_build

T0 = 1_800_000_000.0


def rows(traces):
    return [json.loads(line) for line in (traces / "trace.jsonl").read_text().splitlines()]


def touch(path, t=None, data=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    if t:
        os.utime(path, (t, t))
    return path


def glb(path, names, t):
    """A GLB with only a JSON chunk listing top-level nodes."""
    nodes = [{"name": n} for n in names]
    body = json.dumps({"scenes": [{"nodes": list(range(len(nodes)))}], "nodes": nodes}).encode()
    body += b" " * (-len(body) % 4)
    head = struct.pack("<III", 0x46546C67, 2, 20 + len(body)) + struct.pack("<II", len(body), 0x4E4F534A)
    return touch(path, t, head + body)


@pytest.fixture
def scene(tmp_path, monkeypatch):
    monkeypatch.setenv("LITEREALITY_RUN_ID", "run-1")
    (tmp_path / "scene_init/obj_stage/traces").mkdir(parents=True)
    return tmp_path


def test_record_uses_the_given_time_and_run_and_skips_a_missing_dir(scene, tmp_path):
    traces = scene / "scene_init/obj_stage/traces"
    telemetry.record(traces, "model_saved", at=T0, model="seed")
    telemetry.record(tmp_path / "nowhere", "model_saved", model="seed")
    assert rows(traces) == [{"t": T0, "kind": "model_saved", "model": "seed", "run": "run-1"}]
    assert not (tmp_path / "nowhere").exists()


def test_a_trace_start_names_the_run_for_its_subprocesses(tmp_path, monkeypatch):
    monkeypatch.delenv("LITEREALITY_RUN_ID", raising=False)
    monkeypatch.setattr(telemetry, "_state", {"scan": None, "dir": None, "t0": None})
    traces = telemetry.start("demo", tmp_path / "traces")
    start = rows(traces)[0]
    assert start["kind"] == "trace_start" and start["run"] == os.environ["LITEREALITY_RUN_ID"]


def test_each_ai_made_object_is_timed_by_its_model(scene, monkeypatch):
    traces = scene / "scene_init/obj_stage/traces"
    monkeypatch.setattr(flow.config, "traces_dir", lambda scan: traces)
    made = touch(scene / "recon/Sofa0.glb", T0 + 50)
    old = touch(scene / "recon/Bed0.glb", T0 - 500)
    flow._record_objects("demo", {"Sofa0": made, "Bed0": old, "Table0": None}, since=T0)
    got = {r["name"]: r for r in rows(traces)}
    assert got["Sofa0"]["t"] == T0 + 50 and got["Sofa0"]["status"] == "ok" and not got["Sofa0"]["reused"]
    assert got["Bed0"]["reused"] is True
    assert got["Table0"]["status"] == "failed"


def test_rooms_and_verdicts_are_recorded_with_their_paths(scene):
    context = SimpleNamespace(scene_dir=scene, object_root=scene / "scene_init/obj_stage")
    saved(context, "seed", touch(scene / SEED_GLB, T0 + 100))
    saved(context, "final", scene / "realism_authoring/room_preview/Room.glb")  # not built: nothing
    attempt = scene / "realism_authoring/acceptance/attempt-x"
    evidence = attempt / "round_00"
    touch(evidence / "Room.glb", T0 + 900)
    touch(evidence / "visual_review.json", data=json.dumps({"pass": False, "score": 6.5}).encode())
    _record_round(context, attempt, 0, evidence,
                  {"accepted": False, "review": str(evidence / "visual_review.json")})
    got = rows(scene / "scene_init/obj_stage/traces")
    assert [(r["kind"], r.get("model")) for r in got] == [
        ("model_saved", "seed"), ("model_saved", "round"), ("review_done", None)]
    assert got[0]["path"] == SEED_GLB and got[0]["t"] == T0 + 100
    assert got[1]["t"] == T0 + 900 and got[1]["round"] == 0 and got[1]["attempt"] == "attempt-x"
    review = got[2]
    assert review["folder"] == "realism_authoring/acceptance/attempt-x/round_00"
    assert (review["passed"], review["reviewed"]) == (False, True) and "score" not in review


def test_a_build_of_the_authored_room_records_the_parts_beyond_the_seed(scene, tmp_path):
    glb(scene / SEED_GLB, ["Floor0", "Bed0"], T0)
    built = glb(scene / "realism_authoring/room_preview/Room.glb", ["Floor0", "Bed0", "Curtain"], T0 + 300)
    _record_build(scene / "realism_authoring/room", built)
    _record_build(tmp_path / "elsewhere/room", built)  # not an authored room: no record
    assert rows(scene / "scene_init/obj_stage/traces") == [
        {"t": T0 + 300, "kind": "room_built", "added": ["Curtain"], "run": "run-1"}]


def test_the_repair_session_is_traced_for_the_replay(tmp_path, monkeypatch):
    """A repair used to leave nothing in the trace for up to ten minutes."""
    import asyncio

    from litereality_agent.agent import providers
    from litereality_agent.agent.providers.base import AgentMessage, SessionResult, ToolUseBlock
    from litereality_agent.pipeline.realism_authoring import acceptance

    class Harness:
        name = "fake"

        async def run(self, spec):
            yield AgentMessage(content=[ToolUseBlock(id="1", name="Bash", input={"command": "python Room.py"})])
            yield SessionResult(result="fixed the lamp")

    monkeypatch.setattr(providers, "resolve", lambda *a: Harness())
    traces = tmp_path / "traces"
    traces.mkdir()
    asyncio.run(acceptance.repair(tmp_path / "room", tmp_path / "scan", tmp_path / "report.json",
                                  steps=3, seconds=10, traces=traces))
    kinds = [json.loads(line)["kind"] for line in (traces / "authoring_trace.repair.jsonl").read_text().splitlines()]
    assert kinds[0] == "session_start" and "tool" in kinds and kinds[-1] == "session_end"


def test_finished_objects_are_recorded_as_the_build_poll_sees_them(scene, monkeypatch):
    """Each object is traced when it first shows up finished, not only when its batch ends."""
    from litereality_agent.pipeline.scene_init import flow as scene_flow

    traces = scene / "scene_init/obj_stage/traces"
    recon = scene / "recon"
    touch(recon / "Sofa0.glb", T0 + 50)
    touch(recon / "Shelf0/Shelf0.glb", T0 + 60)
    touch(recon / "Shelf0/object.py", T0 + 61)
    touch(recon / "Shelf0/object.md", T0 + 62)
    monkeypatch.setattr(scene_flow.config, "traces_dir", lambda scan: traces)
    monkeypatch.setattr(scene_flow.config, "reconstruct_dir", lambda scan: recon)
    monkeypatch.setattr(scene_flow, "_expected_by_branch",
                        lambda scan: {"trellis": ["Sofa0"], "procedural": ["Shelf0", "Lamp0"]})
    monkeypatch.setattr(scene_flow, "_expected_assets", lambda scan: ["Sofa0", "Shelf0", "Lamp0"])
    monkeypatch.setattr(scene_flow, "branch_concurrency", lambda n, c: 1)
    monkeypatch.setattr(scene_flow.reconstruct, "run_for_scan", lambda *a, **kw: {"generated": 1})
    monkeypatch.setattr(scene_flow.reconstruct, "run_procedural_for_scan", lambda *a, **kw: {"generated": 1})
    args = SimpleNamespace(reconstruct=True, chair_qc=False, procedural=True, build_openings=False,
                           trellis_python=None, seed=42, decimation=50000, force_reconstruct=False,
                           dry_run_reconstruct=False, concurrency=1, procedural_python=None, blender_path=None,
                           retries=0, budget=0, agent_model=None)
    monkeypatch.delenv("LR_SEQUENTIAL", raising=False)
    scene_flow._reconstruction_phase("demo", args, {}, full=False)
    done = {r["name"]: r for r in rows(traces) if r["kind"] == "object_done"}
    assert set(done) == {"Sofa0", "Shelf0"}
    assert done["Sofa0"]["t"] == T0 + 50 and done["Sofa0"]["method"] == "trellis"
    assert done["Shelf0"]["t"] == T0 + 62 and done["Shelf0"]["method"] == "procedural"
