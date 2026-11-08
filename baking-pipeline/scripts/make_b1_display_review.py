#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat


VARIANTS = (
    ("source-order", "source-order analytic"),
    ("hdr-r11g11b10f", "HDR R11G11B10F only"),
    ("lut32", "32^3 LUT only"),
    ("hdr-lut32-dither", "HDR + LUT + dither"),
)


def fitted(path, size, crop_left=0, crop_normalized=None, amplify=1.0):
    image = Image.open(path).convert("RGB")
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    if crop_normalized:
        left, top, right, bottom = crop_normalized
        image = image.crop((int(image.width * left), int(image.height * top), int(image.width * right), int(image.height * bottom)))
    if amplify != 1.0:
        image = image.point(lambda value: min(255, round(value * amplify)))
    image.thumbnail(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (10, 14, 20))
    canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
    return canvas


def roi(image, crop_left=0):
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    return image.crop((int(image.width * 0.36), int(image.height * 0.06), int(image.width * 0.96), int(image.height * 0.96)))


def mae(first, second):
    return sum(ImageStat.Stat(ImageChops.difference(first, second)).mean) / 3


def sheet(path, title, rows, cell):
    columns = len(rows[0][1])
    result = Image.new("RGB", (columns * cell[0] + 20 * (columns + 1), (cell[1] + 58) * len(rows) + 60), (16, 22, 30))
    draw = ImageDraw.Draw(result)
    draw.text((20, 18), title, fill=(230, 235, 240))
    for row_index, (view, entries) in enumerate(rows):
        y = 50 + row_index * (cell[1] + 58)
        for column, (label, image) in enumerate(entries):
            x = 20 + column * (cell[0] + 20)
            draw.text((x, y + 4), f"{view} | {label}", fill=(220, 225, 230))
            result.paste(image, (x, y + 26))
    path.parent.mkdir(parents=True, exist_ok=True)
    result.save(path, quality=94)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--label", default="remaining-visual-review")
    args = parser.parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    calibration_dir = output_dir / "diagnostics" / "same-condition-calibration"
    target_dir = output_dir / "diagnostics" / args.label
    display_dir = target_dir / "display"
    display_report = json.loads((display_dir / "report.json").read_text(encoding="utf-8"))
    metrics = {
        "scope": "Auxiliary sRGB metrics for source-derived display models; no overall visual acceptance is inferred",
        "displayModelBoundaries": display_report["notReproduced"],
        "views": [],
    }
    rows = []
    stage_rows = []
    for view in config["camera"]["views"]:
        view_id = view["id"]
        a0_path = calibration_dir / "a0" / f"{view_id}-android-a0.png"
        analytic_path = calibration_dir / "display" / f"{view_id}-offline-full-pbr.png"
        full_path = display_dir / f"{view_id}-hdr-lut32-dither.png"
        rows.append((view_id, [
            ("A0 calibrated", fitted(a0_path, (480, 232), crop_left=154)),
            ("previous Filmic analytic", fitted(analytic_path, (480, 232))),
            ("HDR + LUT + dither model", fitted(full_path, (480, 232))),
        ]))
        a0 = roi(Image.open(a0_path).convert("RGB"), crop_left=154)
        analytic = roi(Image.open(analytic_path).convert("RGB"))
        view_metrics = {
            "view": view_id,
            "a0ToPreviousFilmicMae": mae(a0, analytic),
            "a0MeanRgb": ImageStat.Stat(a0).mean,
            "previousFilmicMeanRgb": ImageStat.Stat(analytic).mean,
            "displayStages": display_report["views"][view_id],
        }
        entries = [("A0", fitted(a0_path, (400, 193), crop_left=154)),
                   ("previous analytic", fitted(analytic_path, (400, 193)))]
        for variant, label in VARIANTS:
            path = display_dir / f"{view_id}-{variant}.png"
            image = roi(Image.open(path).convert("RGB"))
            view_metrics[f"a0To{variant}Mae"] = mae(a0, image)
            view_metrics[f"{variant}MeanRgb"] = ImageStat.Stat(image).mean
            if view_id == "01-entry":
                entries.append((label, fitted(path, (400, 193))))
        stage_rows.append((view_id, entries))
        metrics["views"].append(view_metrics)
    sheet(target_dir / "contact-display-four-views.jpg", "B1 remaining review | A0 / previous Filmic / source-derived display model", rows, (480, 232))
    sheet(target_dir / "contact-display-stages-entry.jpg", "B1 remaining review | entry display-chain stages; models are not device readbacks", [stage_rows[0]], (400, 193))

    roi_definitions = (
        ("01-entry-pink-highlight", "01-entry", (0.32, 0.00, 0.61, 0.23)),
        ("04-right-local-green", "04-right", (0.44, 0.42, 0.73, 0.90)),
    )
    roi_rows = []
    for label, view_id, crop in roi_definitions:
        entries = [("A0", fitted(calibration_dir / "a0" / f"{view_id}-android-a0.png", (520, 300), crop_left=154, crop_normalized=crop)),
                   ("previous analytic", fitted(calibration_dir / "display" / f"{view_id}-offline-full-pbr.png", (520, 300), crop_normalized=crop)),
                   ("HDR + LUT + dither", fitted(display_dir / f"{view_id}-hdr-lut32-dither.png", (520, 300), crop_normalized=crop))]
        roi_rows.append((label, entries))
    sheet(target_dir / "contact-display-rois.jpg", "B1 remaining review | localized pink and green residuals", roi_rows, (520, 300))

    lighting_dir = target_dir / "lighting"
    decomposition_path = lighting_dir / "decomposition-report.json"
    if decomposition_path.is_file():
        decomposition = json.loads(decomposition_path.read_text(encoding="utf-8"))
        lighting_rows = []
        for view_id in decomposition["views"]:
            entries = [
                ("A0", fitted(calibration_dir / "a0" / f"{view_id}-android-a0.png", (400, 193), crop_left=154)),
                ("full Filmic", fitted(calibration_dir / "display" / f"{view_id}-offline-full-pbr.png", (400, 193))),
            ]
            for name, label in (("DiffDirWeighted", "direct diffuse x color"),
                                ("GlossDirWeighted", "direct glossy x color"),
                                ("IndirectWeighted", "indirect diffuse + glossy")):
                relative = decomposition["views"][view_id]["outputs"][name]["png"]
                entries.append((label, fitted(lighting_dir / relative, (400, 193))))
            lighting_rows.append((view_id, entries))
        sheet(target_dir / "contact-lighting-passes.jpg",
              "B1 remaining review | Cycles weighted passes; direct/indirect light must be multiplied by color",
              lighting_rows, (400, 193))
        metrics["lightingDecomposition"] = {
            "report": "lighting/decomposition-report.json",
            "formula": decomposition["formula"],
            "views": {view_id: data["samples"] for view_id, data in decomposition["views"].items()},
        }
    metrics["manualVisualAcceptance"] = "Requires actual inspection of the generated contacts; see B1 calibration documentation"
    path = target_dir / "review.json"
    path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"DISPLAY_REVIEW_COMPLETE {path}")


if __name__ == "__main__":
    main()
