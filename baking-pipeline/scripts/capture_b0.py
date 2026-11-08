#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Capture four A0 views without running a performance experiment")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--adb", type=Path, default=Path(r"D:\Android\AndroidSDK\platform-tools\adb.exe"))
    args = parser.parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    source = (root / config["sourceModel"]).resolve()
    local_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if local_hash != config["expectedSha256"]:
        raise RuntimeError("Local source hash does not match the locked configuration")
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    adb = str(args.adb)

    def run(*arguments, capture=True):
        result = subprocess.run(
            [adb, *arguments], env=env, check=False,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None,
        )
        output = result.stdout if capture else b""
        if result.returncode:
            raise RuntimeError(f"ADB failed: {arguments}\n{output.decode(errors='replace')}")
        return output

    serial = run("get-serialno").decode().strip()
    if serial != config["sourceProvenance"]["deviceSerial"]:
        raise RuntimeError(f"Unexpected device: {serial}")
    remote_hash = run("shell", "sha256sum", config["sourceProvenance"]["originalDevicePath"]).decode().split()[0]
    imported_hash = run("shell", "run-as", "com.hausen3d.arviewer", "sha256sum", config["sourceProvenance"]["importedDevicePath"]).decode().split()[0]
    if remote_hash != local_hash or imported_hash != local_hash:
        raise RuntimeError("Device model no longer matches the locked B0 source")

    output_dir = root / "output" / config["roomId"] / "b0"
    output_dir.mkdir(parents=True, exist_ok=True)
    battery_before = run("shell", "dumpsys", "battery").decode(errors="replace")
    captures = []
    for view in config["camera"]["views"]:
        view_id = view["id"]
        yaw = view["yawOffsetDegrees"]
        debug_view = "piano" if yaw == 180.0 else "entry"
        run("logcat", "-c")
        logs = ""
        if yaw in (0.0, 180.0):
            run(
                "shell", "am", "start", "--activity-single-top",
                "-a", "com.hausen3d.arviewer.action.DEBUG_CAPTURE_VIEW",
                "-n", "com.hausen3d.arviewer/.VrWalkthroughActivity",
                "--es", "experiment", "A0", "--es", "view", debug_view,
            )
            marker = f"VisualCapture experiment=A0 view={debug_view}"
            deadline = time.monotonic() + 45
            while marker not in logs:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"Timed out waiting for {marker}\n{logs}")
                time.sleep(0.5)
                logs = run("logcat", "-d", "-s", "VrWalkthrough:I", "PhysicalRoomLighting:I").decode(errors="replace")
            poseMethod = "debug_exact_entry" if debug_view == "entry" else "debug_exact_reverse"
        else:
            run("shell", "input", "keyevent", "4")
            time.sleep(2)
            run("shell", "input", "tap", "1320", "590")
            time.sleep(4)
            dx = -int(round(yaw / 0.15))
            start_x = 2100
            run("shell", "input", "swipe", str(start_x), "650", str(start_x + dx), "650", "120")
            poseMethod = "normal_start_reset_plus_recorded_600px_swipe; numeric pose read from logcat"
            logs = run("logcat", "-d", "-s", "VrWalkthrough:I", "PhysicalRoomLighting:I").decode(errors="replace")
        time.sleep(3)
        logs = run("logcat", "-d", "-s", "VrWalkthrough:I", "PhysicalRoomLighting:I").decode(errors="replace")
        headings = re.findall(r"head=(-?\d+(?:\.\d+)?)", logs)
        actual_heading = float(headings[-1]) if headings else None
        image = output_dir / f"{view_id}-android-a0.png"
        data = run("exec-out", "screencap", "-p")
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise RuntimeError(f"Invalid screenshot for {view_id}")
        image.write_bytes(data)
        captures.append({
            **view,
            "file": image.name,
            "sha256": hashlib.sha256(data).hexdigest(),
            "poseMethod": poseMethod,
            "actualHeadingDegreesFromLog": actual_heading,
        })
        (output_dir / f"{view_id}-capture.log").write_text(logs, encoding="utf-8")
        print(f"Saved {image}", flush=True)

    battery_after = run("shell", "dumpsys", "battery").decode(errors="replace")
    pss = run("shell", "dumpsys", "meminfo", "com.hausen3d.arviewer").decode(errors="replace")
    total_pss = re.search(r"TOTAL PSS:\s+(\d+)", pss)
    temperature = re.findall(r"temperature:\s*(\d+)", battery_before + "\n" + battery_after)
    metadata = {
        "capturedAt": datetime.now().astimezone().isoformat(),
        "experiment": "A0",
        "performanceRunExecuted": False,
        "deviceSerial": serial,
        "sourceSha256": local_hash,
        "deviceOriginalSha256": remote_hash,
        "deviceImportedSha256": imported_hash,
        "captures": captures,
        "batteryTemperatureTenthsCBeforeAfter": [int(value) for value in temperature],
        "pointInTimeTotalPssKb": int(total_pss.group(1)) if total_pss else None,
        "pssNote": "Point-in-time value during capture, not a repeatable performance baseline.",
        "legacyPerformanceReference": "项目文档/手机端软件开发/光影渲染性能基线/阶段0/A0-run4-meta.json",
        "legacyPerformanceApplicability": "The legacy strict A0 performance run used a different GLB; it is diagnostic context only and is not claimed as a same-model B0 result.",
        "leftRightPoseCaveat": "Left/right views start from the normal roaming reset pose and use recorded 600-pixel swipes. Final headings are read from logcat; a small gesture-quantization difference from the nominal offline angle is expected and recorded per view.",
    }
    (output_dir / "capture-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "point-in-time-meminfo.txt").write_text(pss, encoding="utf-8")


if __name__ == "__main__":
    main()
