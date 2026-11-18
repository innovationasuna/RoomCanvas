#!/usr/bin/env python3
"""Run the reconstruction module on the 3090 server, configuring only machine paths and keys.

usage: run_room.py SCAN RUN_DIR [--from STAGE] [--through STAGE] [--repair-rounds N]
                   [--set KEY=VALUE ...] [--no-articulate] [--check]
       run_room.py --small-objects SCENE_DIR OUT_DIR [--check]
       run_room.py --articulate SCENE_DIR OUT_DIR [--through STEP] [--only ID ...] [--check]

The code that runs is this checkout's room-reconstruction/. Runtimes, model weights and the private
.env come from $ROOMCANVAS_HOME. --set records each configuration workaround explicitly in
run-config.json. --check prints what would run and exits without creating anything.

Author checks the room once (support, then a pass/fail visual review, no score); if it fails,
one repair runs and its rebuilt room is the result (--repair-rounds 0 only checks). --small-objects runs the small-object pass on a finished run's scene directory
(runs/<run>/pipeline/<scene>) and writes to OUT_DIR, leaving the finished run untouched.
--articulate does the same for openable parts: Astra decides per object whether it has parts that
open and where, Blender cuts them out and hinges them (see realism_authoring/articulate/).

A full run does that pass by default once author has written its room: into RUN_DIR/articulate/
(its room_preview/ is the room to use; the author's own and the published one stay without the
new parts). --no-articulate skips it; a rerun picks it up where it stopped.
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from gpu import room_lease

CHECKOUT = Path(__file__).resolve().parents[2]  # this RoomCanvas checkout
RECON = CHECKOUT / "room-reconstruction"  # the LiteReality-based module inside it
HOME = Path(os.environ.get("ROOMCANVAS_HOME", CHECKOUT))
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


def scene_dirs(run_dir: Path) -> list[Path]:
    """Scene directories a run has written. The pipeline names them (hausen_room3 for a scan
    folder room3), so they are found by their scene.json rather than by the scan's name."""
    return [d for d in sorted((run_dir / "pipeline").glob("*")) if (d / "scene.json").is_file()]


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(CHECKOUT), *args], capture_output=True,
                          text=True).stdout.strip()


p = argparse.ArgumentParser()
p.add_argument("scan", type=Path)
p.add_argument("run_dir", type=Path)
p.add_argument("--from", dest="from_stage")
p.add_argument("--through")
p.add_argument("--set", action="append", default=[])
p.add_argument("--repair-rounds", default="1", choices="01", help="repair once when the check fails (0: check only)")
p.add_argument("--small-objects", action="store_true", help="run the small-object pass instead")
p.add_argument("--articulate", action="store_true", help="run the openable-parts pass instead")
p.add_argument("--only", nargs="*", help="with a pass: only these objects")
p.add_argument("--no-articulate", action="store_true",
               help="a full run: do not run the openable-parts pass after author")
p.add_argument("--wait-gpu", action="store_true", help="wait until an allowed GPU is available")
p.add_argument("--check", action="store_true", help="print the configuration and exit")
a = p.parse_args()

env = dict(os.environ)
env.update(read_env_file(HOME / ".env"))  # keys and image settings only
for key in ("ROOMCANVAS_GPU", "CUDA_VISIBLE_DEVICES", "ROOMCANVAS_GPU_LOCK_DIR", "ROOMCANVAS_GPU_SHARED_MIB"):
    if key in os.environ:
        env[key] = os.environ[key]  # the launcher's explicit device restrictions take precedence
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

target = a.scan
if a.from_stage:  # resume the run's own scene; without one the CLI starts it from the scan
    found = scene_dirs(a.run_dir)
    if len(found) > 1:
        raise SystemExit(f"--from: more than one scene under {a.run_dir / 'pipeline'}: "
                         + ", ".join(d.name for d in found))
    target = found[0] if found else a.scan
cmd = [str(runtime / "litereality-env/bin/litereality"), "run", str(target),
       "--author-profile", "open", "--output-root", str(a.run_dir / "pipeline"),
       "--repair-rounds", a.repair_rounds]
if a.from_stage:
    cmd += ["--from", a.from_stage]
if a.through:
    cmd += ["--through", a.through]
if a.small_objects or a.articulate:
    module = "small_objects" if a.small_objects else "articulate"
    cmd = [str(runtime / "litereality-env/bin/python"), "-m",
           f"litereality_agent.pipeline.realism_authoring.{module}", str(a.scan.resolve()),
           "--out", str(a.run_dir.resolve())]
    cmd += ["--through", a.through] if a.through else []
    cmd += ["--only", *a.only] if a.only else []
record = {"commit": git("rev-parse", "HEAD"), "dirty": bool(git("status", "--porcelain")),
          "package": str(package), "command": cmd, "machine_config": sorted(machine),
          "workarounds": workarounds,
          "model_settings": {k: env[k] for k in sorted(env)
                             if k.startswith(("LR_", "HARNESS_")) and not SECRET_NAME.search(k)}}
