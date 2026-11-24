"""Capture four exact A0 poses on an archived APK; never overwrite an output directory."""
import argparse
import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path
from run_stage1_thermal import ADB, JAVA, PACKAGE, adb, now


def jdi(classes, mode, *values):
    pid = adb("shell", "pidof", PACKAGE).strip()
    adb("forward", "tcp:18710", "jdwp:" + pid)
    try:
        main = "JdiSceneSnapshot" if mode == "snapshot" else "JdiAcceptance"
        command = [JAVA, "--add-modules", "jdk.jdi", "-cp", str(classes), main, "18710"]
        if mode != "snapshot":
            command += [mode, *map(str, values)]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stdout.decode(errors="replace"))
        return result.stdout
    finally:
        adb("forward", "--remove", "tcp:18710")


def scene(classes):
    raw = jdi(classes, "snapshot")
    marker = "SCENE_SNAPSHOT_JSON "
    return json.loads(raw.decode().split(marker, 1)[1])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--classes", type=Path, required=True)
    parser.add_argument("--expected-apk-sha256", required=True)
    parser.add_argument("--expected-model-sha256", required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    apk = adb("shell", "pm", "path", PACKAGE).strip().removeprefix("package:")
    meta = {"capturedAt": now(), "experiment": "A0", "apkSha256": adb("shell", "sha256sum", apk).split()[0],
            "performanceSampling": False, "captures": []}
    prefs = adb("shell", "run-as", PACKAGE, "cat", "shared_prefs/vr_walkthrough.xml")
    model = re.search(r'<string name="last_model_path">([^<]+)', prefs).group(1)
    meta["modelSha256"] = adb("shell", "run-as", PACKAGE, "sha256sum", model).split()[0]
    assert meta["apkSha256"] == args.expected_apk_sha256.lower(), "Installed APK mismatch"
    assert meta["modelSha256"] == args.expected_model_sha256.lower(), "Loaded model mismatch"
    meta["status"] = "incomplete"
    metadata = args.output / "metadata.json"
    metadata.write_text(json.dumps(meta, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    # Apply A0 once, await the explicit application marker, then preserve lights/animation state.
    # Merely waiting two seconds and reading currentExperiment=A0 is insufficient.
    adb("logcat", "-c")
    launch = adb("shell", "am", "start", "--activity-single-top", "-a", PACKAGE + ".action.DEBUG_CAPTURE_VIEW",
                 "-n", PACKAGE + "/.VrWalkthroughActivity", "--es", "experiment", "A0", "--es", "view", "entry")
    (args.output / "apply-a0-launch.log").write_text(launch, encoding="utf-8")
    deadline = time.monotonic() + 30
    while True:
        log = adb("logcat", "-d", "-v", "epoch", "-s", "VrWalkthrough:I", "PhysicalRoomLighting:I")
        if "VisualCapture experiment=A0 view=entry" in log:
            break
        if time.monotonic() > deadline:
            raise RuntimeError("No explicit VisualCapture A0 marker; capture rejected")
        time.sleep(0.25)
    (args.output / "apply-a0.log").write_text(log, encoding="utf-8")
    time.sleep(2)
    initial = scene(args.classes)
    (args.output / "initial-scene.json").write_text(json.dumps(initial, indent=2)+"\n", encoding="utf-8")
    assert all(x["phase"] == 0 and not x["open"] and not x["moving"] for x in initial["articulation"]), "Close all moving parts before paired capture"
    for name, yaw in [("01-entry", 0), ("02-piano", 180), ("03-left", 90), ("04-right", -90)]:
        adb("logcat", "-c")
        (args.output / (name + "-setup.log")).write_bytes(jdi(args.classes, "view", yaw))
        time.sleep(2)
        state = scene(args.classes)
        (args.output / (name + "-scene.json")).write_text(json.dumps(state, indent=2)+"\n", encoding="utf-8")
        assert state["activity"]["debugFreezeArPose"] and not state["activity"]["debugCameraTrackRunning"]
        assert state["lights"] == initial["lights"], "Light state changed between fixed views"
        assert state["articulation"] == initial["articulation"], "Articulation changed between fixed views"
        expected = state["controller"]["startPosition"]
        matrix = state["camera"]["ModelMatrix"]
        assert max(abs(matrix[12+i] - expected[axis]) for i, axis in enumerate(("x", "y", "z"))) < 1e-4, "Native camera did not reach fixed start"
        angle = math.radians(state["controller"]["state"]["startYawDegrees"] + yaw)
        assert abs(matrix[0] - math.cos(angle)) < 1e-4 and abs(matrix[8] - math.sin(angle)) < 1e-4, "Native camera yaw mismatch"
        time.sleep(0.5)
        capture = subprocess.run([ADB, "-s", "MDX0220B11015404", "exec-out", "screencap", "-p"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        assert capture.returncode == 0 and capture.stdout.startswith(b"\x89PNG\r\n\x1a\n")
        (args.output / (name + ".png")).write_bytes(capture.stdout)
        log = adb("logcat", "-d", "-v", "epoch", "-s", "VrWalkthrough:I", "ArPoseRenderer:I", "RenderPerf:I")
        (args.output / (name + ".log")).write_text(log, encoding="utf-8")
        poses = [line for line in log.splitlines() if "VrWalkthrough: seq=" in line]
        assert poses, "No controller pose evidence"
        meta["captures"].append({"file": name + ".png", "yawOffsetDegrees": yaw,
                                  "sha256": hashlib.sha256(capture.stdout).hexdigest(),
                                  "poseLog": poses[-1], "scene": name + "-scene.json"})
        metadata.write_text(json.dumps(meta, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        print("CAPTURED", name, flush=True)
    meta["status"] = "complete"
    metadata.write_text(json.dumps(meta, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")


if __name__ == "__main__":
    main()
