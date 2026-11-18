"""Dependency-free capture layout shared by upload validation and ingestion.

Scanner archives may place camera/depth data at the root or in images/. RGB
frames may use either directory independently. Indices, not directory names,
identify a frame. Video-only RGB captures retain their existing extraction path.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class CaptureFrame:
    camera: Path
    depth: Path
    image: Path | None


def _matrix(value, size):
    if not isinstance(value, list):
        return False
    if value and isinstance(value[0], list):
        dimension = math.isqrt(size)
        if len(value) != dimension or any(not isinstance(row, list) or len(row) != dimension for row in value):
            return False
        values = [item for row in value for item in row]
    else:
        values = value
    return (len(values) == size and all(isinstance(x, (int, float)) and not isinstance(x, bool)
                                       and math.isfinite(x) for x in values))


def capture_frames(root: Path) -> list[CaptureFrame]:
    root = Path(root)
    if not any((root / name).is_file() for name in ("room.usdz", "roomplan/room.usdz")):
        raise ValueError("扫描包缺少 room.usdz")
    cameras = sorted(root.glob("frame_*.json")) + sorted((root / "images").glob("frame_*.json"))
    if not cameras:
        raise ValueError("扫描包缺少 frame_*.json 相机数据")
    frames, seen = [], set()
    for camera in cameras:
        if camera.stem in seen:
            raise ValueError(f"扫描包存在重复相机帧：{camera.name}")
        seen.add(camera.stem)
        try:
            metadata = json.loads(camera.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict):
                raise ValueError("camera metadata must be an object")
            if not all(_matrix(metadata.get(key), size) for key, size in (
                ("intrinsics", 9), ("cameraPoseARFrame", 16), ("projectionMatrix", 16)
            )):
                raise ValueError("missing or invalid camera matrices")
        except (ValueError, TypeError, UnicodeError) as exc:
            raise ValueError(f"相机数据无法解析：{camera.name}") from exc
        depth_name = camera.stem.replace("frame_", "depth_", 1) + ".png"
        depth = next((folder / depth_name for folder in (camera.parent, root, root / "images")
                      if (folder / depth_name).is_file()), None)
        if depth is None:
            raise ValueError(f"扫描包缺少配对深度数据：{depth_name}")
        image = next((folder / (camera.stem + ".jpg") for folder in (root, root / "images")
                      if (folder / (camera.stem + ".jpg")).is_file()), None)
        if image is None and not (root / "frames.mp4").is_file():
            raise ValueError(f"扫描包缺少图像帧或 frames.mp4：{camera.stem}.jpg")
        frames.append(CaptureFrame(camera, depth, image))
    return frames
