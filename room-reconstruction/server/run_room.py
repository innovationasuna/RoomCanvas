#!/usr/bin/env python3
"""Run the reconstruction module on the 3090 server, configuring only machine paths and keys.

usage: run_room.py SCAN RUN_DIR [--from STAGE] [--through STAGE] [--repair-rounds N] [--revise]
                   [--repair-steps N] [--repair-seconds S] [--set KEY=VALUE ...] [--no-articulate]
                   [--check]
       run_room.py --small-objects SCENE_DIR OUT_DIR [--check]
       run_room.py --articulate SCENE_DIR OUT_DIR [--through STEP] [--only ID ...] [--check]
       run_room.py --premake-small-objects PHOTOS_DIR OUT_DIR [--only KIND ...] [--check]

The code that runs is this checkout's room-reconstruction/. Runtimes, model weights and the private
.env come from $ROOMCANVAS_HOME. --set records each configuration workaround explicitly in
run-config.json. --check prints what would run and exits without creating anything.

Author builds the room in one session, then completes it before checking it: the small-object pass
(rebuilds from the photos, or drops, the small things the session marked with mark_small, and
drops, keeps or rebuilds what it still modelled itself) and the
openable-parts pass (Astra decides per object whether it has parts that open and where, Blender cuts
them out and hinges them) run on that build, into the scene's realism_authoring/small_objects/ and
realism_authoring/articulate/ (see realism_authoring/passes.py). The complete room is checked once
(support, then a pass/fail visual review, no score); if it fails, one repair edits Room.py and its
rebuilt room goes through both passes again (each keeps the work of what the repair left unchanged)
and is the result (--repair-rounds 0 only checks: a room that fails then ends as needs_repair,
unpublished). Publish publishes that room in the scene's realism_authoring/room_preview/.
--no-articulate leaves out the openable parts. --revise (with --from author) opens one more
authoring session on the finished room, for follow-up requests written into the LR_AUTHOR_EXTRA
material; the room is kept and goes through the same passes, check and publish again.

--premake-small-objects makes OUT_DIR/<Kind>.glb from PHOTOS_DIR/<Kind>/*.jpg before the author
stage, so the GPU is free again while it runs. Given --set LR_SMALL_OBJECTS_MODELS=OUT_DIR, the
author session finds them copied into the room as Models/<Kind>.glb and places them itself
(small_objects/ready.py); a small thing it still marked or modelled itself gets its model from the
pass by name (see small_objects/premake.py).

--small-objects and --articulate run one pass on its own over a finished run's scene directory
(runs/<run>/pipeline/<scene>), writing to OUT_DIR and leaving the finished run untouched: for rooms
published before the passes were part of author, whose published room has neither. Their room is
not checked. The replay sees them by their records (articulate_start, articulate_done, model_saved
articulated; a complete --small-objects pass adds model_saved small_objects). To articulate such a
room WITH the small objects, run --small-objects into RUN_DIR/small-objects, then --articulate into
RUN_DIR/articulate with --set LR_ARTICULATE_SOURCE=RUN_DIR/small-objects/room_preview.
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
p.add_argument("--revise", action="store_true", help="one more authoring session on the finished room")
p.add_argument("--repair-steps", help="tool calls of the one repair (the CLI's default when not given)")
p.add_argument("--repair-seconds", help="wall seconds of the one repair (the CLI's default when not given)")
p.add_argument("--small-objects", action="store_true", help="run the small-object pass instead")
p.add_argument("--articulate", action="store_true", help="run the openable-parts pass instead")
p.add_argument("--premake-small-objects", action="store_true",
               help="make small-object models from photos by kind instead")
p.add_argument("--only", nargs="*", help="with a pass: only these objects")
p.add_argument("--no-articulate", action="store_true",
               help="a full run: author leaves out the openable parts before its check")
p.add_argument("--wait-gpu", action="store_true", help="wait until an allowed GPU is available")
p.add_argument("--check", action="store_true", help="print the configuration and exit")
a = p.parse_args()
if a.premake_small_objects and a.through:
    p.error("--premake-small-objects has no --through")

env = dict(os.environ)
env.update(read_env_file(HOME / ".env"))  # keys and image settings only
for key in ("ROOMCANVAS_GPU", "CUDA_VISIBLE_DEVICES", "ROOMCANVAS_GPU_LOCK_DIR", "ROOMCANVAS_GPU_SHARED_MIB",
            "ROOMCANVAS_GPU_PEAK_MIB", "ROOMCANVAS_GPU_HEADROOM_MIB", "ROOMCANVAS_TRELLIS_PEAK_MIB"):
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
if a.revise:
    cmd += ["--revise"]
if a.no_articulate:
    cmd += ["--no-articulate"]
for flag, value in (("--repair-steps", a.repair_steps), ("--repair-seconds", a.repair_seconds)):
    cmd += [flag, value] if value else []
if a.from_stage:
    cmd += ["--from", a.from_stage]
if a.through:
    cmd += ["--through", a.through]
if a.small_objects or a.articulate or a.premake_small_objects:
    module = ("small_objects.premake" if a.premake_small_objects
              else "small_objects" if a.small_objects else "articulate")
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
if a.check:
    print(json.dumps(record, indent=2))
    raise SystemExit(0)

a.run_dir.mkdir(parents=True, exist_ok=True)
attempts = sorted(a.run_dir.glob("attempt-*"))
attempt = a.run_dir / f"attempt-{len(attempts) + 1:02d}"
attempt.mkdir()
# A shared machine can name the card (ROOMCANVAS_GPU, default auto) and accept other people's light
# use of it (ROOMCANVAS_GPU_SHARED_MIB, default 0: only a completely idle card) when the card still has
# room for this run's peak (gpu.py); the small objects' TRELLIS waits for room for its own.
def trace(scene: Path, kind: str, **data) -> None:
    """One record in the scene's trace for the reconstruction replay (as telemetry.record writes it)."""
    traces = scene / "scene_init/obj_stage/traces"
    sys.path.insert(0, str(RECON / "src"))
    from litereality_agent import telemetry

    data.update(run=attempt.name, attempt_id=attempt.name,
                job_id=env.get("LITEREALITY_JOB_ID") or str(a.run_dir.resolve()))
    data.setdefault("stage", "articulate")
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
    # Until the lease is ours this attempt only waits; the web job status reads this marker.
    timing["gpu_waiting_since"] = time.time()
    save_timing()
    try:
        with room_lease(runtime, env, wait=a.wait_gpu) as selected:
            acquired = time.monotonic()
            del timing["gpu_waiting_since"]
            timing.update(gpu_wait_seconds=acquired-waiting, gpu_uuid=selected[0].uuid)
            save_timing()
            yield selected
    except RuntimeError as error:
        if acquired is not None:
            raise
        timing["gpu_error"] = str(error)
        raise SystemExit(f"GPU not acquired: {error}") from None
    finally:
        if acquired is None:
            timing.pop("gpu_waiting_since", None)
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


