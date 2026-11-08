#!/usr/bin/env python3
"""Build the phone-side material/shadow probe contact sheet for B1.

Read-only with respect to the baked scene, phone code and assets. Reads the
calibrated A0 captures, the existing A6/A1_DPCF debug-mode captures and the
offline Cycles shadow-test renders, then writes one contact sheet and one
ROI-measurement JSON under diagnostics/ceiling-boundary/phone-probe/.
"""
import argparse
import json
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

PHONE_CROP_LEFT = 154
PHONE_SIZE = (2640, 1200)
ROIS = {
    "entry": (820, 8, 1440, 215),
    "right": (1460, 8, 2250, 140),
}
CELL = (600, 330)
BOOST_GAMMA = 0.45
FONT_PATH = "C:/Windows/Fonts/arial.ttf"


def load(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def read_probe(path: Path) -> dict:
    text = path.read_text(encoding="utf-8").strip()
    marker = "MATERIAL_PROBE_JSON "
    if text.startswith(marker):
        text = text[len(marker):]
    return json.loads(text)


def boost(image: Image.Image, gamma: float = BOOST_GAMMA) -> Image.Image:
    lookup = [min(255, round(255 * (value / 255) ** gamma)) for value in range(256)]
    return image.point(lookup * 3)


def normalized_crop(image: Image.Image, view: str) -> Image.Image:
    x0, y0, x1, y1 = ROIS[view]
    viewport_width = PHONE_SIZE[0] - PHONE_CROP_LEFT
    viewport_height = PHONE_SIZE[1]
    return image.crop(
        (
            round((x0 - PHONE_CROP_LEFT) / viewport_width * image.width),
            round(y0 / viewport_height * image.height),
            round((x1 - PHONE_CROP_LEFT) / viewport_width * image.width),
            round(y1 / viewport_height * image.height),
        )
    )


def phone_crop(image: Image.Image, view: str) -> Image.Image:
    return image.crop(ROIS[view])


def fitted(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    scale = min(size[0] / image.width, size[1] / image.height)
    copy = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGB", size, (8, 12, 18))
    canvas.paste(copy, ((size[0] - copy.width) // 2, (size[1] - copy.height) // 2))
    return canvas


def measurement_crop(image: Image.Image, view: str) -> Image.Image:
    """Phone screenshots are already in raw screenshot coordinates."""
    if image.size == PHONE_SIZE:
        return phone_crop(image, view)
    return normalized_crop(image, view)


def stats(image: Image.Image, view: str) -> dict:
    array = np.asarray(measurement_crop(image, view)).astype(np.float32)
    luminance = array.mean(axis=2)
    mean_rgb = array.reshape(-1, 3).mean(axis=0)
    return {
        "meanRgb": [round(float(value), 2) for value in mean_rgb],
        "medianLuminance": round(float(np.median(luminance)), 2),
        "p95Luminance": round(float(np.percentile(luminance, 95)), 2),
        "p99Luminance": round(float(np.percentile(luminance, 99)), 2),
        "maxLuminance": round(float(luminance.max()), 2),
        "fractionAbove32Percent": round(float((luminance > 32).mean() * 100), 2),
        "fractionAbove64Percent": round(float((luminance > 64).mean() * 100), 2),
    }


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    try:
        return ImageFont.truetype(FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def sheet(path: Path, title: str, rows: list[tuple[str, list[tuple[str, Image.Image]]]]) -> None:
    columns = max(len(entries) for _, entries in rows)
    width = columns * CELL[0] + 20 * (columns + 1)
    height = (CELL[1] + 34) * len(rows) + 240
    canvas = Image.new("RGB", (width, height), (16, 22, 30))
    draw = ImageDraw.Draw(canvas)
    draw.text((20, 16), title, fill=(235, 240, 245), font=font(22))
    y = 60
    for view, entries in rows:
        for column, (label, image) in enumerate(entries):
            x = 20 + column * (CELL[0] + 20)
            draw.text((x, y), f"{view} | {label}", fill=(220, 228, 236), font=font(16))
            canvas.paste(image, (x, y + 22))
        y += CELL[1] + 34
    footer = [
        "Runtime probe (A0 original, 2026-11-08): ceiling_tile instanceDoubleSided=true; parent base_lit_opaque materialDoubleSided=false;",
        "shading=LIT; ceilingShadowReceiver=true; shadowingEnabled=true; 4 POINT lights at y=1.0194, shadowCaster=true, channels=[T,F,F,F].",
        "A6 probe: shadowingEnabled=false. A1_DPCF probe: currentExperiment=A1_DPCF, shadowFilter=DPCF, shadowsEnabled=true.",
        "One POINT lamp pose differs across runs: A0/A6 z=0.129, A1_DPCF x=-0.73, A0 replay z=-0.278; not per-lamp identical.",
        "Ceiling ROI mean RGB: A0 calibrated (7.9,6.2,4.2); A6 (183.2,170.0,149.9); A1_DPCF (169.0,156.3,136.9); offline (191.9,166.2,155.6).",
        "Filament 1.68.2: MaterialInstance.isDoubleSided=true requires double-sided capability, so surface_shading_parameters.fs flips n/t/b on back faces.",
        "A0 replay 15:55 ceiling is bright, but applyQuality(A0) is not verified (currentExperiment defaults to A0); it is not used as a fix or acceptance.",
    ]
    footer_font = font(15)
    for index, line in enumerate(footer):
        draw.text((20, y + 8 + index * 22), line, fill=(200, 208, 216), font=footer_font)
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, quality=95)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config_path: Path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    a0_dir = output_dir / "diagnostics" / "same-condition-calibration" / "a0"
    target_dir = output_dir / "diagnostics" / "ceiling-boundary"
    probe_dir = target_dir / "phone-probe"

    a0_entry = load(a0_dir / "01-entry-android-a0.png")
    a0_right = load(a0_dir / "04-right-android-a0.png")
    a0_reverse = load(a0_dir / "02-reverse-android-a0.png")
    a0_left = load(a0_dir / "03-left-android-a0.png")
    a6_entry = load(probe_dir / "01-entry-android-a6-no-shadow.png")
    dpcf_entry = load(probe_dir / "01-entry-android-a1-dpcf.png")
    replay_entry = load(probe_dir / "01-entry-android-a0-restored.png")
    offline_entry = load(target_dir / "shadow-tests" / "01-entry-baseline.png")
    offline_right = load(target_dir / "shadow-tests" / "04-right-baseline.png")

    rows = [
        (
            "01-entry",
            [
                ("A0 full", fitted(a0_entry, CELL)),
                ("A0 ceiling raw", fitted(phone_crop(a0_entry, "entry"), CELL)),
                ("A0 ceiling boosted", fitted(boost(phone_crop(a0_entry, "entry")), CELL)),
                ("A6 no-shadow boosted", fitted(boost(phone_crop(a6_entry, "entry")), CELL)),
                ("A1_DPCF boosted", fitted(boost(phone_crop(dpcf_entry, "entry")), CELL)),
                ("offline baseline boosted", fitted(boost(normalized_crop(offline_entry, "entry")), CELL)),
            ],
        ),
        (
            "04-right",
            [
                ("A0 full", fitted(a0_right, CELL)),
                ("A0 ceiling raw", fitted(phone_crop(a0_right, "right"), CELL)),
                ("A0 ceiling boosted", fitted(boost(phone_crop(a0_right, "right")), CELL)),
                ("offline baseline boosted", fitted(boost(normalized_crop(offline_right, "right")), CELL)),
            ],
        ),
        (
            "02-reverse",
            [
                ("A0 full", fitted(a0_reverse, CELL)),
            ],
        ),
        (
            "03-left",
            [
                ("A0 full", fitted(a0_left, CELL)),
            ],
        ),
        (
            "A0 replay",
            [
                ("15:55 apply unconfirmed", fitted(replay_entry, CELL)),
            ],
        ),
    ]
    sheet(
        probe_dir / "contact-phone-probe.jpg",
        "B1 phone-side doubleSided/shadow probe | A0 vs A6 vs A1_DPCF vs offline",
        rows,
    )

    measurements = []
    for name, path, view in (
        ("A0 calibrated", a0_dir / "01-entry-android-a0.png", "entry"),
        ("A0 replay 15:55", probe_dir / "01-entry-android-a0-restored.png", "entry"),
        ("A1_DPCF", probe_dir / "01-entry-android-a1-dpcf.png", "entry"),
        ("A6 no-shadow", probe_dir / "01-entry-android-a6-no-shadow.png", "entry"),
        ("offline baseline", target_dir / "shadow-tests" / "01-entry-baseline.png", "entry"),
        ("A0 calibrated", a0_dir / "04-right-android-a0.png", "right"),
        ("offline baseline", target_dir / "shadow-tests" / "04-right-baseline.png", "right"),
    ):
        measurements.append(
            {
                "image": str(path.relative_to(output_dir)).replace("\\", "/"),
                "label": name,
                "view": view,
                **stats(load(path), view),
            }
        )

    report = {
        "stage": "B1 phone-side doubleSided/shadow read-only probe; corrected ceiling-only ROIs",
        "generatedAt": date.today().isoformat(),
        "roiNote": (
            "Phone screenshots are 2640x1200 with a 154 px black left strip; ROIs are given in raw "
            "screenshot coordinates and exclude the strip. Offline Cycles renders are 621x300 with the "
            "same 2.072 aspect as the phone viewport, so the same normalized ROI is applied."
        ),
        "rois": {view: list(roi) for view, roi in ROIS.items()},
        "measurements": measurements,
        "runtimeProbe": {
            "originalModelA0": read_probe(probe_dir / "runtime-material-probe-original.json"),
            "a6NoShadow": read_probe(probe_dir / "runtime-material-probe-a6.json"),
            "a1Dpcf": read_probe(probe_dir / "runtime-material-probe-a1-dpcf.json"),
            "a0Replay": read_probe(probe_dir / "runtime-material-probe-a0-restored.json"),
        },
        "evidence": {
            "doubleSidedFlip": (
                "ceiling_tile MaterialInstance.isDoubleSided()=true is a native read. Filament's "
                "FMaterialInstance::setDoubleSided returns before setting mIsDoubleSided when the parent "
                "material lacks double-sided capability, so true proves the capability, _doubleSided=1 and "
                "culling=NONE; surface_shading_parameters.fs therefore flips n/t/b on back faces."
            ),
            "shadowPath": (
                "Verified A6 (shadowingEnabled=false) and A1_DPCF (currentExperiment=A1_DPCF, "
                "shadowFilter=DPCF, shadowsEnabled=true) both light the entry ceiling with pools, while the "
                "calibrated A0 entry/right ceilings are near-black. The 512 local shadow map size is shared "
                "by A0 and A1_DPCF, so the 512 map alone does not explain the difference."
            ),
            "notUnique": (
                "The A0 replay at 15:55 rendered a bright ceiling, but applyQuality(A0) could not be "
                "verified (currentExperiment defaults to A0; the AO-option probe was added after the device "
                "disconnected). Therefore the exact 512/PCSS near-light self-shadow mechanism and its "
                "occluder (tile self-shadow vs fixture/grid) are not uniquely attributable."
            ),
        },
        "caveats": {
            "lampPoseVariation": (
                "One POINT light is not at the same pose across runs: original A0 and A6 show "
                "(-1.4994771, 1.0194, 0.12881418), the A1_DPCF run shows (-0.73, 0.9854, 0.14) and the A0 replay "
                "shows (-1.5390999, 1.0253999, -0.2778499); the other three POINT lights and the SUN match. "
                "The same-condition comparison is therefore not per-lamp identical, and the lamp pose must be "
                "recorded as an uncontrolled variable."
            ),
            "a0Replay": (
                "The A0 replay passes currentExperiment=A0 (the default) and shadowingEnabled=true, but whether "
                "applyQuality(A0) actually ran is not verified; the added mAmbientOcclusionOptions read never ran "
                "because the device disconnected. It is not used as a fix or as acceptance evidence."
            ),
        },
        "manualVisualAcceptance": (
            "视觉仍未通过。四张标定 A0 中 entry/right 顶面近黑，reverse 暗、left 仅局部灯池；"
            "A6/A1_DPCF 只证明阴影链路参与，未证明或实施 512/PCSS 归因与修正。"
        ),
    }
    path = probe_dir / "ceiling-roi.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"PHONE_PROBE_REVIEW_COMPLETE {path}")


if __name__ == "__main__":
    main()
