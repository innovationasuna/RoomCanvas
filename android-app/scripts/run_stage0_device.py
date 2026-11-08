#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

EXPERIMENTS = [
    "A0",
    "A1_DPCF",
    "A1_PCF",
    "A2",
    "A3_090",
    "A3_075",
    "A4_CASCADE2",
    "A4_MAP512",
    "A5",
    "A6",
    "A7",
]
ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "项目文档/手机端软件开发/光影渲染性能基线/阶段0"
ADB = os.environ.get("ADB", r"D:\Android\AndroidSDK\platform-tools\adb.exe")
ENV = dict(os.environ, MSYS_NO_PATHCONV="1")


def adb(*args, capture=False, check=True, cwd=None):
    result = subprocess.run(
        [ADB, *args],
        env=ENV,
        cwd=cwd,
        check=False,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.STDOUT if capture else None,
    )
    output = result.stdout.decode("utf-8", errors="replace") if capture else ""
    if check and result.returncode != 0:
        raise RuntimeError(f"ADB command failed ({result.returncode}): {args}\n{output}")
    return output


def battery_state():
    text = adb("shell", "dumpsys", "battery", capture=True)
    level = re.search(r"^\s*level:\s*(\d+)", text, re.MULTILINE)
    temperature = re.search(r"^\s*temperature:\s*(\d+)", text, re.MULTILINE)
    return {
        "levelPercent": int(level.group(1)) if level else None,
        "temperatureTenthsC": int(temperature.group(1)) if temperature else None,
    }


def wait_for_cooldown(threshold_tenths, max_seconds):
    if threshold_tenths is None:
        return
    started = time.monotonic()
    sleeping = False
    while True:
        temperature = battery_state()["temperatureTenthsC"]
        if temperature is None or temperature <= threshold_tenths:
            if sleeping:
                print(f"COOLED to {temperature / 10:.1f}C", flush=True)
            return
        elapsed = time.monotonic() - started
        if elapsed >= max_seconds:
            raise RuntimeError(
                f"Device remains too hot ({temperature / 10:.1f}C) after {max_seconds}s"
            )
        if not sleeping:
            print(f"COOLING from {temperature / 10:.1f}C to {threshold_tenths / 10:.1f}C", flush=True)
            adb("shell", "am", "force-stop", "com.hausen3d.arviewer")
            adb("shell", "input", "keyevent", "223")
            sleeping = True
        time.sleep(30)


def read_summary(log_path):
    if not log_path.is_file():
        return None
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        if "SUMMARY experiment=" not in line:
            continue
        values = dict(re.findall(r"(\w+)=([^\s]+)", line))
        return {"raw": line, "metrics": values}
    return None


def start_perfetto(experiment, run_number):
    trace_name = f"{experiment}-run{run_number}.pftrace"
    remote_trace = f"/data/misc/perfetto-traces/{trace_name}"
    local_trace = OUTPUT / trace_name
    console_log = (OUTPUT / f"{experiment}-run{run_number}-perfetto.log").open("wb")
    with (OUTPUT / "perfetto-config.pbtxt").open("rb") as config:
        process = subprocess.Popen(
            [ADB, "shell", "perfetto", "-c", "-", "--txt", "-o", remote_trace],
            env=ENV,
            stdin=config,
            stdout=console_log,
            stderr=subprocess.STDOUT,
        )
    return process, console_log, remote_trace, local_trace


