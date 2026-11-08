#!/usr/bin/env python3
"""Build the ceiling/backface/shadow contact sheet for the B1 decision gate.

Read-only with respect to the baked scene and phone assets. Reads the existing
ceiling-boundary diagnostic outputs plus the calibrated A0 captures and writes
one contact sheet and one review JSON under diagnostics/ceiling-boundary/.
"""
import argparse
import json
from datetime import date
from pathlib import Path

from PIL import Image, ImageDraw, ImageStat

A0_CROP_LEFT = 154
VIEWS = ("01-entry", "04-right")
SHADOW_VARIANTS = (
    "baseline",
    "ceiling-lights-no-shadow",
    "ceiling-objects-no-shadow",
    "all-no-shadow",
)
CEILING_BAND = (0.06, 0.0, 0.94, 0.36)


def fitted(
    path: Path,
    size: tuple[int, int],
    crop_left: int = 0,
    crop_normalized: tuple[float, float, float, float] | None = None,
) -> Image.Image:
    image = Image.open(path).convert("RGB")
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    if crop_normalized:
        left, top, right, bottom = crop_normalized
        image = image.crop(
            (
                int(image.width * left),
                int(image.height * top),
                int(image.width * right),
                int(image.height * bottom),
            )
        )
    image.thumbnail(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (10, 14, 20))
    canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
    return canvas


def band(path: Path, crop_left: int = 0) -> Image.Image:
    image = Image.open(path).convert("RGB")
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    left, top, right, bottom = CEILING_BAND
    return image.crop(
        (
            int(image.width * left),
            int(image.height * top),
            int(image.width * right),
            int(image.height * bottom),
        )
    )


def mean_rgb(image: Image.Image) -> list[float]:
    return [round(value, 2) for value in ImageStat.Stat(image).mean]


def sheet(
    path: Path,
    title: str,
    rows: list[tuple[str, list[tuple[str, Image.Image]]]],
    cell: tuple[int, int] = (480, 232),
) -> None:
    columns = len(rows[0][1])
    width = columns * cell[0] + 20 * (columns + 1)
    height = (cell[1] + 58) * len(rows) + 60
    canvas = Image.new("RGB", (width, height), (16, 22, 30))
    draw = ImageDraw.Draw(canvas)
    draw.text((20, 18), title, fill=(230, 235, 240))
    for row_index, (view, entries) in enumerate(rows):
        y = 50 + row_index * (cell[1] + 58)
        for column, (label, image) in enumerate(entries):
            x = 20 + column * (cell[0] + 20)
            draw.text((x, y + 4), f"{view} | {label}", fill=(220, 225, 230))
            canvas.paste(image, (x, y + 26))
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(path, quality=94)


