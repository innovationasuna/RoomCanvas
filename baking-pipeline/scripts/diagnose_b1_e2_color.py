#!/usr/bin/env python3
"""E2: attribute the pink/green tint with the existing pass EXRs.

No render, no re-bake. Reads the 25% pass renders listed by pass-report.json,
computes ROI color statistics for every weighted component, and isolates the
tone-mapping contribution by pushing the same scene-linear pixels through the
identity OETF and through the analytic Filament 1.68.2 Filmic operator.

Invoke:
    blender.exe --background --python scripts/diagnose_b1_e2_color.py -- \
        --config configs/example_room_2.json
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import bpy
import numpy as np

PHONE_RAW_SIZE = (2640, 1200)
PHONE_VIEWPORT_WIDTH = 2486
PHONE_LEFT_STRIP = 154
ROIS = {
    "01-entry": {
        "ceiling": (820, 8, 1440, 215),
        "full": (154, 0, 2640, 1200),
    },
    "04-right": {
        "ceiling": (1460, 8, 2250, 140),
        "full": (154, 0, 2640, 1200),
    },
}
COMPONENTS = ("DiffDir", "DiffInd", "GlossDir", "GlossInd", "Env", "Emit", "TransDir", "TransInd")


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="E2 pass color attribution")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--passes", type=Path, default=None,
                        help="lighting directory holding pass-report.json")
    parser.add_argument("--tag", default="e2-color")
    return parser.parse_args(argv)


def roi_pixels(array, view_id, roi_id):
    x0, y0, x1, y1 = ROIS[view_id][roi_id]
    height, width = array.shape[:2]
    left = round((x0 - PHONE_LEFT_STRIP) / PHONE_VIEWPORT_WIDTH * width)
    right = round((x1 - PHONE_LEFT_STRIP) / PHONE_VIEWPORT_WIDTH * width)
    top = round(y0 / PHONE_RAW_SIZE[1] * height)
    bottom = round(y1 / PHONE_RAW_SIZE[1] * height)
    return np.flipud(array)[top:bottom, left:right, :3]


def srgb_oetf(value):
    value = np.clip(value, 0.0, 1.0)
    return np.where(value <= 0.0031308, value * 12.92, 1.055 * np.power(value, 1.0 / 2.4) - 0.055)


def color_stats(rgb_linear):
    mean = rgb_linear.reshape(-1, 3).mean(axis=0)
    luminance = rgb_linear.mean(axis=2)
    return {
        "meanLinearRgb": [round(float(value), 6) for value in mean],
        "meanLinearLuminance": round(float(luminance.mean()), 6),
        "rMinusBLinear": round(float(mean[0] - mean[2]), 6),
        "gMinusBLinear": round(float(mean[1] - mean[2]), 6),
    }


def display_stats(rgb_display_linear):
    encoded = srgb_oetf(rgb_display_linear) * 255.0
    mean = encoded.reshape(-1, 3).mean(axis=0)
    return {
        "meanDisplayRgb": [round(float(value), 2) for value in mean],
        "rMinusBDisplay": round(float(mean[0] - mean[2]), 2),
        "gMinusBDisplay": round(float(mean[1] - mean[2]), 2),
    }


def main():
    args = parse_args()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = config_path.parents[1]
    output_dir = root / "output" / config["roomId"]
    lighting_dir = args.passes or (
        output_dir / "diagnostics" / "remaining-visual-review" / "lighting")
    target_dir = output_dir / "diagnostics" / "lead-review-2026-11-10" / args.tag
    target_dir.mkdir(parents=True, exist_ok=True)
    pass_report = json.loads((lighting_dir / "pass-report.json").read_text(encoding="utf-8"))

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import apply_display_transform, filament_exposure, save_display_rgb

    scene = bpy.context.scene
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0

    def load(relative):
        path = lighting_dir / Path(relative)
        image = bpy.data.images.load(str(path), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(
            image.size[1], image.size[0], 4).copy()
        bpy.data.images.remove(image)
        return pixels

    report = {
        "stage": "E2 pass color attribution and tone-mapping isolation; no render, no re-bake",
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sourcePassReport": str((lighting_dir / "pass-report.json").relative_to(root)).replace("\\", "/"),
        "passResolutionPercent": pass_report.get("resolutionPercent"),
        "lightSetCaveat": (
            "The existing passes were rendered with the prepared-scene V0 recipe, which matches the "
            "phone bright light sets. E2 does not speak for the phone dark ceiling state."
        ),
        "exposure": filament_exposure(config),
        "views": {},
    }

    for view_id, view_entry in pass_report["views"].items():
        if view_id not in ROIS:
            continue
        passes = {name: load(entry["linear"]) for name, entry in view_entry["passes"].items()}
        combined = load(view_entry["combined"])
        diff_col = passes["DiffCol"]
        gloss_col = passes["GlossCol"]
        weighted = {
            "DiffDirWeighted": passes["DiffDir"][..., :3] * diff_col[..., :3],
            "DiffIndWeighted": passes["DiffInd"][..., :3] * diff_col[..., :3],
            "GlossDirWeighted": passes["GlossDir"][..., :3] * gloss_col[..., :3],
            "GlossIndWeighted": passes["GlossInd"][..., :3] * gloss_col[..., :3],
            "Env": passes["Env"][..., :3],
            "Emit": passes["Emit"][..., :3],
            "TransDir": passes["TransDir"][..., :3],
            "TransInd": passes["TransInd"][..., :3],
        }
        view_report = {"resolution": [combined.shape[1], combined.shape[0]], "rois": {}}
        for roi_id in ROIS[view_id]:
            components = []
            for name, pixels in weighted.items():
                components.append({"name": name, **color_stats(roi_pixels(pixels, view_id, roi_id))})
            attribution = [item for item in components
                           if item["name"] in ("DiffDirWeighted", "DiffIndWeighted",
                                               "GlossDirWeighted", "GlossIndWeighted")]
            total_abs_rb = sum(abs(item["rMinusBLinear"]) for item in attribution) or 1e-12
            total_luminance = sum(item["meanLinearLuminance"] for item in attribution) or 1e-12
            for item in attribution:
                item["shareOfAbsRMinusB"] = round(abs(item["rMinusBLinear"]) / total_abs_rb, 4)
                item["shareOfLuminance"] = round(item["meanLinearLuminance"] / total_luminance, 4)

            crop_combined = roi_pixels(combined, view_id, roi_id)
            exposure_factor = filament_exposure(config)["linearExposureFactor"]
            identity_full = combined[..., :3] * exposure_factor
            filmic_full = apply_display_transform(combined[..., :3], config)
            identity_stats = display_stats(roi_pixels(identity_full, view_id, roi_id))
            filmic_stats = display_stats(roi_pixels(filmic_full, view_id, roi_id))
            amplification = (
                round(filmic_stats["rMinusBDisplay"] / identity_stats["rMinusBDisplay"], 4)
                if abs(identity_stats["rMinusBDisplay"]) > 1e-9 else None
            )
            view_report["rois"][roi_id] = {
                "roiRaw": list(ROIS[view_id][roi_id]),
                "components": components,
                "attributionNote": (
                    "Shares use DiffDir/DiffInd/GlossDir/GlossInd weighted products only; "
                    "Env/Emit/Transmission are reported but excluded from the share denominator."
                ),
                "toneMappingIsolation": {
                    "linear": color_stats(crop_combined),
                    "identityDisplay": identity_stats,
                    "filmicDisplay": filmic_stats,
                    "filmicRMinusBAmplification": amplification,
                },
            }
            for name, rgb in (("identity", identity_full), ("filmic", filmic_full)):
                pixels = np.zeros_like(combined)
                pixels[..., :3] = rgb
                pixels[..., 3] = 1.0
                save_display_rgb(pixels, target_dir / f"{view_id}-{roi_id}-combined-{name}.png", scene)
        report["views"][view_id] = view_report
        print(f"E2_VIEW {view_id}", flush=True)

    report_path = target_dir / "e2-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"E2_COMPLETE {report_path}", flush=True)


if __name__ == "__main__":
    main()
