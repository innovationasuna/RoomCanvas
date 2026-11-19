"""Photo evidence for one item: the capture frames that see it, crops turned upright, and
side-by-side photo / render pairs for Astra.

Frames are ranked by how large and central the item's box projects; Grounding DINO then looks
for the item near that projection, which skips frames where it is hidden or the box is off.
When the detector finds nothing, the projected boxes are used and the evidence says so.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

MAX_VIEWS = 4  # crops kept per item (one primary + three supporting views)
RANKED = 8  # frames the detector looks at per item
MIN_CROP = 192  # pixels; a tiny object keeps enough of its surroundings to be recognised
MIN_SHARE = 0.4  # at least this much of the object must be in the frame


def corners(low, high) -> np.ndarray:
    return np.array([[(high if (n >> k) & 1 else low)[k] for k in range(3)] for n in range(8)])


def project(camera: dict, points: np.ndarray):
    """Pixel coordinates of world points in a capture frame, or None if any lies behind it."""
    forward, up = np.array(camera["forward"]), np.array(camera["up"])
    right = np.cross(forward, up)
    d = points - np.array(camera["position"])
    z = d @ forward
    if (z <= 0.05).any():
        return None
    k = camera["intrinsics"]
    return np.stack([k["cx"] + k["fx"] * (d @ right) / z, k["cy"] - k["fy"] * (d @ up) / z], 1)


def projected_box(camera: dict, low, high):
    """Image box of a world box, or None if any corner lies behind the camera."""
    uv = project(camera, corners(low, high))
    if uv is None:
        return None
    return [float(v) for v in (*uv.min(0), *uv.max(0))]


def visible_box(camera: dict, low, high, steps: int = 6):
    """Share of the box inside the frame, and the image box of that part. Sampled on a grid, so
    a big object (a bed sheet) seen partly, or partly behind the camera, still counts."""
    axes = [np.linspace(lo, hi, steps) for lo, hi in zip(low, high)]
    points = np.stack(np.meshgrid(*axes, indexing="ij"), -1).reshape(-1, 3)
    forward, up = np.array(camera["forward"]), np.array(camera["up"])
    d = points - np.array(camera["position"])
    z = d @ forward
    front = z > 0.1
    k = camera["intrinsics"]
    u = k["cx"] + k["fx"] * (d @ np.cross(forward, up))[front] / z[front]
    v = k["cy"] - k["fy"] * (d @ up)[front] / z[front]
    width, height = camera["resolution"]
    inside = (u >= 0) & (u <= width) & (v >= 0) & (v <= height)
    if not inside.any():
        return 0.0, None
    u, v = u[inside], v[inside]
    return inside.sum() / len(points), [float(u.min()), float(v.min()), float(u.max()),
                                        float(v.max())]


def rank_frames(cameras: list[dict], low, high) -> list[tuple[float, dict, list[float]]]:
    """Frames that see most of the box, best first: visible area times centrality."""
    ranked = []
    for camera in cameras:
        share, box = visible_box(camera, low, high)
        if share < MIN_SHARE:
            continue
        width, height = camera["resolution"]
        x0, y0, x1, y1 = box
        size = (x1 - x0) * (y1 - y0) / (width * height)
        if size > 0.8:  # standing right at it
            continue
        off = math.hypot((x0 + x1) / 2 / width - 0.5, (y0 + y1) / 2 / height - 0.5)
        ranked.append((float(math.sqrt(size) * (1 - off) * share), camera, box))
    ranked.sort(key=lambda row: -row[0])
    return ranked


def upright_turns(camera: dict, low, high) -> int:
    """Quarter turns (counter-clockwise, PIL rotate) that put world-up at the top of the crop."""
    centre = (np.array(low) + np.array(high)) / 2
    uv = project(camera, np.array([centre, centre + [0, 0, 0.3]]))
    if uv is None:
        return 0
    up = uv[1] - uv[0]
    angle = math.degrees(math.atan2(up[0], -up[1]))  # 0 when up already points to the image top
    return int(round(angle / 90)) % 4


def crop_rect(box, width: int, height: int, margin: float = 0.15) -> list[int]:
    x0, y0, x1, y1 = box
    pad = margin * max(x1 - x0, y1 - y0)
    x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
    for lo, hi, limit in ((0, 2, width), (1, 3, height)):
        values = [x0, y0, x1, y1]
        short = MIN_CROP - (values[hi] - values[lo])
        if short > 0:
            values[lo] -= short / 2
            values[hi] += short / 2
        x0, y0, x1, y1 = values
    return [int(max(0, x0)), int(max(0, y0)), int(min(width, x1)), int(min(height, y1))]


def choose_detection(detections, box, min_score: float = 0.3):
    """The detection closest to the projected box; a far one is another object of that kind."""
    centre = np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2])
    diag = math.hypot(box[2] - box[0], box[3] - box[1])
    best = None
    for det in detections:
        if det.score < min_score:
            continue
        b = det.box_xyxy
        distance = math.hypot((b[0] + b[2]) / 2 - centre[0], (b[1] + b[3]) / 2 - centre[1])
        if distance > 1.5 * diag + 150:
            continue
        rank = det.score - 0.3 * distance / (diag + 1e-6)
        if best is None or rank > best[0]:
            best = (rank, det)
    return best


def sharpness(image: Image.Image) -> float:
    """Variance of the Laplacian on a fixed-size grey copy; motion blur drives it toward 0."""
    grey = np.asarray(image.convert("L").resize((256, 256)), dtype=np.float32)
    lap = (grey[1:-1, :-2] + grey[1:-1, 2:] + grey[:-2, 1:-1] + grey[2:, 1:-1]
           - 4 * grey[1:-1, 1:-1])
    return float(lap.var())


def collect_views(item: dict, cameras: list[dict], frames: Path, out: Path, detector=None):
    """Write upright crops for one item; return their metadata, best first.

    Detected views come before projection-only ones; among them a sharp photo beats a blurred
    one (blurred evidence is what made TRELLIS invent unrelated objects in our tests)."""
    out.mkdir(parents=True, exist_ok=True)
    low, high = item["bbox_min"], item["bbox_max"]
    ranked = rank_frames(cameras, low, high)[:RANKED]
    found = []
    for order, (score, camera, box) in enumerate(ranked):
        detection = None
        if detector is not None:
            hits = detector.detect(str(frames / camera["image"]), f"{item['label']} .")
            detection = choose_detection(hits, box)
        if detection is not None:
            found.append([1.0 + detection[0], camera, list(detection[1].box_xyxy), True])
        elif detector is None or order < 3:
            found.append([score - 1.0, camera, box, False])  # projection only: lower priority
    crops = []
    for row in found:
        camera, box = row[1], row[2]
        width, height = camera["resolution"]
        rect = crop_rect(box, width, height)
        turns = upright_turns(camera, low, high)
        with Image.open(frames / camera["image"]) as frame:
            crop = frame.convert("RGB").crop(rect).rotate(90 * turns, expand=True)
        crops.append((row, rect, turns, crop, sharpness(crop)))
    best_sharp = max([c[4] for c in crops] or [1.0]) or 1.0
    crops.sort(key=lambda c: -(c[0][0] + 0.5 * c[4] / best_sharp))
    views = []
    for (_, camera, box, detected), rect, turns, crop, sharp in crops[:MAX_VIEWS]:
        name = f"view{len(views)}.jpg"
        crop.save(out / name, quality=92)
        views.append({"image": str(out / name), "frame": camera["frame_index"],
                      "frame_image": camera["image"], "rect": rect, "turns": turns,
                      "box": [round(v) for v in box], "detected": detected,
                      "sharpness": round(sharp / best_sharp, 2)})
    return views


def context_image(frame_path: Path, rect, turns: int, out: Path, long_side: int = 1024) -> Path:
    """The whole primary frame, upright and downscaled, with the item's crop outlined."""
    with Image.open(frame_path) as frame:
        image = frame.convert("RGB")
    ImageDraw.Draw(image).rectangle(rect, outline=(255, 40, 40), width=8)
    image = image.rotate(90 * turns, expand=True)
    image.thumbnail((long_side, long_side), Image.Resampling.LANCZOS)
    image.save(out, quality=90)
    return out


