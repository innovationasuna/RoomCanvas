"""Run the server launcher with small stand-ins at its external process boundaries."""
import json
import os
import subprocess
import sys
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
    for name in ("exit", "articulate-exit"):
        assert (attempt / name).read_text().strip() == "0", (attempt / "pipeline.log").read_text()
