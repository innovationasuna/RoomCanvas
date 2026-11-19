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


def test_articulate_takes_its_room_from_the_published_small_objects(tmp_path, monkeypatch):
    from litereality_agent import artifact_cache as cache
    from litereality_agent.pipeline.realism_authoring.articulate.run import Pass

    small, _, publish = make_pass(tmp_path, monkeypatch, "small_objects")
    blender = small.blender

    layout = '{"cameras": [], "objects": [{"id": "Cup0", "source_glb": "Cup0.glb"}]}'

    def apply(blend, request, label):  # the small objects' own meshes beside their room
        blender(blend, request, label)
        (Path(request["out_dir"]) / "room_layout.json").write_text(layout)
        (Path(request["out_dir"]) / "Object").mkdir()
        (Path(request["out_dir"]) / "Object" / "Cup0.glb").write_bytes(b"cup")

    monkeypatch.setattr(small, "blender", apply)
    publish()
    source = small.out / "room_preview"
    monkeypatch.setenv("LR_ARTICULATE_SOURCE", str(source))
    run = Pass(small.scene_dir, out=tmp_path / "articulate")
    assert run.preview == source.resolve()
    assert cache.read_json(run.out / "dependencies.json")["dependencies"]["preview"]["Room.glb"] == \
        cache.file_hash(source / "Room.glb")
    run.items = []
    run.final()  # nothing to cut: the room as it came, small objects and all
    final = run.out / "room_preview"
    assert (final / "Room.glb").read_bytes() == b"modified room"
    assert (final / "room_layout.json").read_text() == layout
    assert (final / "Object" / "Cup0.glb").read_bytes() == b"cup"
    assert (run.out / "room" / "Objects" / "Procedural").resolve() == (small.scene_dir / "room/Objects/Procedural")

    (small.scene_dir / "preview" / "Room.blend").write_bytes(b"author built again")
    with pytest.raises(ValueError, match="another author room"):
        Pass(small.scene_dir, out=tmp_path / "articulate")
    monkeypatch.setenv("LR_ARTICULATE_SOURCE", str(small.scene_dir / "preview"))  # no receipt
    with pytest.raises(ValueError, match="not a published room preview"):
        Pass(small.scene_dir, out=tmp_path / "articulate")


# ── server/run_room.py in pass mode, with stand-ins at its process boundaries ──────────────

ROOT = Path(__file__).resolve().parents[2]
CARD = "GPU-00000000-0000-0000-0000-000000000001"


def launch(tmp_path, *args):
    import os
    import subprocess
    import sys

    def executable(path, source):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!{sys.executable}\n" + source)
        path.chmod(0o755)

    runtime = tmp_path / "runtime"
    executable(runtime / "bin/nvidia-smi", f"""
import sys
if "--query-gpu=uuid" in sys.argv:
    print("{CARD}")
elif "--query-gpu=index,uuid,memory.used" in sys.argv:
    print("0,{CARD},12")
""")
    executable(runtime / "litereality-env/bin/python", """
import os, sys
from pathlib import Path
if "-c" in sys.argv:
    print(Path(os.environ["LR_REPO_ROOT"]) / "src/litereality_agent/__init__.py")
    sys.exit()
out = Path(sys.argv[sys.argv.index("--out") + 1])
if sys.argv[2].endswith(".premake"):
    (out / "TissueBox.glb").write_bytes(b"premade")
elif "--through" not in sys.argv:
    (out / "room_preview").mkdir(parents=True, exist_ok=True)
    (out / "room_preview" / "Room.glb").write_bytes(b"room of " + out.name.encode())
""")
    env = dict(os.environ, ROOMCANVAS_HOME=str(tmp_path), CUDA_VISIBLE_DEVICES="0",
               ROOMCANVAS_GPU="0", ROOMCANVAS_GPU_LOCK_DIR=str(tmp_path / "locks"),
               PATH=str(runtime / "bin") + os.pathsep + os.environ["PATH"])
    env.pop("VIEWFORGE_GPU_LOCK", None)
    result = subprocess.run([sys.executable, str(ROOT / "room-reconstruction/server/run_room.py"), *args],
                            env=env, timeout=20, capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_passes_run_alone_write_the_records_a_full_run_writes(tmp_path):
    run = tmp_path / "run"
    scene = run / "pipeline" / "scan"
    traces = scene / "scene_init/obj_stage/traces"
    traces.mkdir(parents=True)
    (scene / "scene.json").write_text("{}")

    def rows():
        return [json.loads(line) for line in (traces / "trace.jsonl").read_text().splitlines()]

    launch(tmp_path, "--small-objects", str(scene), str(run / "small-objects"))
    (saved,) = rows()
    small = run / "small-objects/room_preview/Room.glb"
    assert (saved["kind"], saved["model"], saved["stage"]) == ("model_saved", "small_objects", "small_objects")
    assert saved["path"] == str(small.resolve()) and saved["run_path"] == "small-objects/room_preview/Room.glb"
    assert saved["run"] == saved["attempt_id"] == "attempt-01"
    assert saved["artifact_digest"] == telemetry.artifact_digest(small)

    source = run / "small-objects/room_preview"
    launch(tmp_path, "--articulate", str(scene), str(run / "articulate"), "--set", f"LR_ARTICULATE_SOURCE={source}")
    start, done, model = rows()[1:]
    articulated = run / "articulate/room_preview/Room.glb"
    assert [start["kind"], done["kind"], model["kind"]] == ["articulate_start", "articulate_done", "model_saved"]
    assert start["source"] == str(source) and (done["status"], done["exit"]) == ("ok", 0)
    assert model["model"] == "articulated" and model["path"] == str(articulated.resolve())
    assert {r["stage"] for r in (start, done, model)} == {"articulate"}
    assert (run / "articulate/attempt-01/exit").read_text().strip() == "0"

    # A pass stopped early publishes no room, and the replay hears nothing of it.
    launch(tmp_path, "--articulate", str(scene), str(run / "articulate"), "--through", "views")
    launch(tmp_path, "--small-objects", str(scene), str(run / "small-objects"), "--through", "evidence")
    assert len(rows()) == 4


def test_premake_mode_runs_the_premake_module_with_its_own_attempt_record(tmp_path):
    photos, models = tmp_path / "by-kind", tmp_path / "models"
    (photos / "TissueBox").mkdir(parents=True)
    launch(tmp_path, "--premake-small-objects", str(photos), str(models), "--only", "TissueBox")
    attempt = models / "attempt-01"
    config = json.loads((attempt / "run-config.json").read_text())
    assert config["command"] == [
        str(tmp_path / "runtime/litereality-env/bin/python"), "-m",
        "litereality_agent.pipeline.realism_authoring.small_objects.premake", str(photos.resolve()),
        "--out", str(models.resolve()), "--only", "TissueBox"]
    assert "then" not in config  # no openable-parts pass after it
    assert (attempt / "exit").read_text().strip() == "0" and (attempt / "pipeline.log").is_file()
    assert (models / "TissueBox.glb").read_bytes() == b"premade"
