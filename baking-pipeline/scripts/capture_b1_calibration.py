#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import time
from datetime import datetime
from pathlib import Path

from PIL import Image


def main():
    parser = argparse.ArgumentParser(description="Capture four visual-only A0 calibration views with native projection evidence")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--adb", type=Path, default=Path(r"D:\Android\AndroidSDK\platform-tools\adb.exe"))
    parser.add_argument("--java", type=Path, default=Path(r"D:\Android\AndroidStudio\android-studio\jbr\bin\java.exe"))
    args = parser.parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    env = dict(os.environ, MSYS_NO_PATHCONV="1")
    adb = str(args.adb)
    java = str(args.java)
    model_path = "/data/user/0/com.hausen3d.arviewer/files/models/current/B1-Example-calibration.glb"
    output_dir = root / "output" / config["roomId"] / "diagnostics" / "same-condition-calibration" / "a0"
    output_dir.mkdir(parents=True, exist_ok=True)

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

    serial = [line.strip() for line in run("get-serialno").decode().splitlines() if line.strip()][-1]
    if serial != config["sourceProvenance"]["deviceSerial"]:
        raise RuntimeError(f"Unexpected device: {serial}")
    remote_hash = run("shell", "run-as", "com.hausen3d.arviewer", "sha256sum", model_path).decode().split()[0]
    if remote_hash != config["expectedSha256"]:
        raise RuntimeError("Calibration model does not match the locked original GLB")
    script = Path(__file__).resolve().parent / "JdiCalibration.java"
    captures = []
    for view in config["camera"]["views"]:
        view_id = view["id"]
        yaw = view["yawOffsetDegrees"]
        debug_view = "piano" if yaw == 180.0 else "entry"
        run("logcat", "-c")
        if yaw in (0.0, 180.0):
            run("shell", "am", "force-stop", "com.hausen3d.arviewer")
            run(
                "shell", "am", "start", "-a", "com.hausen3d.arviewer.action.DEBUG_CAPTURE_VIEW",
                "-n", "com.hausen3d.arviewer/.VrWalkthroughActivity",
                "--es", "experiment", "A0", "--es", "view", debug_view,
                "--es", "model_path", model_path,
            )
            pose_method = "debug_exact_entry" if debug_view == "entry" else "debug_exact_reverse"
        else:
            run("shell", "input", "keyevent", "4")
            time.sleep(2)
            run("shell", "input", "tap", "1320", "590")
            time.sleep(4)
            dx = -int(round(yaw / 0.15))
            run("shell", "input", "swipe", "2100", "650", str(2100 + dx), "650", "120")
            pose_method = "normal_start_reset_plus_recorded_600px_swipe"
        heading_corrections = []
        if yaw not in (0.0, 180.0):
            target_heading = 90.0 + view.get("offlineYawOffsetDegrees", yaw)
            for _ in range(3):
                logs = run("logcat", "-d", "-s", "VrWalkthrough:I").decode(errors="replace")
                headings = re.findall(r"head=(-?\d+(?:\.\d+)?)", logs)
                if not headings:
                    break
                current_heading = float(headings[-1])
                delta = (target_heading - current_heading + 180.0) % 360.0 - 180.0
                if abs(delta) <= 0.25:
                    break
                pixels = max(-120, min(120, round(-delta / 0.15)))
                if pixels == 0:
                    break
                run("shell", "input", "swipe", "2100", "650", str(2100 + pixels), "650", "120")
                heading_corrections.append(pixels)
                time.sleep(2)
            time.sleep(2)
        time.sleep(12)
        pid = run("shell", "pidof", "com.hausen3d.arviewer").decode().strip()
        run("forward", "tcp:18700", f"jdwp:{pid}")
        try:
            result = subprocess.run(
                [java, "--add-modules", "jdk.jdi", str(script), "18700"],
                env=env, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
        finally:
            run("forward", "--remove", "tcp:18700")
        jdi_text = result.stdout.decode(errors="replace")
        if result.returncode or "CALIBRATION_JSON " not in jdi_text:
            raise RuntimeError(f"JDI calibration failed for {view_id}\n{jdi_text}")
        marker = next(line for line in jdi_text.splitlines() if line.startswith("CALIBRATION_JSON "))
        calibration = json.loads(marker.removeprefix("CALIBRATION_JSON "))
        logs = run("logcat", "-d", "-s", "VrWalkthrough:I", "PhysicalRoomLighting:I").decode(errors="replace")
        headings = re.findall(r"head=(-?\d+(?:\.\d+)?)", logs)
        image = output_dir / f"{view_id}-android-a0.png"
        data = run("exec-out", "screencap", "-p")
        image.write_bytes(data)
        with Image.open(image) as check:
            check.verify()
        (output_dir / f"{view_id}-capture.log").write_text(logs, encoding="utf-8")
        (output_dir / f"{view_id}-jdi.log").write_text(jdi_text, encoding="utf-8")
        p00 = calibration["projectionColumnMajor"][0]
        p11 = calibration["projectionColumnMajor"][5]
        captures.append({
            **view,
            "poseMethod": pose_method,
            "headingCorrectionSwipes": heading_corrections,
            "actualHeadingDegreesFromLog": float(headings[-1]) if headings else None,
            "file": image.name,
            "sha256": hashlib.sha256(data).hexdigest(),
            "verticalFovDegrees": math.degrees(2 * math.atan(1.0 / p11)),
            "horizontalFovDegrees": math.degrees(2 * math.atan(1.0 / p00)),
            "native": calibration,
        })
        print(f"CALIBRATED {view_id} verticalFov={captures[-1]['verticalFovDegrees']:.9f}", flush=True)
    metadata = {
        "capturedAt": datetime.now().astimezone().isoformat(),
        "experiment": "A0 visual calibration only; no performance run",
        "performanceRunExecuted": False,
        "deviceSerial": serial,
        "modelPath": model_path,
        "modelSha256": remote_hash,
        "historicalB0ProjectionEvidence": "Not overwritten. Historical B0 screenshots remain a separate capture with no native projection matrix; do not use them for pixel-aligned MAE.",
        "colorGradingOperatorEvidence": "The native object is present; the operator is established separately from SceneView 2.3.4 createView() and Filament 1.68.2 source, not from the deprecated View.ToneMapping getter.",
        "captures": captures,
    }
    (output_dir / "capture-metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
