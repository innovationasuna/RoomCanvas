"""600 s continuous A0 measurement on either archived debug APK, without rebuilding it.

The companion JDI harness expands only the monitor ring and starts the existing
fixed track for 20+600 seconds, then detaches before warmup. Any ADB disconnect,
process restart, cancellation, missing samples or buffer overflow invalidates the run.
"""
import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ADB = os.environ.get("ADB", r"D:\Android\AndroidSDK\platform-tools\adb.exe")
SERIAL = "MDX0220B11015404"
PACKAGE = "com.hausen3d.arviewer"
JAVA = r"D:\Android\AndroidStudio\android-studio\jbr\bin\java.exe"


def now():
    return datetime.now(timezone(timedelta(hours=8))).isoformat()


def adb(*args):
    result = subprocess.run([ADB, "-s", SERIAL, *args], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=20)
    output = result.stdout.decode("utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError(f"ADB failed: {args}: {output}")
    return output


def metrics(line):
    return dict(re.findall(r"(\w+)=([^\s]+)", line))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--classes", type=Path, required=True)
    parser.add_argument("--expected-apk-sha256", required=True)
    parser.add_argument("--expected-model-sha256", required=True)
    parser.add_argument("--maximum-start-temperature-tenths", type=int, default=350)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    meta = {"startedAt": now(), "status": "incomplete", "includedInStatistics": False,
            "warmupSeconds": 20, "sampleSeconds": 600, "ringCapacity": 65536,
            "method": "archived debug APK + identical JDI monitor setup; detach before warmup",
            "deviceChecks": [], "environmentSamples": []}
    log_file = None
    process = None
    try:
        assert adb("get-state").strip() == "device"
        apk_path = adb("shell", "pm", "path", PACKAGE).strip().removeprefix("package:")
        meta["apkSha256"] = adb("shell", "sha256sum", apk_path).split()[0]
        assert meta["apkSha256"] == args.expected_apk_sha256, "Unexpected APK"
        prefs = adb("shell", "run-as", PACKAGE, "cat", "shared_prefs/vr_walkthrough.xml")
        model = re.search(r'<string name="last_model_path">([^<]+)', prefs).group(1)
        meta["modelPath"] = model
        meta["modelSha256"] = adb("shell", "run-as", PACKAGE, "sha256sum", model).split()[0]
        assert meta["modelSha256"] == args.expected_model_sha256, "Unexpected model"
        meta["batteryBefore"] = adb("shell", "dumpsys", "battery")
        temperature = int(re.search(r"temperature:\s*(\d+)", meta["batteryBefore"]).group(1))
        assert temperature <= args.maximum_start_temperature_tenths, (
            f"Cool to <={args.maximum_start_temperature_tenths / 10}C before run, got {temperature / 10}C")
        meta["maximumStartTemperatureTenthsC"] = args.maximum_start_temperature_tenths
        meta["startTemperatureTenthsC"] = temperature
        meta["thermalBefore"] = adb("shell", "dumpsys", "thermalservice")
        (args.output / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        adb("shell", "input", "keyevent", "224")
        adb("shell", "input", "keyevent", "82")
        time.sleep(3)
        adb("logcat", "-c")
        log_path = args.output / "thermal.log"
        log_file = log_path.open("wb")
        process = subprocess.Popen([ADB, "-s", SERIAL, "logcat", "-v", "epoch", "-s",
                                    "RenderPerf:I", "VrWalkthrough:I", "ArPoseRenderer:I", "Articulation:I"],
                                   stdout=log_file, stderr=subprocess.STDOUT)
        adb("shell", "am", "start", "--activity-single-top", "-a",
            PACKAGE + ".action.DEBUG_RUN_EXPERIMENT", "-n", PACKAGE + "/.VrWalkthroughActivity",
            "--es", "experiment", "A0")
        deadline = time.monotonic() + 45
        while "RUN_BEGIN experiment=A0 " not in log_path.read_text(encoding="utf-8", errors="replace"):
            assert time.monotonic() < deadline, "No A0 start marker"
            time.sleep(0.25)
        pid = adb("shell", "pidof", PACKAGE).strip()
        meta["pid"] = pid
        adb("forward", "tcp:18710", "jdwp:" + pid)
        setup = subprocess.run([JAVA, "--add-modules", "jdk.jdi", "-cp", str(args.classes),
                                "JdiAcceptance", "18710", "thermal"],
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
        setup_text = setup.stdout.decode("utf-8", errors="replace")
        (args.output / "jdi-setup.log").write_text(setup_text, encoding="utf-8")
        assert setup.returncode == 0 and '"sampleSeconds":600' in setup_text, setup_text
        adb("forward", "--remove", "tcp:18710")
        print("THERMAL_SETUP_COMPLETE", now(), flush=True)
        started = time.monotonic()
        last_environment = -30
        while True:
            elapsed = time.monotonic() - started
            state = adb("get-state").strip()
            active_pid = adb("shell", "pidof", PACKAGE).strip()
            meta["deviceChecks"].append({"time": now(), "elapsedSeconds": elapsed,
                                         "state": state, "pid": active_pid})
            assert state == "device" and active_pid == pid, "Disconnected or process restarted"
            assert process.poll() is None, "logcat stream ended"
            content = log_path.read_text(encoding="utf-8", errors="replace")
            marker = content.rfind("RUN_BEGIN experiment=A0 warmupSeconds=20 sampleSeconds=600")
            assert marker >= 0, "Missing 600 s run marker"
            current = content[marker:]
            assert "RUN_CANCEL" not in current, "Run cancelled"
            if elapsed - last_environment >= 30:
                meta["environmentSamples"].append({"time": now(), "elapsedSeconds": elapsed,
                    "battery": adb("shell", "dumpsys", "battery"),
                    "thermal": adb("shell", "dumpsys", "thermalservice")})
                last_environment = elapsed
                print("THERMAL_PROGRESS", round(elapsed), now(), flush=True)
            summaries = [line for line in current.splitlines() if "SUMMARY experiment=A0 " in line]
            if summaries:
                row = metrics(summaries[-1])
                assert 0 < int(row["frames"]) <= 65536, "Buffer capacity exceeded"
                assert "SAMPLE_BEGIN experiment=A0" in current
                sample_line = next(l for l in content.splitlines() if "SAMPLE_BEGIN experiment=A0" in l and float(l.split()[0]) > float(content[:marker].splitlines()[-1].split()[0]))
                duration = float(summaries[-1].split()[0]) - float(sample_line.split()[0])
                assert duration >= 599.9, f"Short sampling window: {duration}"
                meta.update(status="complete", includedInStatistics=True, summary=row,
                            summaryRaw=summaries[-1], logSampleDurationSeconds=duration)
                break
            assert elapsed < 660, "No summary before deadline"
            time.sleep(5)
        meta["batteryAfter"] = adb("shell", "dumpsys", "battery")
        meta["thermalAfter"] = adb("shell", "dumpsys", "thermalservice")
        # Read the actual ring after measurement, so ART/JIT behavior cannot silently
        # turn a reflected field replacement into a truncated-window percentile.
        adb("forward", "tcp:18710", "jdwp:" + pid)
        readback = subprocess.run([JAVA, "--add-modules", "jdk.jdi", "-cp", str(args.classes),
                                   "JdiAcceptance", "18710", "monitor"],
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=45)
        readback_text = readback.stdout.decode("utf-8", errors="replace")
        (args.output / "jdi-monitor-readback.log").write_text(readback_text, encoding="utf-8")
        assert readback.returncode == 0, readback_text
        ring = json.loads(next(l.removeprefix("ACCEPTANCE_JSON ") for l in readback_text.splitlines()
                               if l.startswith("ACCEPTANCE_JSON ")))
        assert ring["capacity"] == 65536 and ring["storedIntervals"] == int(meta["summary"]["frames"]), ring
        meta["fullRingReadback"] = ring
        adb("forward", "--remove", "tcp:18710")
    except Exception as exc:
        meta.update(status="invalid", includedInStatistics=False, error=str(exc))
        raise
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        if log_file:
            log_file.close()
        meta["endedAt"] = now()
        (args.output / "metadata.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print("THERMAL_COMPLETE", json.dumps(meta["summary"]), flush=True)


if __name__ == "__main__":
    main()
