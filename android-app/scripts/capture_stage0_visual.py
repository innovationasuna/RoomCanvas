#!/usr/bin/env python3
import argparse
import json
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

from run_stage0_device import ADB, ENV, EXPERIMENTS, OUTPUT as STAGE0_ROOT, adb, battery_state

VIEWS = (("entry", "02-entry.png"), ("piano", "01-piano.png"))


def resolve_output(value):
    """--output-dir 相对路径按阶段0根目录解析，与采样脚本保持一致。"""
    path = STAGE0_ROOT if not value else Path(value)
    if value and not path.is_absolute():
        path = STAGE0_ROOT / path
    path.mkdir(parents=True, exist_ok=True)
    return path


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


def validate_tag(tag):
    if tag is None:
        return
    if not re.fullmatch(r"[A-Za-z0-9._-]+", tag) or tag in (".", ".."):
        raise ValueError(f"Unsafe --tag value: {tag!r}")


def capture_view(experiment, view, output_name, output, tag=None):
    directory_name = experiment if not tag else f"{experiment}-{tag}"
    directory = output / "visual" / directory_name
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
    parser.add_argument("--tag")
    parser.add_argument(
        "--output-dir",
        help="输出目录；相对路径按“阶段0”根目录解析，默认阶段0根目录",
    )
    args = parser.parse_args()
    validate_tag(args.tag)
    output = resolve_output(args.output_dir)
    battery_before = battery_state()
    for view, output_name in VIEWS:
        capture_view(args.experiment, view, output_name, output, args.tag)
        directory_name = args.experiment if not args.tag else f"{args.experiment}-{args.tag}"
        print(f"Saved {output / 'visual' / directory_name / output_name}")
    metadata = {
        "experiment": args.experiment,
        "capturedAt": datetime.now().astimezone().isoformat(),
        "batteryBefore": battery_before,
        "batteryAfter": battery_state(),
        "note": "Exact controller poses are set through the debug-only capture intent. These visual captures are independent of performance runs.",
    }
    directory_name = args.experiment if not args.tag else f"{args.experiment}-{args.tag}"
    directory = output / "visual" / directory_name
    (directory / "capture-meta.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (directory / "capture.log").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
