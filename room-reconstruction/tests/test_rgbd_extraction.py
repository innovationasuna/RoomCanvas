from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from litereality_agent.pipeline.scene_init.ingest.preprocessing import scanner as ingest_utils


def _frame(image, depth):
    return SimpleNamespace(
        image_path_full=str(image),
        depth_path=str(depth),
        pose=np.eye(4),
        intrinsics=np.eye(3),
    )


def test_rgbd_copy_supports_paths_with_spaces(tmp_path, monkeypatch):
    source = tmp_path / "source files"
    source.mkdir()
    image = source / "source image.jpg"
    depth = source / "source depth.jpg"
    image.write_bytes(b"image")
    depth.write_bytes(b"depth")
    output = tmp_path / "output folder"
    monkeypatch.setattr(
        ingest_utils,
        "load_scan_frames",
        lambda *_args, **_kwargs: [_frame(image, depth)],
    )

    ingest_utils.extract_rgbd("unused", str(output))

    assert (output / "image" / "frame_0.jpg").read_bytes() == b"image"
    assert (output / "depth" / "frame_0.jpg").read_bytes() == b"depth"


def test_rgbd_copy_reports_a_missing_source(tmp_path, monkeypatch):
    image = tmp_path / "missing image.jpg"
    depth = tmp_path / "missing depth.jpg"
    monkeypatch.setattr(
        ingest_utils,
        "load_scan_frames",
        lambda *_args, **_kwargs: [_frame(image, depth)],
    )

    with pytest.raises(FileNotFoundError):
        ingest_utils.extract_rgbd("unused", str(tmp_path / "output"))


def test_raw_scanner_nested_rgb_and_root_camera_pairs_without_confidence(tmp_path):
    from PIL import Image

    capture = tmp_path / "capture"
    images = capture / "images"
    images.mkdir(parents=True)
    (capture / "room.usdz").write_bytes(b"usdz fixture")
    metadata = {"cameraPoseARFrame": np.eye(4).tolist(), "intrinsics": np.eye(3).tolist(),
                "projectionMatrix": np.eye(4).tolist()}
    (capture / "frame_00027.json").write_text(json.dumps(metadata))
    Image.new("RGB", (8, 6), (20, 40, 80)).save(images / "frame_00027.jpg")
    Image.fromarray(np.full((3, 4), 1000, dtype=np.uint16)).save(capture / "depth_00027.png")
    output = tmp_path / "output"
    ingest_utils.extract_rgbd(str(capture), str(output))
    assert (output / "image/frame_0.jpg").read_bytes() == (images / "frame_00027.jpg").read_bytes()
    assert np.load(output / "intrinsic/intrinsic_0.npy")[0, 0] == .5
    assert np.array_equal(np.load(output / "extrinsic/extrinsic_0.npy"), np.diag([1., -1., -1., 1.]))
    assert ingest_utils.load_scan_frames(capture, video_dir=output / "video_frames")[0].conf_path is None


def test_short_or_broken_video_cannot_reuse_a_previous_decoded_frame(tmp_path, monkeypatch):
    capture = tmp_path / "capture"
    capture.mkdir()
    for name in ("room.usdz", "depth_00027.png", "frames.mp4"):
        (capture / name).touch()
    metadata = {"cameraPoseARFrame": np.eye(4).tolist(), "intrinsics": np.eye(3).tolist(),
                "projectionMatrix": np.eye(4).tolist()}
    (capture / "frame_00027.json").write_text(json.dumps(metadata))
    decoded = tmp_path / "decoded"
    decoded.mkdir()
    (decoded / "frame_00027.jpg").write_bytes(b"old")
    monkeypatch.setattr(ingest_utils, "convert_video_to_frames", lambda *_: None)
    with pytest.raises(ValueError, match="matching frames"):
        ingest_utils.load_scan_frames(str(capture), video_dir=decoded)


def test_video_decode_publishes_current_frames_outside_shared_capture(tmp_path, monkeypatch):
    from PIL import Image

    capture = tmp_path / "capture"
    images = capture / "images"
    images.mkdir(parents=True)
    for name in ("room.usdz", "frames.mp4"):
        (capture / name).touch()
    metadata = {"cameraPoseARFrame": np.eye(4).tolist(), "intrinsics": np.eye(3).tolist(),
                "projectionMatrix": np.eye(4).tolist()}
    (images / "frame_00027.json").write_text(json.dumps(metadata))
    Image.fromarray(np.full((3, 4), 1000, dtype=np.uint16)).save(capture / "depth_00027.png")
    Image.new("L", (4, 3), 2).save(capture / "conf_00027.png")
    original = {path.relative_to(capture): path.read_bytes() for path in capture.rglob("*") if path.is_file()}
    decoded = tmp_path / "output" / "video_frames"
    decoded.mkdir(parents=True)
    (decoded / "frame_00027.jpg").write_bytes(b"old")

    def decode(video, destination):
        assert video == capture / "frames.mp4"
        assert Path(destination) != decoded
        Image.new("RGB", (8, 6), (20, 40, 80)).save(Path(destination) / "frame_00027.jpg")

    monkeypatch.setattr(ingest_utils, "convert_video_to_frames", decode)
    frame, = ingest_utils.load_scan_frames(capture, video_dir=decoded, scale_intrinsics_to_depth=True)
    assert Path(frame.image_path_full).read_bytes() != b"old"
    assert frame.intrinsics[0, 0] == .5
    assert frame.conf_path == str(capture / "conf_00027.png")
    assert {path.relative_to(capture): path.read_bytes() for path in capture.rglob("*") if path.is_file()} == original
