"""Run the server launcher with small stand-ins at its external process boundaries."""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CARD = "GPU-00000000-0000-0000-0000-000000000001"


def executable(path, source):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"#!{sys.executable}\n" + source)
    path.chmod(0o755)


def test_room_launcher_owns_gpu_during_pipeline_and_followup_articulation(tmp_path):
    runtime = tmp_path / "runtime"
    executable(runtime / "bin/nvidia-smi", f"""
import sys
if "--query-gpu=uuid" in sys.argv:
    print("{CARD}")
elif "--query-gpu=index,uuid,memory.used" in sys.argv:
    print("0,{CARD},12")
""")
    stage = f"""
import os, sys
from pathlib import Path
if "-c" in sys.argv:
    print(Path(os.environ["LR_REPO_ROOT"]) / "src/litereality_agent/__init__.py")
    sys.exit()
sys.path.insert(0, {str(ROOT / "scripts")!r})
from roomcanvas_gpu import object_lease
assert os.environ["CUDA_VISIBLE_DEVICES"] == {CARD!r}
try:
    with object_lease(Path(os.environ["ROOMCANVAS_HOME"]) / "objects"):
        raise AssertionError("another object job acquired the GPU during " + repr(sys.argv))
except BlockingIOError:
    pass
if "--output-root" in sys.argv:
    scene = Path(sys.argv[sys.argv.index("--output-root") + 1]) / "scan"
    preview = scene / "realism_authoring/room_preview"
    preview.mkdir(parents=True)
    for path in [scene / "scene.json", preview / "Room.blend", preview / "room_layout.json"]:
        path.touch()
else:
    assert "--out" in sys.argv
"""
    for name in ("python", "litereality"):
        executable(runtime / "litereality-env/bin" / name, stage)
    env = dict(os.environ, ROOMCANVAS_HOME=str(tmp_path), CUDA_VISIBLE_DEVICES="0",
               ROOMCANVAS_GPU="0", ROOMCANVAS_GPU_LOCK_DIR=str(tmp_path / "locks"),
               PATH=str(runtime / "bin") + os.pathsep + os.environ["PATH"])
    env.pop("VIEWFORGE_GPU_LOCK", None)
    run = tmp_path / "run"
    subprocess.run([sys.executable, str(ROOT / "room-reconstruction/server/run_room.py"),
                    str(tmp_path / "scan"), str(run)], env=env, timeout=20, check=True)
    attempt = run / "attempt-01"
    assert json.loads((attempt / "run-config.json").read_text())["gpu"] == CARD
    timing = json.loads((attempt / "runtime-timing.json").read_text())
    assert [phase['phase'] for phase in timing['phases']] == ['pipeline', 'articulate']
    assert all(phase['exit'] == 0 and phase['wall_seconds'] > 0 for phase in timing['phases'])
    assert timing['gpu_uuid'] == CARD and timing['gpu_kernel_seconds'] is None
    assert timing['gpu_wait_seconds'] >= 0
    assert timing['gpu_lease_seconds'] >= sum(phase['wall_seconds'] for phase in timing['phases'])
    for name in ("exit", "articulate-exit"):
        assert (attempt / name).read_text().strip() == "0", (attempt / "pipeline.log").read_text()


