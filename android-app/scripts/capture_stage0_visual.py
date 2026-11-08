#!/usr/bin/env python3
import argparse
import json
import subprocess
import time
from datetime import datetime

from run_stage0_device import ADB, ENV, EXPERIMENTS, OUTPUT, adb, battery_state

VIEWS = (("entry", "02-entry.png"), ("piano", "01-piano.png"))


def capture(path):
    result = subprocess.run(
        [ADB, "exec-out", "screencap", "-p"],
        env=ENV,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if not result.stdout.startswith(b"\x89PNG\r\n\x1a\n"):
        raise RuntimeError(f"Screenshot failed for {path.name}: {result.stderr.decode(errors='replace')}")
    path.write_bytes(result.stdout)


def capture_view(experiment, view, output_name):
    directory = OUTPUT / "visual" / experiment
    directory.mkdir(parents=True, exist_ok=True)
    log_path = directory / f"capture-{view}.log"
    adb("logcat", "-c")
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [ADB, "logcat", "-v", "threadtime", "-s", "VrWalkthrough:I"],
            env=ENV,
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            adb("shell", "input", "keyevent", "224")
            adb("shell", "input", "keyevent", "82")
            time.sleep(3)
            adb(
                "shell", "am", "start", "--activity-single-top",
                "-a", "com.hausen3d.arviewer.action.DEBUG_CAPTURE_VIEW",
                "-n", "com.hausen3d.arviewer/.VrWalkthroughActivity",
                "--es", "experiment", experiment,
                "--es", "view", view,
                capture=True,
            )
            deadline = time.monotonic() + 30
            marker = f"VisualCapture experiment={experiment} view={view}"
            while marker not in log_path.read_text(encoding="utf-8", errors="replace"):
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Capture view was not applied: {experiment} {view}")
                time.sleep(0.25)
            time.sleep(3)
            capture(directory / output_name)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description="Capture exact fixed-pose visual A/B images")
    parser.add_argument("--experiment", choices=EXPERIMENTS, required=True)
    args = parser.parse_args()
    battery_before = battery_state()
    for view, output_name in VIEWS:
        capture_view(args.experiment, view, output_name)
        print(f"Saved {OUTPUT / 'visual' / args.experiment / output_name}")
    metadata = {
        "experiment": args.experiment,
        "capturedAt": datetime.now().astimezone().isoformat(),
        "batteryBefore": battery_before,
        "batteryAfter": battery_state(),
        "note": "Exact controller poses are set through the debug-only capture intent. These visual captures are independent of performance runs.",
    }
    directory = OUTPUT / "visual" / args.experiment
    (directory / "capture-meta.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (directory / "capture.log").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