def run_one(experiment, run_number, with_perfetto, cool_below_tenths=None, max_cooldown_seconds=900):
    log_path = OUTPUT / f"{experiment}-run{run_number}.log"
    meta_path = OUTPUT / f"{experiment}-run{run_number}-meta.json"
    existing = read_summary(log_path)
    if existing:
        print(f"SKIP {experiment} run {run_number}: summary already exists", flush=True)
        return

    print(f"BEGIN {experiment} run {run_number}", flush=True)
    wait_for_cooldown(cool_below_tenths, max_cooldown_seconds)
    battery_before = battery_state()
    started_at = datetime.now().astimezone().isoformat()
    adb("logcat", "-c")
    log_console = log_path.open("wb")
    log_process = subprocess.Popen(
        [ADB, "logcat", "-v", "threadtime", "-s", "RenderPerf:I"],
        env=ENV,
        stdout=log_console,
        stderr=subprocess.STDOUT,
    )
    try:
        adb("shell", "input", "keyevent", "224")
        adb("shell", "input", "keyevent", "82")
        time.sleep(5)
        adb(
            "shell", "am", "start", "--activity-single-top",
            "-a", "com.hausen3d.arviewer.action.DEBUG_RUN_EXPERIMENT",
            "-n", "com.hausen3d.arviewer/.VrWalkthroughActivity",
            "--es", "experiment", experiment,
            capture=True,
        )
        begin_deadline = time.monotonic() + 30
        while True:
            time.sleep(0.25)
            begin_log = log_path.read_text(encoding="utf-8", errors="replace")
            if f"RUN_BEGIN experiment={experiment} " in begin_log:
                break
            if time.monotonic() >= begin_deadline:
                raise RuntimeError(f"Experiment selection failed; expected {experiment}:\n{begin_log}")
        started_monotonic = time.monotonic()
        time.sleep(2)
        begin_log = log_path.read_text(encoding="utf-8", errors="replace")
        if f"RUN_CANCEL experiment={experiment}" in begin_log:
            print(f"RETRY {experiment} after lifecycle cancellation", flush=True)
            adb(
                "shell", "am", "start", "--activity-single-top",
                "-a", "com.hausen3d.arviewer.action.DEBUG_RUN_EXPERIMENT",
                "-n", "com.hausen3d.arviewer/.VrWalkthroughActivity",
                "--es", "experiment", experiment,
                capture=True,
            )
            begin_deadline = time.monotonic() + 30
            while True:
                time.sleep(0.25)
                begin_log = log_path.read_text(encoding="utf-8", errors="replace")
                if begin_log.count(f"RUN_BEGIN experiment={experiment} ") >= 2:
                    break
                if time.monotonic() >= begin_deadline:
                    raise RuntimeError(f"Experiment retry failed; expected {experiment}:\n{begin_log}")
            started_monotonic = time.monotonic()

        trace_process = None
        trace_console = None
        remote_trace = None
        local_trace = None
        perfetto_error = None
        if with_perfetto:
            time.sleep(max(0, 20 - (time.monotonic() - started_monotonic)))
            trace_process, trace_console, remote_trace, local_trace = start_perfetto(
                experiment, run_number
            )

        time.sleep(max(0, 85 - (time.monotonic() - started_monotonic)))
    finally:
        log_process.terminate()
        try:
            log_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            log_process.kill()
            log_process.wait(timeout=5)
        log_console.close()

    summary = read_summary(log_path)
    if not summary:
        exit_info = adb(
            "shell", "dumpsys", "activity", "exit-info", "com.hausen3d.arviewer",
            capture=True, check=False,
        )
        metadata = {
            "experiment": experiment,
            "run": run_number,
            "status": "incomplete",
            "startedAt": started_at,
            "batteryBefore": battery_before,
            "summary": None,
            "error": "No RenderPerf SUMMARY; the run is excluded from aggregates",
            "processExitInfo": exit_info,
        }
        meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        raise RuntimeError(f"No RenderPerf summary for {experiment} run {run_number}")

    if trace_process:
        try:
            trace_status = trace_process.wait(timeout=15)
            trace_console.close()
            if trace_status != 0:
                raise RuntimeError(f"perfetto exited with status {trace_status}")
            adb("pull", remote_trace, local_trace.name, capture=True, cwd=OUTPUT)
            if not local_trace.is_file() or local_trace.stat().st_size == 0:
                raise RuntimeError("Perfetto trace is missing or empty")
        except Exception as error:
            perfetto_error = str(error)
            print(f"PERFETTO WARNING {experiment} run {run_number}: {error}", flush=True)

    metadata = {
        "experiment": experiment,
        "run": run_number,
        "status": "complete",
        "startedAt": started_at,
        "batteryBefore": battery_before,
        "batteryAfter": battery_state(),
        "summary": summary,
        "perfettoTrace": local_trace.name if local_trace and local_trace.is_file() else None,
        "perfettoError": perfetto_error,
    }
    meta_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"DONE {experiment} run {run_number}: "
        f"p95={summary['metrics'].get('p95Ms')}ms "
        f"medianFps={summary['metrics'].get('medianFps')}",
        flush=True,
    )


def main():
    parser = argparse.ArgumentParser(description="Run repeatable Stage 0 A/B sampling on the connected P40 Pro")
    parser.add_argument("--experiment", choices=EXPERIMENTS)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--run-number", type=int)
    parser.add_argument("--perfetto-first", action="store_true")
    parser.add_argument("--perfetto", action="store_true")
    parser.add_argument("--cool-below-tenths", type=int)
    parser.add_argument("--max-cooldown-seconds", type=int, default=900)
    args = parser.parse_args()
    if not args.all and not args.experiment:
        parser.error("Specify --experiment or --all")
    if args.repeats < 1 or (args.run_number is not None and not 1 <= args.run_number <= args.repeats):
        parser.error("Invalid repeat/run number")

    devices = adb("devices", capture=True)
    if "ELS-AN00" not in devices and "\tdevice" not in devices:
        raise RuntimeError(f"No authorized Android device:\n{devices}")

    targets = EXPERIMENTS if args.all else [args.experiment]
    for experiment in targets:
        run_numbers = [args.run_number] if args.run_number else range(1, args.repeats + 1)
        for run_number in run_numbers:
            run_one(
                experiment,
                run_number,
                with_perfetto=args.perfetto or (args.perfetto_first and run_number == 1),
                cool_below_tenths=args.cool_below_tenths,
                max_cooldown_seconds=args.max_cooldown_seconds,
            )


if __name__ == "__main__":
    main()
