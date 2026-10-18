#!/usr/bin/env python3
"""Run the reconstruction module on the 3090 server, configuring only machine paths and keys.

usage: run_room.py SCAN RUN_DIR [--from STAGE] [--through STAGE] [--repair-rounds N]
                   [--set KEY=VALUE ...] [--check]
       run_room.py --small-objects SCENE_DIR OUT_DIR [--check]

The code that runs is this checkout's room-reconstruction/. Runtimes, model weights and the private
.env come from $ROOMCANVAS_HOME. --set records each configuration workaround explicitly in
run-config.json. --check prints what would run and exits without creating anything.

Author repairs after its visual review default to 1 round here (official default 2), to save
model calls. --small-objects runs the small-object pass on a finished run's scene directory
(runs/<run>/pipeline/<scene>) and writes to OUT_DIR, leaving the finished run untouched.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
from pathlib import Path

from gpu import GpuLock, list_gpus, select_gpu

CHECKOUT = Path(__file__).resolve().parents[2]  # this RoomCanvas checkout
RECON = CHECKOUT / "room-reconstruction"  # the LiteReality-based module inside it
HOME = Path(os.environ.get("ROOMCANVAS_HOME", "/workspace/geyinuo/RoomCanvas"))
SECRET_NAME = re.compile(r"KEY|TOKEN|SECRET|PASSWORD", re.I)  # never printed or recorded


def read_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines; ignores blanks, comments and an optional `export` prefix."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.removeprefix("export ").split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(CHECKOUT), *args], capture_output=True,
                          text=True).stdout.strip()


p = argparse.ArgumentParser()
p.add_argument("scan", type=Path)
p.add_argument("run_dir", type=Path)
p.add_argument("--from", dest="from_stage")
p.add_argument("--through")
p.add_argument("--set", action="append", default=[])
p.add_argument("--repair-rounds", default="1", choices="0123", help="author repair rounds")
p.add_argument("--small-objects", action="store_true", help="run the small-object pass instead")
p.add_argument("--check", action="store_true", help="print the configuration and exit")
a = p.parse_args()

env = dict(os.environ)
env.update(read_env_file(HOME / ".env"))  # keys and image settings only
for key in ("LR_AGENT_PROVIDER",):  # leave provider choice to the code's defaults
    env.pop(key, None)
runtime, weights = HOME / "runtime", HOME / "backends/weights"
machine = {  # where things are on this machine
    "LR_REPO_ROOT": str(RECON),
    "LITEREALITY_WEIGHTS": str(weights),
    "LITEREALITY_DINOV3": str(weights / "dinov3"),
    "LITEREALITY_BLENDER": str(runtime / "blender/blender-5.1.2-linux-x64"),
    "TRELLIS_PYTHON": str(runtime / "trellis-env/bin/python"),
    "GROUNDING_DINO_PYTHON": str(runtime / "trellis-env/bin/python"),
    "LR_DINO_MODEL": str(weights / "grounding-dino-tiny"),
    "LR_DINO_EMBED_MODEL": str(weights / "dinov2-small"),
    "LITEREALITY_TRELLIS_LAUNCHER": str(Path(__file__).resolve().with_name("trellis_local.py")),
    "ROOMCANVAS_HOME": str(HOME),
    "PYTHONPATH": f"{RECON}/src:{HOME}/backends/TRELLIS.2",
    "PATH": f"{runtime}/bin:{runtime}/litereality-env/bin:{env['PATH']}",
    "LD_LIBRARY_PATH": ":".join([f"{runtime}/cuda-12.4/lib",
        f"{runtime}/trellis-env/lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib",
        f"{runtime}/system-libs/lib/usr/lib/x86_64-linux-gnu"]),
}
env.update(machine)
workarounds = dict(item.split("=", 1) for item in a.set)
env.update(workarounds)

# The runtime env also has an older checkout installed; if PYTHONPATH ever stops pointing here,
# that copy would run instead without any error. Refuse to start unless this checkout is loaded.
probe = subprocess.run(
    [str(runtime / "litereality-env/bin/python"), "-c",
     "import litereality_agent; print(litereality_agent.__file__)"],
    env=env, capture_output=True, text=True)
package = Path(probe.stdout.strip() or "?")
if not package.is_relative_to(RECON / "src"):
    raise SystemExit(f"litereality_agent loads from {package}, not {RECON / 'src'}\n{probe.stderr}")

target = a.scan if not a.from_stage else a.run_dir / "pipeline" / a.scan.name
cmd = [str(runtime / "litereality-env/bin/litereality"), "run", str(target),
       "--author-profile", "open", "--output-root", str(a.run_dir / "pipeline"),
       "--repair-rounds", a.repair_rounds]
if a.from_stage:
    cmd += ["--from", a.from_stage]
if a.through:
    cmd += ["--through", a.through]
if a.small_objects:
    cmd = [str(runtime / "litereality-env/bin/python"), "-m",
           "litereality_agent.pipeline.realism_authoring.small_objects", str(a.scan.resolve()),
           "--out", str(a.run_dir.resolve())]
record = {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain")),
          "package": str(package), "command": cmd, "machine_config": sorted(machine),
          "workarounds": workarounds,
          "model_settings": {k: env[k] for k in sorted(env)
                             if k.startswith(("LR_", "HARNESS_")) and not SECRET_NAME.search(k)}}
if a.check:
    print(json.dumps(record, indent=2))
    raise SystemExit(0)

a.run_dir.mkdir(parents=True, exist_ok=True)
attempts = sorted(a.run_dir.glob("attempt-*"))
attempt = a.run_dir / f"attempt-{len(attempts) + 1:02d}"
attempt.mkdir()
gpu = select_gpu("auto", list_gpus())
env.update(CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=str(gpu.index),
           LR_VISION_LOG_DIR=str(attempt / "vision"))
record = {"started": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
          "gpu": gpu.uuid, **record}
(attempt / "run-config.json").write_text(json.dumps(record, indent=2))
with GpuLock(runtime / "locks", gpu), (attempt / "pipeline.log").open("w") as log:
    rc = subprocess.run(cmd, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
(attempt / "exit").write_text(f"{rc}\n")
print(attempt.name, "exit", rc)