def _font(size: int):
    for name in ("DejaVuSans.ttf", "Arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def pair_image(photo: Path, render: Path, view: dict, out: Path, scale: float,
               labels=("PHOTO", "CURRENT MODEL (render, same camera)"), height: int = 512) -> Path:
    """Photo crop beside the same crop of a render from that camera (render may be downscaled)."""
    rect = view["rect"]
    with Image.open(photo) as image:
        left = image.convert("RGB").crop(rect)
    with Image.open(render) as image:
        right = image.convert("RGB").crop([round(v * scale) for v in rect])
    tiles = []
    for tile, text in zip((left, right), labels):
        tile = tile.rotate(90 * view["turns"], expand=True)
        tile = tile.resize((max(1, round(tile.width * height / tile.height)), height))
        canvas = Image.new("RGB", (tile.width, height + 40), (20, 20, 20))
        canvas.paste(tile, (0, 40))
        ImageDraw.Draw(canvas).text((10, 8), text, fill=(255, 255, 255), font=_font(24))
        tiles.append(canvas)
    sheet = Image.new("RGB", (sum(t.width for t in tiles) + 12, height + 40), (60, 60, 60))
    sheet.paste(tiles[0], (0, 0))
    sheet.paste(tiles[1], (tiles[0].width + 12, 0))
    sheet.save(out, quality=90)
    return out


def generator_inputs(views: list[dict], out: Path) -> list[dict]:
    """Crops in the frames' landscape orientation, as `make_weighted_input_sheet` expects.

    That function turns every tile a quarter clockwise (capture frames are portrait photos
    stored on their side). Our crops are already upright, so hand it each crop turned a
    quarter counter-clockwise; it then lands upright on the sheet.
    """
    out.mkdir(parents=True, exist_ok=True)
    items = []
    for n, view in enumerate(views):
        path = out / f"sheet_tile{n}.jpg"
        with Image.open(view["image"]) as crop:
            crop.convert("RGB").transpose(Image.Transpose.ROTATE_90).save(path, quality=95)
        items.append({"image": str(path)})
    return items


def photo_inputs(photos: list[Path], out: Path, long_side: int = 2048) -> list[dict]:
    """The operator's close-ups as sheet tiles, oriented like `generator_inputs`' crops.

    A phone photo is upright once its EXIF orientation is applied; from there it takes the same
    quarter turn counter-clockwise as an upright crop, so the sheet turns it upright again.
    """
    if not photos:
        return []
    out.mkdir(parents=True, exist_ok=True)
    items = []
    for n, photo in enumerate(photos):
        path = out / f"photo_tile{n}.jpg"
        with Image.open(photo) as image:
            tile = ImageOps.exif_transpose(image).convert("RGB")
        tile.thumbnail((long_side, long_side), Image.Resampling.LANCZOS)
        tile.transpose(Image.Transpose.ROTATE_90).save(path, quality=95)
        items.append({"image": str(path)})
    return items
