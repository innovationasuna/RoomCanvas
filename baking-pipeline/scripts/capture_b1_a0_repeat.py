#!/usr/bin/env python3
"""Repeat the A0 entry capture N times and record the runtime ceiling-light set.

Read-only on the device: force-stop, debug intent, JDWP probe (getters only),
screencap. No APK change, no model change, no preference write.
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

MODEL_PATH = "/data/user/0/com.hausen3d.arviewer/files/models/current/B1-Example-calibration.glb"
CEILING_ROI = (820, 8, 1440, 215)

# Observed runtime positions (glTF Y-up, meters), used only to label the probe.
KNOWN_LIGHTS = {
    "Ceiling0": (-1.5391, 1.0254, -0.2778),
    "Ceiling tee": (-1.6110, 1.0194, 1.3428),
    "Ceiling tee.001": (-1.4930, 1.0194, 0.7305),
    "Ceiling tee.002": (-3.2331, 1.0194, 0.2777),
    "Ceiling tee.003": (-1.4995, 1.0194, 0.1288),
    "Ceiling panel frame": (-0.73, 0.9854, 0.14),
}


def label_position(position):
    x, y, z = position
    for name, (kx, ky, kz) in KNOWN_LIGHTS.items():
        if abs(x - kx) < 0.002 and abs(y - ky) < 0.01 and abs(z - kz) < 0.002:
            return name
    return f"unknown({x:.3f},{z:.3f})"


def roi_stats(path):
    with Image.open(path) as image:
        array = np.asarray(image.crop(CEILING_ROI)).astype(np.float32)
    luminance = array.mean(axis=2)
    return {
        "meanRgb": [round(float(v), 2) for v in array.reshape(-1, 3).mean(axis=0)],
        "medianLuminance": round(float(np.median(luminance)), 2),
        "p95Luminance": round(float(np.percentile(luminance, 95)), 2),
        "p99Luminance": round(float(np.percentile(luminance, 99)), 2),
        "fractionAbove32Percent": round(float((luminance > 32).mean() * 100), 2),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--tag", default="a", help="output subdirectory suffix, e.g. a/b")
    parser.add_argument("--adb", type=Path, default=Path(r"D:\Android\AndroidSDK\platform-tools\adb.exe"))
    parser.add_argument("--java", type=Path, default=Path(r"D:\Android\AndroidStudio\android-studio\jbr\bin\java.exe"))
    parser.add_argument("--config", type=Path,
                        default=Path(__file__).resolve().parents[1] / "configs" / "example_room_2.json")
    args = parser.parse_args()

    config = json.loads(args.config.read_text(encoding="utf-8"))
    root = args.config.resolve().parents[1]
    output_dir = root / "output" / config["roomId"] / "diagnostics" / "lead-review-2026-11-10" / f"e0-{args.tag}"
    output_dir.mkdir(parents=True, exist_ok=True)
    probe_script = Path(__file__).resolve().parent / "JdiMaterialProbe.java"
    env = dict(os.environ, MSYS_NO_PATHCONV="1")

    def adb(*arguments, capture=True):
        result = subprocess.run(
            [str(args.adb), "-s", args.serial, *arguments], env=env, check=False,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None,
        )
        if result.returncode:
            raise RuntimeError(f"ADB failed: {arguments}\n{result.stdout.decode(errors='replace')}")
        return result.stdout

    serial = adb("get-serialno").decode().strip()
    if serial != args.serial:
        raise RuntimeError(f"Unexpected device: {serial}")

    remote_hash = adb("shell", "run-as", "com.hausen3d.arviewer", "sha256sum", MODEL_PATH).decode().split()[0]
    if remote_hash != config["expectedSha256"]:
        raise RuntimeError("Device model is not the locked original GLB")

    runs = []
    for index in range(1, args.runs + 1):
        started = datetime.now().astimezone()
        adb("logcat", "-c")
        adb("shell", "am", "force-stop", "com.hausen3d.arviewer")
        adb(
            "shell", "am", "start", "-a", "com.hausen3d.arviewer.action.DEBUG_CAPTURE_VIEW",
            "-n", "com.hausen3d.arviewer/.VrWalkthroughActivity",
            "--es", "experiment", "A0", "--es", "view", "entry",
            "--es", "model_path", MODEL_PATH,
        )
        time.sleep(12)
        pid = adb("shell", "pidof", "com.hausen3d.arviewer").decode().strip()
        if not pid:
            raise RuntimeError(f"Run {index}: process not running")
        adb("forward", "tcp:18700", f"jdwp:{pid}")
        try:
            result = subprocess.run(
                [str(args.java), "--add-modules", "jdk.jdi", str(probe_script), "18700"],
                env=env, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60,
            )
        finally:
            adb("forward", "--remove", "tcp:18700")
        probe_text = result.stdout.decode(errors="replace")
        if result.returncode or "MATERIAL_PROBE_JSON " not in probe_text:
            raise RuntimeError(f"Run {index}: probe failed\n{probe_text}")
        marker = next(line for line in probe_text.splitlines() if line.startswith("MATERIAL_PROBE_JSON "))
        probe = json.loads(marker.removeprefix("MATERIAL_PROBE_JSON "))

        image_path = output_dir / f"e0-{index:02d}-entry.png"
        image_path.write_bytes(adb("exec-out", "screencap", "-p"))
        with Image.open(image_path) as check:
            check.verify()

        logs = adb("logcat", "-d", "-s", "VrWalkthrough:I", "PhysicalRoomLighting:I").decode(errors="replace")
        (output_dir / f"e0-{index:02d}-capture.log").write_text(logs, encoding="utf-8")
        (output_dir / f"e0-{index:02d}-probe.json").write_text(
            json.dumps(probe, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

        points = [light for light in probe.get("lights", []) if light.get("type") == '"POINT"']
        lights = []
        for light in points:
            position = [float(v) for v in light["position"]]
            lights.append({
                "name": label_position(position),
                "position": position,
                "intensity": light["intensity"],
                "shadowCaster": light["shadowCaster"],
            })
        signature = sorted(light["name"] for light in lights)
        runs.append({
            "runId": f"e0-{index:02d}",
            "capturedAt": started.isoformat(),
            "modelSha256": remote_hash,
            "currentExperiment": probe.get("currentExperiment"),
            "shadowingEnabled": probe.get("shadowingEnabled"),
            "ambientOcclusionOptions": probe.get("ambientOcclusionOptions"),
            "assetEntityCount": probe.get("assetEntityCount"),
            "ceilingEntityByName": probe.get("ceilingEntityByName"),
            "lights": lights,
            "signature": signature,
            "roi": roi_stats(image_path),
            "image": str(image_path.relative_to(root)),
        })
        print(f"E0_RUN {index:02d} exp={probe.get('currentExperiment')} "
              f"lights={signature} ceilingEntity={probe.get('ceilingEntityByName')} "
              f"roiMedian={runs[-1]['roi']['medianLuminance']}", flush=True)

    signatures = [tuple(run["signature"]) for run in runs]
    unique = sorted(set(signatures))
    report = {
        "stage": "E0 A0 cold-start repeat capture; read-only probe",
        "generatedAt": datetime.now().astimezone().isoformat(),
        "deviceSerial": serial,
        "modelPath": MODEL_PATH,
        "modelSha256": remote_hash,
        "runs": runs,
        "summary": {
            "runCount": len(runs),
            "uniqueSignatures": [list(s) for s in unique],
            "signatureCounts": {str(list(s)): signatures.count(s) for s in unique},
            "roiMedianRange": [
                min(run["roi"]["medianLuminance"] for run in runs),
                max(run["roi"]["medianLuminance"] for run in runs),
            ],
        },
    }
    (output_dir / "e0-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"E0_COMPLETE {output_dir / 'e0-report.json'}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
