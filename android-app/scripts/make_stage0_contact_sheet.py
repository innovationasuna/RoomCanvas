#!/usr/bin/env python3
from pathlib import Path
from PIL import Image, ImageDraw

from run_stage0_device import EXPERIMENTS, OUTPUT


def main():
    width, height = 660, 300
    label_height = 32
    sheet = Image.new("RGB", (width * 2, (height + label_height) * len(EXPERIMENTS)), "#101820")
    draw = ImageDraw.Draw(sheet)
    for row, experiment in enumerate(EXPERIMENTS):
        y = row * (height + label_height)
        draw.text((12, y + 9), experiment, fill="white")
        for column, name in enumerate(("01-piano.png", "02-entry.png")):
            path = OUTPUT / "visual" / experiment / name
            if not path.is_file():
                continue
            with Image.open(path) as source:
                preview = source.convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
                sheet.paste(preview, (column * width, y + label_height))
    output = OUTPUT / "visual" / "contact-sheet.jpg"
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)
    print(output)


if __name__ == "__main__":
    main()
