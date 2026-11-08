#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat


def fitted(path, size, crop_left=0, crop_normalized=None):
    image = Image.open(path).convert("RGB")
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    if crop_normalized:
        left, top, right, bottom = crop_normalized
        image = image.crop((int(image.width * left), int(image.height * top), int(image.width * right), int(image.height * bottom)))
    image.thumbnail(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (10, 14, 20))
    canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
    return canvas


def mae(first, second):
    return sum(ImageStat.Stat(ImageChops.difference(first, second)).mean) / 3


def roi(image, crop_left=0):
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    return image.crop((int(image.width * 0.36), int(image.height * 0.06), int(image.width * 0.96), int(image.height * 0.96)))


def sheet(path, title, rows, cell=(640, 309)):
    columns = len(rows[0][1])
    sheet = Image.new("RGB", (columns * cell[0] + 20 * (columns + 1), (cell[1] + 58) * len(rows) + 60), (16, 22, 30))
    draw = ImageDraw.Draw(sheet)
    draw.text((20, 18), title, fill=(230, 235, 240))
    for row_index, (view, entries) in enumerate(rows):
        y = 50 + row_index * (cell[1] + 58)
        for column, (label, image) in enumerate(entries):
            x = 20 + column * (cell[0] + 20)
            draw.text((x, y + 4), f"{view} | {label}", fill=(220, 225, 230))
            sheet.paste(image, (x, y + 26))
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path, quality=94)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / "same-condition-calibration"
    cell = (640, 309)
    display_rows = []
    metrics = {"scope": "Auxiliary sRGB metrics only after native 80-degree projection evidence; not an acceptance decision", "views": []}
    for view in config["camera"]["views"]:
        view_id = view["id"]
        a0_path = target_dir / "a0" / f"{view_id}-android-a0.png"
        aces_path = output_dir / "previews" / f"{view_id}-offline-full-pbr.png"
        filmic_path = target_dir / "display" / f"{view_id}-offline-full-pbr.png"
        display_rows.append((view_id, [
            ("A0 calibrated", fitted(a0_path, cell, crop_left=154)),
            ("10.5 ACES", fitted(aces_path, cell)),
            ("Filmic analytic", fitted(filmic_path, cell)),
        ]))
        a0 = roi(Image.open(a0_path).convert("RGB"), crop_left=154)
        aces = roi(Image.open(aces_path).convert("RGB"))
        filmic = roi(Image.open(filmic_path).convert("RGB"))
        metrics["views"].append({
            "view": view_id,
            "a0ToAcesMae": mae(a0, aces),
            "a0ToFilmicMae": mae(a0, filmic),
            "a0MeanRgb": ImageStat.Stat(a0).mean,
            "acesMeanRgb": ImageStat.Stat(aces).mean,
            "filmicMeanRgb": ImageStat.Stat(filmic).mean,
        })
    sheet(target_dir / "contact-a0-display.jpg", "B1 calibration | A0 / 10.5 ACES / analytic Filmic", display_rows)

    contribution_rows = []
    for view_id in ("01-entry", "02-reverse"):
        contribution_rows.append((view_id, [
            (label, fitted(target_dir / "contributions" / f"{view_id}-{variant}.png", (480, 232)))
            for label, variant in (("all", "all"), ("sun only", "sun-only"), ("ceiling only", "ceiling-only"), ("IBL only", "ibl-only"))
        ]))
    sheet(target_dir / "contact-contributions.jpg", "B1 calibration | same-scene light source variants", contribution_rows, cell=(480, 232))

    normalization_rows = []
    normalization_metrics = []
    for view_id in ("01-entry", "02-reverse"):
        a0_path = target_dir / "a0" / f"{view_id}-android-a0.png"
        baseline_path = output_dir / "diagnostics" / "light-color-unnormalized-baseline" / "contributions" / f"{view_id}-all.png"
        normalized_path = output_dir / "diagnostics" / "light-color-normalization" / "contributions" / f"{view_id}-all.png"
        normalization_rows.append((view_id, [
            ("A0 calibrated", fitted(a0_path, cell, crop_left=154)),
            ("unnormalized baseline", fitted(baseline_path, cell)),
            ("Filament RGB normalized", fitted(normalized_path, cell)),
        ]))
        baseline = roi(Image.open(baseline_path).convert("RGB"))
        normalized = roi(Image.open(normalized_path).convert("RGB"))
        normalization_metrics.append({
            "view": view_id,
            "baselineToNormalizedMae": mae(baseline, normalized),
            "baselineMeanRgb": ImageStat.Stat(baseline).mean,
            "normalizedMeanRgb": ImageStat.Stat(normalized).mean,
        })
    sheet(target_dir / "contact-light-color-normalization.jpg", "B1 calibration | light color normalization is diagnostic, not acceptance", normalization_rows)
    metrics["lightColorNormalization"] = normalization_metrics

    crop = (0.24, 0.15, 0.54, 0.68)
    transmission_rows = [("01-entry", [
        ("A0 transmission", fitted(target_dir / "a0" / "01-entry-android-a0.png", (640, 480), crop_left=154, crop_normalized=crop)),
        ("10.5 ACES transmission", fitted(output_dir / "previews" / "01-entry-offline-full-pbr.png", (640, 480), crop_normalized=crop)),
        ("Filmic transmission", fitted(target_dir / "display" / "01-entry-offline-full-pbr.png", (640, 480), crop_normalized=crop)),
    ])]
    sheet(target_dir / "contact-transmission-entry.jpg", "B1 calibration | transmission and exterior are realtime-only, not baked", transmission_rows, cell=(640, 480))
    metrics["transmissionEvidence"] = {
        "glazing": "KHR_materials_transmission=1, IOR=1.4500000476837158, alphaMode=OPAQUE, doubleSided=true, roughness=0.025",
        "exterior": "Actual exterior view uses emissiveTexture with emissiveFactor 0.8 and remains in realtime_special_material_or_backdrop",
        "acceptanceBoundary": "Filament screen-space refraction and Cycles path tracing are different mechanisms. The current images do not prove equivalent exterior/transmission response; no window is hidden or baked to manufacture a pass.",
    }
    metrics["manualVisualAcceptance"] = "Pending manual review of the generated contact sheets; no overall pass is inferred from MAE."
    path = target_dir / "review.json"
    path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CALIBRATION_REVIEW_COMPLETE {path}")


if __name__ == "__main__":
    main()
