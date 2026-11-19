
import json

import pytest

from litereality_agent.capture import capture_frames

CAMERA = json.dumps({"intrinsics": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                     "cameraPoseARFrame": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                     "projectionMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]})

@pytest.mark.parametrize("camera_dir,image_dir", [("", ""), ("images", ""), ("", "images"), ("images", "images")])
def test_scanner_layouts_use_matching_indices(tmp_path, camera_dir, image_dir):
    (tmp_path / "roomplan").mkdir()
    (tmp_path / "roomplan/room.usdz").touch()
    for name in (camera_dir, image_dir):
        (tmp_path / name).mkdir(exist_ok=True)
    camera = tmp_path / camera_dir / "frame_00027.json"
    camera.write_text(CAMERA)
    depth = tmp_path / "depth_00027.png"
    depth.touch()
    image = tmp_path / image_dir / "frame_00027.jpg"
    image.touch()
    frame, = capture_frames(tmp_path)
    assert (frame.camera, frame.depth, frame.image) == (camera, depth, image)
    image.rename(image.with_name("frame_00028.jpg"))
    with pytest.raises(ValueError, match="frame_00027.jpg"):
        capture_frames(tmp_path)


def test_video_and_invalid_camera(tmp_path):
    for name in ("room.usdz", "depth_1.png", "frames.mp4"):
        (tmp_path / name).touch()
    (tmp_path / "frame_1.json").write_text(CAMERA)
    assert capture_frames(tmp_path)[0].image is None
    (tmp_path / "frame_1.json").write_text("{")
    with pytest.raises(ValueError, match="无法解析"):
        capture_frames(tmp_path)


def test_ragged_matrix_is_rejected_even_when_flattened_length_matches(tmp_path):
    for name in ("room.usdz", "depth_1.png", "frame_1.jpg"):
        (tmp_path / name).touch()
    data = json.loads(CAMERA)
    data["intrinsics"] = [[1, 0], [0, 1, 0], [0, 0, 0, 1]]
    (tmp_path / "frame_1.json").write_text(json.dumps(data))
    with pytest.raises(ValueError, match="无法解析"):
        capture_frames(tmp_path)