def first_ceiling_sample(view_data: dict) -> dict:
    for sample in view_data["samples"]:
        if sample["object"].lower().startswith("ceiling"):
            return sample
    return view_data["samples"][0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config_path: Path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / "ceiling-boundary"
    scene_report = json.loads((target_dir / "scene-report.json").read_text(encoding="utf-8"))
    a0_dir = output_dir / "diagnostics" / "same-condition-calibration" / "a0"

    cell = (480, 232)
    rows: list[tuple[str, list[tuple[str, Image.Image]]]] = []
    metrics: dict = {
        "stage": "B1 ceiling/backface/shadow visual review; auxiliary contact sheet",
        "generatedAt": date.today().isoformat(),
        "scope": "Same-condition diagnostic renders, not an acceptance decision by themselves",
        "views": [],
    }

    for view_id in VIEWS:
        a0_path = a0_dir / f"{view_id}-android-a0.png"
        baseline_path = target_dir / "shadow-tests" / f"{view_id}-baseline.png"
        no_shadow_path = target_dir / "shadow-tests" / f"{view_id}-all-no-shadow.png"
        true_normal_path = target_dir / "normal" / f"{view_id}-true.png"
        rows.append(
            (
                view_id,
                [
                    ("A0 calibrated", fitted(a0_path, cell, crop_left=A0_CROP_LEFT)),
                    ("A0 ceiling band", fitted(a0_path, cell, crop_left=A0_CROP_LEFT, crop_normalized=CEILING_BAND)),
                    ("offline baseline", fitted(baseline_path, cell)),
                    ("offline ceiling band", fitted(baseline_path, cell, crop_normalized=CEILING_BAND)),
                    ("offline no-shadow ceiling band", fitted(no_shadow_path, cell, crop_normalized=CEILING_BAND)),
                    ("Cycles view-facing true normal", fitted(true_normal_path, cell)),
                ],
            )
        )
        sample = first_ceiling_sample(scene_report["views"][view_id])
        metrics["views"].append(
            {
                "view": view_id,
                "ceilingBandMeanRgb": {
                    "a0": mean_rgb(band(a0_path, crop_left=A0_CROP_LEFT)),
                    "offlineBaseline": mean_rgb(band(baseline_path)),
                },
                "shadowVariantMeanRgb": {
                    variant: mean_rgb(band(target_dir / "shadow-tests" / f"{view_id}-{variant}.png"))
                    for variant in SHADOW_VARIANTS
                },
                "referenceSample": {
                    "note": "01-entry uses the first ceiling sample; 04-right has no ceiling sample and uses the first whiteboard sample",
                    "pixel": sample["pixel"],
                    "object": sample["object"],
                    "material": sample["material"],
                    "cameraSideOfFace": sample["cameraSideOfFace"],
                    "faceNormalWorld": [round(value, 4) for value in sample["faceNormalWorld"]],
                    "loopNormalMeanWorld": [round(value, 4) for value in sample["loopNormalWorld"]["mean"]],
                    "loopNormalDotFace": [round(value, 4) for value in sample["loopNormalWorld"]["dotFace"]],
                    "nearestCeilingLight": {
                        "name": sample["nearestCeilingLight"]["name"],
                        "type": sample["nearestCeilingLight"]["type"],
                        "distanceMeters": round(sample["nearestCeilingLight"]["distanceMeters"], 4),
                    },
                    "expectedDiffusePointOnlyLoopFlipped": sample["expectedDiffusePointOnly"]["loopFlipped"],
                    "cyclesDirectDiffuseRgb": sample["cyclesPass"]["directDiffuseRgb"],
                    "visibilityRatioVsPointOnlyLoopFlipped": sample["visibilityRatioVsPointOnlyLoopFlipped"],
                    "diffuseColorRgb": sample["diffuseColorRgb"],
                },
            }
        )

    sheet(
        target_dir / "contact-ceiling-boundary.jpg",
        "B1 ceiling boundary | A0 vs offline Cycles, ceiling normals and shadow variants",
        rows,
        cell=cell,
    )
    metrics["evidence"] = {
        "authoredNormals": "Ceiling0 polygon and custom loop normals point +Z (up); the calibrated camera sees the back face.",
        "cyclesBehaviour": "Cycles flips the shading normal toward the ray, so offline direct diffuse lights the ceiling; Filament doubleSided semantics are not proven by these images.",
        "shadowTests": "Disabling all shadows brightens the room and leaves the ceiling pools, so an offline shadow-strength correction is not supported.",
        "phoneChange": "none; A0 recipe, phone materials/lights, AR, pose and door/window interaction unchanged",
    }
    metrics["manualVisualAcceptance"] = (
        "视觉仍未通过，保持待验收，不进入 B2。顶面法线/背面边界与阴影变体已实际生成并打开对照；"
        "该诊断只定位差异来源，未证明 Filament 运行时背面翻转行为，因此不采纳任何修正。"
    )
    path = target_dir / "review.json"
    path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CEILING_BOUNDARY_REVIEW_COMPLETE {path}")


if __name__ == "__main__":
    main()
