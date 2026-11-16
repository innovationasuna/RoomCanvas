#!/usr/bin/env python3
"""E1: render the prepared scene under the four ceiling light sets observed on device.

Read-only with respect to the prepared scene: the blend file is opened but never
saved. Only the four A0_CEILING_* POINT lights are moved; sun, world, materials
and cameras are untouched. Output is scene-linear EXR plus the analytic Filmic
display PNG, using the same camera framing as the existing offline full-PBR
previews.

Invoke:
    blender.exe --background example_room_2.prepared.blend \
        --python scripts/render_b1_light_set_variants.py -- \
        --config configs/example_room_2.json --views 01-entry
"""

import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

LIGHT_NAMES = [f"A0_CEILING_{index:02d}" for index in range(4)]
CEILING_DROP_METERS = 0.05

# Object sets observed by the E0 read-only probe (2026-11-11).
VARIANTS = {
    "V0": ["Ceiling0", "Ceiling tee", "Ceiling tee.001", "Ceiling tee.002"],
    "V1": ["Ceiling tee", "Ceiling tee.001", "Ceiling tee.002", "Ceiling tee.003"],
    "V2": ["Ceiling panel frame", "Ceiling tee", "Ceiling tee.001", "Ceiling tee.002"],
    "V3": ["Ceiling panel frame", "Ceiling tee", "Ceiling tee.001", "Ceiling0"],
}

PHONE_RAW_SIZE = (2640, 1200)
PHONE_VIEWPORT_WIDTH = 2486
PHONE_LEFT_STRIP = 154
CEILING_ROI = (820, 8, 1440, 215)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="E1 ceiling light-set variants")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--views", nargs="+", default=["01-entry"])
    parser.add_argument("--variants", nargs="+", default=sorted(VARIANTS))
    parser.add_argument("--resolution-percent", type=int, default=25)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--tag", default="e1-light-sets")
    return parser.parse_args(argv)


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return low, high


def light_target(obj):
    low, high = world_bounds(obj)
    target = Vector(((low.x + high.x) * 0.5, (low.y + high.y) * 0.5, low.z - CEILING_DROP_METERS))
    return target, low, high


