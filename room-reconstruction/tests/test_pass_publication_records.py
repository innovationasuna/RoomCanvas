"""Standalone enhancement passes publish evidence only after their complete output succeeds."""
import importlib
import json
from pathlib import Path

import pytest

from litereality_agent import telemetry


def make_pass(tmp_path, monkeypatch, name):
    scene = tmp_path / "pipeline/capture"
    scene.mkdir(parents=True)
    paths = {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring",
             "authoring_room": "room"}
    (scene / "scene.json").write_text(json.dumps({"paths": paths}))
    preview = scene / "preview"
    preview.mkdir()
    (preview / "room_layout.json").write_text('{"cameras": [], "objects": []}')
    for filename in ("Room.glb", "Room.blend"):
        (preview / filename).write_bytes(b"original room")
    (scene / "room/Objects/Procedural").mkdir(parents=True)
    traces = scene / "scene_init/obj_stage/traces"
    traces.mkdir(parents=True)
    module = importlib.import_module(f"litereality_agent.pipeline.realism_authoring.{name}.run")
    run = module.Pass(scene, out=tmp_path / name)
    run.items = []
    if name == "small_objects":
        def apply(_blend, request, _label):
            output = Path(request["out_dir"])
            output.mkdir()
            for filename in ("Room.glb", "Room.blend", "room_layout.json"):
                (output / filename).write_bytes(b"modified room")

        monkeypatch.setattr(run, "blender", apply)
        monkeypatch.setattr(run, "render_pairs", lambda *args: None)
    return run, traces, run.final if name == "articulate" else run.apply


@pytest.mark.parametrize("name", ["articulate", "small_objects"])
def test_direct_pass_records_digest_and_does_not_duplicate_replay_model_events(tmp_path, monkeypatch, name):
    for variable in ("LITEREALITY_RUN_ID", "LITEREALITY_ATTEMPT_ID", "LITEREALITY_JOB_ID"):
        monkeypatch.delenv(variable, raising=False)
    run, traces, publish = make_pass(tmp_path, monkeypatch, name)
    traces.rmdir()  # standalone/historical scenes may never have started telemetry
    publish()
    artifact = run.out / "room_preview/Room.glb"
    row = json.loads((traces / "trace.jsonl").read_text())
    assert row["kind"] == "artifact_published"
    assert row["artifact_digest"] == telemetry.artifact_digest(artifact)
    assert row["artifact_size"] == artifact.stat().st_size
    assert row["schema_version"] == 2 and row["outcome"] == "completed"
    assert row["stage"] == row["phase"] == name
    assert (run.scene_dir / row["path"]).resolve() == artifact
    assert row["job_id"] == str(run.scene_dir)
    assert row["run_id"] and row["attempt_id"] == row["run_id"]
    # The outer server may still announce the same asset to the replay once.
    telemetry.record_artifact(traces, "model_saved", artifact, model="articulated", path=str(artifact))
    rows = [json.loads(line) for line in (traces / "trace.jsonl").read_text().splitlines()]
    assert [row["kind"] for row in rows] == ["artifact_published", "model_saved"]


@pytest.mark.parametrize("name", ["articulate", "small_objects"])
def test_failed_pass_has_no_publication_event(tmp_path, monkeypatch, name):
    run, traces, publish = make_pass(tmp_path, monkeypatch, name)
    if name == "articulate":
        # The model copy succeeds, but publishing its matching layout does not.
        module = importlib.import_module("litereality_agent.pipeline.realism_authoring.articulate.run")
        original = module.shutil.copyfile

        def copyfile(source, destination, *args, **kwargs):
            if Path(destination).name == "room_layout.json":
                raise OSError("layout write failed")
            return original(source, destination, *args, **kwargs)

        monkeypatch.setattr(module.shutil, "copyfile", copyfile)
        expected = OSError
    else:
        def fail(*args):
            raise RuntimeError("Blender failed")

        monkeypatch.setattr(run, "blender", fail)
        expected = RuntimeError
    with pytest.raises(expected):
        publish()
    assert not (traces / "trace.jsonl").exists()
