#!/usr/bin/env python3
"""E5: dynamic-range statistics for the scene-linear lightmap masters.

No render, no re-bake. Reads the direct/indirect EXR masters with a memory-safe
foreach_get, excludes the zero background and an 8 px margin erosion, then
reports luminance/channel percentiles, clamp energy loss at 4/8/16, and the
relative error of 8-bit RGBM/RGBD encodings (range 16).

Invoke:
    blender.exe --background --python scripts/analyze_b1_e5_hdr.py -- \
        --config configs/example_room_2.json
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import bpy
import numpy as np

MARGIN_EROSION_PIXELS = 8
SAMPLE_STRIDE = 2
PERCENTILES = (50.0, 90.0, 99.0, 99.9, 100.0)
CLAMP_LEVELS = (4.0, 8.0, 16.0)
ENCODING_RANGE = 16.0
ENCODING_RANGES = (16.0, 64.0, 256.0, 1024.0, 4096.0)
MIN_ENCODED_VALUE = 1e-4


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="E5 lightmap HDR statistics")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--tag", default="e5-hdr")
    return parser.parse_args(argv)


def load_rgb(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    width, height = image.size
    buffer = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(buffer)
    bpy.data.images.remove(image)
    return buffer.reshape(height, width, 4)[..., :3]


def erode(mask, iterations):
    result = mask
    for _ in range(iterations):
        shifted = np.zeros_like(result)
        shifted[1:-1, 1:-1] = (
            result[1:-1, 1:-1] & result[:-2, 1:-1] & result[2:, 1:-1]
            & result[1:-1, :-2] & result[1:-1, 2:]
        )
        result = shifted
    return result


def percentile_row(values):
    result = np.percentile(values, PERCENTILES)
    return {f"p{label:g}": round(float(value), 6) for label, value in zip(PERCENTILES, result)}


def encoding_errors(rgb, range_value):
    maximum = rgb.max(axis=1)
    keep = maximum > MIN_ENCODED_VALUE
    values = rgb[keep]
    peak = maximum[keep]
    relative = {}
    for name in ("RGBM", "RGBD"):
        headroom = np.minimum(peak, range_value) / range_value * 255.0
        if name == "RGBM":
            scale = np.ceil(headroom) / 255.0 * range_value
        else:
            scale = np.maximum(np.round(headroom), 1.0) / 255.0 * range_value
        scale = np.maximum(scale, range_value / 255.0)
        clipped = np.minimum(values, scale[:, None])
        encoded = np.round(clipped / scale[:, None] * 255.0) / 255.0 * scale[:, None]
        error = np.abs(encoded - values) / np.maximum(values, 1e-9)
        per_pixel = error.mean(axis=1)
        relative[name] = {
            "p50": round(float(np.percentile(per_pixel, 50)), 6),
            "p95": round(float(np.percentile(per_pixel, 95)), 6),
            "p99": round(float(np.percentile(per_pixel, 99)), 6),
            "shareAbove5Percent": round(float((per_pixel > 0.05).mean()), 6),
        }
    return relative


def analyze(path):
    rgb = load_rgb(path)
    height, width = rgb.shape[:2]
    luminance = rgb.mean(axis=2)
    valid = luminance > 0.0
    valid_fraction = float(valid.mean())
    content = erode(valid, MARGIN_EROSION_PIXELS)
    content_fraction = float(content.mean())

    sampled_rgb = rgb[content][::SAMPLE_STRIDE].astype(np.float32)
    sampled_luminance = luminance[content][::SAMPLE_STRIDE].astype(np.float32)
    channels = {
        "R": percentile_row(sampled_rgb[:, 0]),
        "G": percentile_row(sampled_rgb[:, 1]),
        "B": percentile_row(sampled_rgb[:, 2]),
        "luminance": percentile_row(sampled_luminance),
    }

    sampled_peak = sampled_rgb.max(axis=1)
    totals = {}
    for level in CLAMP_LEVELS:
        clamped = np.sum(np.minimum(rgb, level), dtype=np.float64)
        totals[str(level)] = {
            "clampEnergyLossPercent": round(
                float((1.0 - clamped / max(np.sum(rgb, dtype=np.float64), 1e-30)) * 100.0), 4),
            "pixelFractionAbovePercent": round(float((sampled_peak > level).mean() * 100.0), 4),
        }

    sensitivity = {}
    for range_value in ENCODING_RANGES:
        errors = encoding_errors(sampled_rgb, range_value)
        sensitivity[str(range_value)] = {
            "clipFractionPercent": round(float((sampled_peak > range_value).mean() * 100.0), 4),
            "RGBM": errors["RGBM"],
            "RGBD": errors["RGBD"],
        }

    return {
        "atlas": [width, height],
        "validPixelFraction": round(valid_fraction, 6),
        "contentPixelFractionAfterMarginErosion": round(content_fraction, 6),
        "sampleCount": int(sampled_luminance.size),
        "percentiles": channels,
        "maxRgb": [round(float(value), 6) for value in rgb.reshape(-1, 3).max(axis=0)],
        "clampEnergy": totals,
        "encodingError8bitRange16": sensitivity[str(ENCODING_RANGE)],
        "encodingRangeSensitivity": sensitivity,
    }


def smallest_range(stats, clip_limit=0.1):
    for range_value in ENCODING_RANGES:
        entry = stats["encodingRangeSensitivity"][str(range_value)]
        if entry["clipFractionPercent"] <= clip_limit:
            return range_value, entry
    return None, None


def recommendations(direct, indirect):
    notes = []
    for name, stats in (("direct", direct), ("indirect", indirect)):
        p999 = stats["percentiles"]["luminance"]["p99.9"]
        p90 = stats["percentiles"]["luminance"]["p90"]
        if p90 > 0 and p999 / p90 > 10.0:
            notes.append(f"{name}: p99.9/p90 = {p999 / p90:.1f} > 10, clamp or separate the highlight tail.")
        rgbm = stats["encodingError8bitRange16"]["RGBM"]["p99"]
        notes.append(f"{name}: 8-bit RGBM p99 relative error {rgbm * 100:.2f}% "
                     f"(threshold 5%) -> {'reject' if rgbm > 0.05 else 'acceptable'}.")
        clip16 = stats["clampEnergy"]["16.0"]["pixelFractionAbovePercent"]
        notes.append(f"{name}: {clip16:.2f}% of content pixels exceed 16; clamping there is not display-neutral.")
    for name, stats in (("direct", direct), ("indirect", indirect)):
        range_value, entry = smallest_range(stats)
        if range_value is None:
            notes.append(f"{name}: no tested 8-bit range keeps clipping <= 0.1%.")
        else:
            notes.append(f"{name}: smallest tested 8-bit RGBM range with clip <= 0.1% is "
                         f"{range_value:g}; RGBM p99 error {entry['RGBM']['p99'] * 100:.2f}%.")
    notes.append(
        "FP16 remains the reference unless a B2 normalization/clamp policy is agreed; E5 applies clamp and "
        "encoding to raw scene-linear radiance and modifies no master.")
    return notes


def main():
    args = parse_args()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = config_path.parents[1]
    output_dir = root / "output" / config["roomId"]
    lightmaps = output_dir / "lightmaps"
    target_dir = output_dir / "diagnostics" / "lead-review-2026-11-10" / args.tag
    target_dir.mkdir(parents=True, exist_ok=True)

    report = {
        "stage": "E5 lightmap dynamic-range statistics; read-only masters, no render, no re-bake",
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sourceSha256": config["expectedSha256"],
        "method": {
            "zeroBackgroundExcluded": True,
            "marginErosionPixels": MARGIN_EROSION_PIXELS,
            "percentileSampleStride": SAMPLE_STRIDE,
            "clampLevels": list(CLAMP_LEVELS),
            "encodingRange": ENCODING_RANGE,
        },
        "images": {},
    }
    for name, filename in (("direct", "direct-diffuse.exr"), ("indirect", "indirect.exr")):
        report["images"][name] = analyze(lightmaps / filename)
        print(f"E5_IMAGE {name} {report['images'][name]['percentiles']['luminance']}", flush=True)
    report["recommendations"] = recommendations(report["images"]["direct"], report["images"]["indirect"])
    report_path = target_dir / "e5-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"E5_COMPLETE {report_path}", flush=True)


if __name__ == "__main__":
    main()
