#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


def fitted(path, size, crop_left=0):
    image = Image.open(path).convert("RGB")
    if crop_left:
        image = image.crop((crop_left, 0, image.width, image.height))
    image.thumbnail(size, Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", size, (10, 14, 20))
    canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
    return canvas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    cell = (960, 540)
    for suffix, title in (("offline-full-pbr", "offline-full-pbr"), ("baked-static-diagnostic", "baked-static-diagnostic")):
        sheet = Image.new("RGB", (cell[0] * 2 + 60, (cell[1] + 70) * 4 + 60), (16, 22, 30))
        draw = ImageDraw.Draw(sheet)
        draw.text((20, 18), f"Example_Room_2 | Android A0 (left) vs {title} (right)", fill=(230, 235, 240))
        for index, view in enumerate(config["camera"]["views"]):
            y = 60 + index * (cell[1] + 70)
            draw.text((20, y + 4), f"{view['id']} | Android A0", fill=(220, 225, 230))
            draw.text((cell[0] + 40, y + 4), f"{view['id']} | {title}", fill=(220, 225, 230))
            android = fitted(output_dir / "b0" / f"{view['id']}-android-a0.png", cell, crop_left=154)
            offline = fitted(output_dir / "previews" / f"{view['id']}-{suffix}.png", cell)
            sheet.paste(android, (20, y + 28))
            sheet.paste(offline, (cell[0] + 40, y + 28))
        path = output_dir / "previews" / f"contact-a0-vs-{suffix}.jpg"
        sheet.save(path, quality=92)
        print(f"Saved {path}")

    from PIL import ImageChops, ImageStat

    cell = (640, 360)
    previous_dir = output_dir / "iterations" / "256-sample-inward-normals"
    review = {"scope": "Auxiliary sRGB metrics on x=36%-96%, y=6%-96% of the 2486x1200 content area; not a visual acceptance decision", "views": []}
    for suffix in ("offline-full-pbr", "baked-static-diagnostic"):
        sheet = Image.new("RGB", (cell[0] * 3 + 80, (cell[1] + 70) * 4 + 60), (16, 22, 30))
        draw = ImageDraw.Draw(sheet)
        draw.text((20, 18), f"B1 remediation | A0 / previous / current | {suffix}", fill=(230, 235, 240))
        for index, view in enumerate(config["camera"]["views"]):
            y = 60 + index * (cell[1] + 70)
            labels = ("Android A0", "previous 256 inward normals", "current remediation")
            paths = (
                output_dir / "b0" / f"{view['id']}-android-a0.png",
                previous_dir / "previews" / f"{view['id']}-{suffix}.png",
                output_dir / "previews" / f"{view['id']}-{suffix}.png",
            )
            images = []
            for column, (label, path) in enumerate(zip(labels, paths)):
                x = 20 + column * (cell[0] + 20)
                draw.text((x, y + 4), f"{view['id']} | {label}", fill=(220, 225, 230))
                image = fitted(path, cell, crop_left=154 if column == 0 else 0)
                sheet.paste(image, (x, y + 28))
                full = Image.open(path).convert("RGB")
                if column == 0:
                    full = full.crop((154, 0, full.width, full.height))
                images.append(full.crop((int(full.width * 0.36), int(full.height * 0.06), int(full.width * 0.96), int(full.height * 0.96))))
            row = {
                "view": view["id"],
                "kind": suffix,
                "a0ToPreviousMae": sum(ImageStat.Stat(ImageChops.difference(images[0], images[1])).mean) / 3,
                "a0ToCurrentMae": sum(ImageStat.Stat(ImageChops.difference(images[0], images[2])).mean) / 3,
                "previousToCurrentMae": sum(ImageStat.Stat(ImageChops.difference(images[1], images[2])).mean) / 3,
                "a0MeanRgb": ImageStat.Stat(images[0]).mean,
                "previousMeanRgb": ImageStat.Stat(images[1]).mean,
                "currentMeanRgb": ImageStat.Stat(images[2]).mean,
            }
            review["views"].append(row)
        path = output_dir / "previews" / f"contact-b1-remediation-{suffix}.jpg"
        sheet.save(path, quality=92)
        print(f"Saved {path}")
    (output_dir / "previews" / "visual-review.json").write_text(json.dumps(review, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