def test_failed_pipeline_never_articulates_or_publishes_a_previous_preview(tmp_path):
    runtime = tmp_path / "runtime"
    executable(runtime / "bin/nvidia-smi", f"""
import sys
if "--query-gpu=uuid" in sys.argv:
    print("{CARD}")
elif "--query-gpu=index,uuid,memory.used" in sys.argv:
    print("0,{CARD},12")
""")
    called = tmp_path / "articulation-called"
    stage = f"""
import os, sys
from pathlib import Path
if "-c" in sys.argv:
    print(Path(os.environ["LR_REPO_ROOT"]) / "src/litereality_agent/__init__.py")
    sys.exit()
if "--output-root" in sys.argv:
    sys.exit(23)
Path({str(called)!r}).write_text("unexpected articulation")
"""
    for name in ("python", "litereality"):
        executable(runtime / "litereality-env/bin" / name, stage)
    run = tmp_path / "run"
    scene = run / "pipeline/scan"
    preview = scene / "realism_authoring/room_preview"
    preview.mkdir(parents=True)
    (scene / "scene.json").write_text("{}")
    for name in ("Room.blend", "room_layout.json"):
        (preview / name).write_bytes(b"previous preview")
    articulated = run / "articulate/room_preview/Room.glb"
    articulated.parent.mkdir(parents=True)
    articulated.write_bytes(b"previous articulated model")
    traces = scene / "scene_init/obj_stage/traces/trace.jsonl"
    traces.parent.mkdir(parents=True)
    original_trace = json.dumps({"t": 1, "kind": "trace_start", "run": "earlier"}) + "\n"
    traces.write_text(original_trace)
    previous = run / "attempt-01"
    previous.mkdir()
    (previous / "exit").write_text("0\n")
    (previous / "articulate-exit").write_text("0\n")
    env = dict(os.environ, ROOMCANVAS_HOME=str(tmp_path), CUDA_VISIBLE_DEVICES="0",
               ROOMCANVAS_GPU="0", ROOMCANVAS_GPU_LOCK_DIR=str(tmp_path / "locks"),
               PATH=str(runtime / "bin") + os.pathsep + os.environ["PATH"])
    env.pop("VIEWFORGE_GPU_LOCK", None)
    result = subprocess.run([sys.executable, str(ROOT / "room-reconstruction/server/run_room.py"),
                             str(tmp_path / "scan"), str(run)], env=env, timeout=20,
                            capture_output=True, text=True)
    assert result.returncode == 23, result.stdout + result.stderr
    attempt = run / "attempt-02"
    assert (attempt / "exit").read_text().strip() == "23"
    timing = json.loads((attempt / "runtime-timing.json").read_text())
    assert len(timing['phases']) == 1 and timing['phases'][0]['exit'] == 23
    assert not called.exists()
    assert not (attempt / "articulate-exit").exists()
    assert not (attempt / "articulate.log").exists()
    assert traces.read_text() == original_trace, "failed attempt must not publish model_saved or enhancement events"
    assert articulated.read_bytes() == b"previous articulated model"


def test_a_room_waiting_for_the_gpu_says_so_until_it_starts(tmp_path):
    runtime = tmp_path / "runtime"
    executable(runtime / "bin/nvidia-smi", f"""
import sys
if "--query-gpu=index,uuid,memory.used" in sys.argv:
    print("0,{CARD},12")
""")
    stage = """
import os, sys
from pathlib import Path
if "-c" in sys.argv:
    print(Path(os.environ["LR_REPO_ROOT"]) / "src/litereality_agent/__init__.py")
"""
    for name in ("python", "litereality"):
        executable(runtime / "litereality-env/bin" / name, stage)
    env = dict(os.environ, ROOMCANVAS_HOME=str(tmp_path), CUDA_VISIBLE_DEVICES=CARD, ROOMCANVAS_GPU=CARD,
               ROOMCANVAS_GPU_LOCK_DIR=str(tmp_path / "locks"), PATH=str(runtime / "bin") + os.pathsep + os.environ["PATH"])
    env.pop("VIEWFORGE_GPU_LOCK", None)
    sys.path.insert(0, str(ROOT / "scripts"))
    from roomcanvas_gpu import acquire
    run, timing = tmp_path / "run", tmp_path / "run/attempt-01/runtime-timing.json"
    command = [sys.executable, str(ROOT / "room-reconstruction/server/run_room.py"), str(tmp_path / "scan"), str(run),
               "--no-articulate"]
    with acquire(CARD, env, tmp_path / "objects/cache/gpu.lock"):
        refused = subprocess.run(command, env=env, timeout=20, capture_output=True, text=True)
        assert refused.returncode and "GPU not acquired" in refused.stderr
        assert "gpu_error" in json.loads(timing.read_text())
        waiting = subprocess.Popen(command + ["--wait-gpu"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        marker = run / "attempt-02/runtime-timing.json"
        for _ in range(100):
            if marker.is_file() and "gpu_waiting_since" in json.loads(marker.read_text()):
                break
            time.sleep(.1)
        else:
            raise AssertionError("a waiting room never said it was waiting")
    assert waiting.wait(timeout=20) == 0, waiting.stdout.read()
    assert "gpu_waiting_since" not in json.loads(marker.read_text())