def set_camera(scene, view_id, preparation):
    start_yaw = preparation["cameras"][0]["yawDegrees"]
    view = next(item for item in CONFIG["camera"]["views"] if item["id"] == view_id)
    yaw = math.radians(start_yaw + view.get("offlineYawOffsetDegrees", view["yawOffsetDegrees"]))
    pitch = math.radians(view["pitchDegrees"])
    direction = Vector((-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
    camera = bpy.data.objects[f"CAM_{view_id}"]
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera


def roi_box(width, height):
    x0, y0, x1, y1 = CEILING_ROI
    return (
        round((x0 - PHONE_LEFT_STRIP) / PHONE_VIEWPORT_WIDTH * width),
        round(y0 / PHONE_RAW_SIZE[1] * height),
        round((x1 - PHONE_LEFT_STRIP) / PHONE_VIEWPORT_WIDTH * width),
        round(y1 / PHONE_RAW_SIZE[1] * height),
    )


def png_stats(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(image.size[1], image.size[0], 4)
    bpy.data.images.remove(image)
    raw = np.flipud(pixels[..., :3]) * 255.0
    x0, y0, x1, y1 = roi_box(raw.shape[1], raw.shape[0])
    crop = raw[y0:y1, x0:x1, :]
    luminance = crop.mean(axis=2)
    return {
        "crop": [int(x0), int(y0), int(x1), int(y1)],
        "meanRgb": [round(float(value), 2) for value in crop.reshape(-1, 3).mean(axis=0)],
        "medianLuminance": round(float(np.median(luminance)), 2),
        "p95Luminance": round(float(np.percentile(luminance, 95)), 2),
        "p99Luminance": round(float(np.percentile(luminance, 99)), 2),
        "fractionAbove32Percent": round(float((luminance > 32).mean() * 100), 2),
        "fractionAbove64Percent": round(float((luminance > 64).mean() * 100), 2),
    }


def main():
    global CONFIG
    args = parse_args()
    config_path = args.config.resolve()
    CONFIG = json.loads(config_path.read_text(encoding="utf-8"))
    root = config_path.parents[1]
    output_dir = root / "output" / CONFIG["roomId"]
    diagnostics_dir = output_dir / "diagnostics" / "lead-review-2026-11-10" / args.tag

    scene = bpy.context.scene
    source_hash = scene.get("sourceSha256")
    if source_hash != CONFIG["expectedSha256"]:
        raise RuntimeError(f"Prepared scene hash mismatch: {source_hash}")
    preparation = json.loads((output_dir / "preparation-report.json").read_text(encoding="utf-8"))

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bake_room import configure_cycles
    from filament_display import save_scene_linear_preview

    device_report = configure_cycles(CONFIG)
    scene.render.resolution_x = CONFIG["camera"]["resolution"][0]
    scene.render.resolution_y = CONFIG["camera"]["resolution"][1]
    scene.render.resolution_percentage = args.resolution_percent
    scene.render.film_transparent = False
    scene.cycles.samples = args.samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.use_denoising = True
    scene.cycles.seed = 0

    lights = [bpy.data.objects[name] for name in LIGHT_NAMES]
    for light in lights:
        if light.type != "LIGHT" or light.parent is not None:
            raise RuntimeError(f"Unexpected light object: {light.name}")

    report = {
        "stage": "E1 offline ceiling light-set variants; read-only prepared scene",
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sourceSha256": source_hash,
        "preparedBlend": str((output_dir / f"{CONFIG['roomId']}.prepared.blend").relative_to(root)),
        "render": {
            "resolutionPercent": args.resolution_percent,
            "resolution": [
                round(CONFIG["camera"]["resolution"][0] * args.resolution_percent / 100),
                round(CONFIG["camera"]["resolution"][1] * args.resolution_percent / 100),
            ],
            "samples": args.samples,
            "seed": 0,
            "denoising": True,
            "device": device_report,
            "previewToneMapper": CONFIG["render"]["previewToneMapper"],
        },
        "roiNote": (
            "Phone raw screenshot ROI [820,8,1440,215] excludes the 154 px left strip; the same "
            "normalized box is applied to the 621x300 offline render."
        ),
        "variants": [],
    }

    for variant_id in args.variants:
        objects = VARIANTS[variant_id]
        variant_dir = diagnostics_dir / variant_id
        variant_dir.mkdir(parents=True, exist_ok=True)
        entry = {"id": variant_id, "objects": objects, "lights": [], "views": []}
        for slot, (light, name) in enumerate(zip(lights, objects)):
            target, low, high = light_target(bpy.data.objects[name])
            light.location = target
            entry["lights"].append({
                "slot": slot,
                "lightObject": light.name,
                "sourceObject": name,
                "objectBoundsLow": [round(value, 4) for value in low],
                "objectBoundsHigh": [round(value, 4) for value in high],
                "position": [round(value, 4) for value in target],
                "energy": round(float(light.data.energy), 4),
                "color": [round(float(value), 4) for value in light.data.color],
            })
        for view_id in args.views:
            set_camera(scene, view_id, preparation)
            exr_path = variant_dir / f"{view_id}-scene-linear.exr"
            png_path = variant_dir / f"{view_id}-offline-full-pbr.png"
            save_scene_linear_preview(scene, exr_path, png_path, CONFIG)
            stats = png_stats(png_path)
            entry["views"].append({
                "view": view_id,
                "png": str(png_path.relative_to(output_dir)).replace("\\", "/"),
                "exr": str(exr_path.relative_to(output_dir)).replace("\\", "/"),
                "stats": stats,
            })
            print(f"E1_VIEW {variant_id} {view_id} median={stats['medianLuminance']} "
                  f"meanRgb={stats['meanRgb']}", flush=True)
        report["variants"].append(entry)
        print(f"E1_VARIANT {variant_id} lights="
              f"{[(item['sourceObject'], item['position']) for item in entry['lights']]}", flush=True)

    report_path = diagnostics_dir / "e1-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"E1_COMPLETE {report_path}", flush=True)


if __name__ == "__main__":
    main()
