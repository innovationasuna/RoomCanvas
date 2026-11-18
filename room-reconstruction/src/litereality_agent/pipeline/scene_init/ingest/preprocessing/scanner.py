"""Project capture contract adapted to the RGBD files consumed by preprocessing.

The vendored camera loader expects one flat scanner layout and mandatory confidence
images. Keep those upstream assumptions there; the project's supported layouts and
optional confidence policy live here, without mutating a shared source capture.
"""
from __future__ import annotations

import json
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image

from litereality_agent.capture import capture_frames


@dataclass(frozen=True)
class RGBDFrame:
    image_path_full: str
    depth_path: str
    pose: np.ndarray
    intrinsics: np.ndarray
    conf_path: str | None


def convert_video_to_frames(video_path, output_path):
    # Video decoding remains an upstream operation. Image-only ingestion does not
    # need to import its OpenCV/Open3D dependencies.
    from .vendor.litereality.scanner_capture import convert_video_to_frames as decode

    decode(str(video_path), str(output_path))


def load_scan_frames(data_path, *, video_dir, scale_intrinsics_to_depth=False):
    root, video_dir = Path(data_path), Path(video_dir)
    frames = capture_frames(root)
    if any(frame.image is None for frame in frames):
        video_dir.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=video_dir.parent, prefix=".video-") as temporary:
            convert_video_to_frames(root / "frames.mp4", temporary)
            required = [frame.camera.stem + ".jpg" for frame in frames if frame.image is None]
            missing = [name for name in required if not (Path(temporary) / name).is_file()]
            if missing:
                raise ValueError(f"video does not contain matching frames: {', '.join(missing[:5])}")
            video_dir.mkdir(exist_ok=True)
            for name in required:
                (Path(temporary) / name).replace(video_dir / name)
    images = [frame.image or video_dir / (frame.camera.stem + ".jpg") for frame in frames]
    with Image.open(images[0]) as image:
        width, height = image.size
    with Image.open(frames[0].depth) as depth:
        depth_width, depth_height = depth.size
    sx, sy = (depth_width / width, depth_height / height) if scale_intrinsics_to_depth else (1., 1.)
    cameras = []
    for frame, image in zip(frames, images):
        if not image.is_file():
            raise ValueError(f"video does not contain matching frame: {frame.camera.name}")
        metadata = json.loads(frame.camera.read_text(encoding="utf-8"))
        pose = np.asarray(metadata["cameraPoseARFrame"], dtype=float).reshape(4, 4).copy()
        pose[:3, 1:3] *= -1
        intrinsics = np.asarray(metadata["intrinsics"], dtype=float).reshape(3, 3).copy()
        intrinsics[0, (0, 2)] *= sx
        intrinsics[1, (1, 2)] *= sy
        confidence = frame.depth.with_name(frame.depth.name.replace("depth_", "conf_", 1))
        cameras.append(RGBDFrame(str(image), str(frame.depth), pose, intrinsics,
                                 str(confidence) if confidence.is_file() else None))
    return cameras


def extract_rgbd(scan_path, folder):
    folder = Path(folder)
    frames = load_scan_frames(scan_path, video_dir=folder / "video_frames", scale_intrinsics_to_depth=True)
    for name in ("image", "depth", "intrinsic", "extrinsic"):
        (folder / name).mkdir(parents=True, exist_ok=True)
    for index, frame in enumerate(frames):
        np.save(folder / "intrinsic" / f"intrinsic_{index}.npy", frame.intrinsics)
        np.save(folder / "extrinsic" / f"extrinsic_{index}.npy", frame.pose)
        shutil.copyfile(frame.image_path_full, folder / "image" / f"frame_{index}.jpg")
        shutil.copyfile(frame.depth_path, folder / "depth" / f"frame_{index}.jpg")