# A full run that reaches author is followed by the openable-parts pass on the author's room.
articulate = None
if not (a.small_objects or a.articulate or a.no_articulate) and \
        a.through not in ("ingest", "reconstruct", "seed"):
    articulate = [str(runtime / "litereality-env/bin/python"), "-m",
                  "litereality_agent.pipeline.realism_authoring.articulate",
                  "<scene dir under RUN_DIR/pipeline>", "--out",
                  str((a.run_dir / "articulate").resolve())]
    record["then"] = articulate
if a.check:
    print(json.dumps(record, indent=2))
    raise SystemExit(0)

a.run_dir.mkdir(parents=True, exist_ok=True)
attempts = sorted(a.run_dir.glob("attempt-*"))
attempt = a.run_dir / f"attempt-{len(attempts) + 1:02d}"
attempt.mkdir()
# A shared machine can name the card (ROOMCANVAS_GPU, default auto) and accept other people's light
# use of it (ROOMCANVAS_GPU_SHARED_MIB, default 0: only a completely idle card).
def trace(scene: Path, kind: str, **data) -> None:
    """One record in the scene's trace for the reconstruction replay (as telemetry.record writes it)."""
    traces = scene / "scene_init/obj_stage/traces"
    sys.path.insert(0, str(RECON / "src"))
    from litereality_agent import telemetry

    data.update(run=attempt.name, attempt_id=attempt.name,
                job_id=env.get("LITEREALITY_JOB_ID") or str(a.run_dir.resolve()), stage="articulate")
    if kind == "model_saved" and data.get("path"):
        telemetry.record_artifact(traces, kind, data["path"], **data)
    else:
        telemetry.record(traces, kind, **data)


timing = {"attempt_id": attempt.name, "phases": [], "gpu_kernel_seconds": None}


def save_timing():
    temporary = attempt / "runtime-timing.tmp"
    try:
        temporary.write_text(json.dumps(timing, indent=2))
        temporary.replace(attempt / "runtime-timing.json")
    except OSError:
        # Observations must not turn an otherwise usable paid run into a failure.
        print("Runtime timing could not be written", file=sys.stderr)


@contextmanager
def measured_lease():
    waiting = time.monotonic()
    acquired = None
    try:
        with room_lease(runtime, env, wait=a.wait_gpu) as selected:
            acquired = time.monotonic()
            timing.update(gpu_wait_seconds=acquired-waiting, gpu_uuid=selected[0].uuid)
            save_timing()
            yield selected
    finally:
        if acquired is None:
            timing.update(gpu_wait_seconds=time.monotonic()-waiting, gpu_lease_seconds=0.)
        else:
            timing["gpu_lease_seconds"] = time.monotonic()-acquired
        save_timing()


def run_timed(command, log, phase, lease):
    sys.path.insert(0, str(RECON / "src"))
    from litereality_agent.timing import Measurement
    measurement = Measurement()
    row = {"phase": phase, "exit": None}
    try:
        row["exit"] = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                                     pass_fds=lease.fds).returncode
        return row["exit"]
    finally:
        timing["phases"].append({**row, **measurement.finish()})
        save_timing()


with measured_lease() as (gpu, lease):
    # One run id for every stage process of this attempt: the replay tells a retried run from the one before.
    env.update(CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=gpu.uuid,
               LR_VISION_LOG_DIR=str(attempt / "vision"), LITEREALITY_RUN_ID=attempt.name)
    record = {"started": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"),
              "gpu": gpu.uuid, "gpu_used_by_others_mib": gpu.memory_used_mib, **record}
    (attempt / "run-config.json").write_text(json.dumps(record, indent=2))
    with (attempt / "pipeline.log").open("w") as log:
        rc = run_timed(cmd, log, "pipeline", lease)
    (attempt / "exit").write_text(f"{rc}\n")
    print(attempt.name, "exit", rc)
    # Only a successful current pipeline may feed enhancement. A failed retry can
    # leave yesterday's preview beside its partial source.
    scenes = [d for d in scene_dirs(a.run_dir)
              if (d / "realism_authoring/room_preview/Room.blend").is_file()
              and (d / "realism_authoring/room_preview/room_layout.json").is_file()]


    art = 0
    if rc == 0 and articulate and len(scenes) == 1:
        articulate[articulate.index("<scene dir under RUN_DIR/pipeline>")] = str(scenes[0].resolve())
        trace(scenes[0], "articulate_start")
        with (attempt / "articulate.log").open("w") as log:
            art = run_timed(articulate, log, "articulate", lease)
        (attempt / "articulate-exit").write_text(f"{art}\n")
        room = a.run_dir / "articulate/room_preview/Room.glb"
        trace(scenes[0], "articulate_done", status="ok" if not art and room.is_file() else "failed", exit=art)
        if not art and room.is_file():
            trace(scenes[0], "model_saved", model="articulated", path=str(room.resolve()), at=room.stat().st_mtime)
        print(attempt.name, "articulate exit", art, "->", a.run_dir / "articulate" / "room_preview")
    raise SystemExit(rc or art)