def articulated(scene: Path, command, out: Path, log_name: str, phase: str, lease) -> int:
    """The openable-parts pass on its own (--articulate) between the records the replay shows it by
    (author records them itself when it runs the pass); its room is out/room_preview."""
    source = env.get("LR_ARTICULATE_SOURCE")
    trace(scene, "articulate_start", **({"source": source} if source else {}))
    with (attempt / log_name).open("w") as log:
        art = run_timed(command, log, phase, lease)
    room = out / "room_preview/Room.glb"
    trace(scene, "articulate_done", status="ok" if not art and room.is_file() else "failed", exit=art)
    if not art and room.is_file():
        from litereality_agent.telemetry import saved_joints
        trace(scene, "model_saved", model="articulated", path=str(room.resolve()), at=room.stat().st_mtime,
              **saved_joints(out, attempt.name))
    return art


with measured_lease() as (gpu, lease):
    # One run id for every stage process of this attempt: the replay tells a retried run from the one before.
    env.update(CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=gpu.uuid,
               LR_VISION_LOG_DIR=str(attempt / "vision"), LITEREALITY_RUN_ID=attempt.name)
    record = {"started": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
              "gpu": gpu.uuid, "gpu_used_by_others_mib": gpu.memory_used_mib, **record}
    (attempt / "run-config.json").write_text(json.dumps(record, indent=2))
    # A pass that stops early (--through, --only) writes no room, so the replay is told nothing.
    complete = not (a.through or a.only)
    if a.articulate and complete:
        rc = articulated(a.scan.resolve(), cmd, a.run_dir.resolve(), "pipeline.log", "pipeline", lease)
    else:
        with (attempt / "pipeline.log").open("w") as log:
            rc = run_timed(cmd, log, "pipeline", lease)
    (attempt / "exit").write_text(f"{rc}\n")
    print(attempt.name, "exit", rc)
    small = a.run_dir.resolve() / "room_preview/Room.glb"
    if a.small_objects and complete and rc == 0 and small.is_file():
        scene = a.scan.resolve()
        trace(scene, "model_saved", model="small_objects", stage="small_objects", path=str(small),
              run_path=os.path.relpath(small, scene.parents[1]), at=small.stat().st_mtime)
    raise SystemExit(rc)
