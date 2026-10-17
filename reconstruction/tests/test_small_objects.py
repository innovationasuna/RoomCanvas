"""The small-object pass: which items it judges, how answers are read, where rebuilds go."""

from __future__ import annotations

import math

import numpy as np
import pytest

from litereality_agent.pipeline.realism_authoring.small_objects import (
    candidates,
    evidence,
    fit,
    judge,
)


def obj(oid, category, low, high, **extra):
    return {"id": oid, "category": category, "bbox_min": low, "bbox_max": high, **extra}


def room():
    return {"objects": [
        obj("Floor0", "floor", [-2, -2, 0], [2, 2, 0]),
        obj("Wall0", "wall", [-2, 2, 0], [2, 2.1, 2.5]),
        obj("Bed0", "bed", [-1, -1, 0], [1, 1, 0.5], source_glb="Bed0.glb", rests_on="Floor0"),
        obj("Sheet", "textile", [-1, -1, 0.5], [1, 1, 0.51], rests_on="Bed0"),
        obj("Pillow", "pillow", [0, 0, 0.51], [0.5, 0.3, 0.6], rests_on="Sheet"),
        obj("Book0", "book", [1.2, 0, 0], [1.5, 0.3, 0.03], rests_on="Floor0"),
        obj("Book1", "book", [1.2, 0, 0.03], [1.48, 0.29, 0.06], rests_on="Book0"),
        obj("Score", "paper", [1.21, 0, 0.06], [1.49, 0.28, 0.061], rests_on="Book1"),
        obj("Socket", "socket", [0, 2, 0.3], [0.1, 2, 0.4], attached_to="Wall0"),
        obj("Picture", "picture", [-1, 1.95, 1], [0, 2, 1.5], attached_to="Wall0"),
        obj("Shelf", "shelf", [1, 1.7, 1], [1.5, 2, 1.1], placeable_surface=True,
            attached_to="Wall0"),
        obj("Cup", "cup", [1.1, 1.8, 1.1], [1.2, 1.9, 1.2], rests_on="Shelf"),
    ]}


def test_candidates_skip_shell_reconstructed_fixed_and_wall_mounted():
    ids = {item["id"] for item in candidates.find_candidates(room())}
    assert ids == {"Sheet", "Pillow", "Book0", "Cup"}


def test_a_stack_is_one_item_named_after_its_bottom_object():
    items = {item["id"]: item for item in candidates.find_candidates(room())}
    stack = items["Book0"]
    assert stack["members"] == ["Book0", "Book1", "Score"]
    assert stack["category"] == "book" and stack["label"] == "stack of books"
    assert stack["bbox_max"][2] == pytest.approx(0.061)
    assert stack["rests_on"] == "Floor0"
    # A pillow on a sheet covers a small part of it: separate items.
    assert items["Pillow"]["members"] == ["Pillow"]


def test_label_splits_camel_case_and_drops_numbers():
    assert candidates.label("BlueShoppingBag") == "blue shopping bag"
    assert candidates.label("ShelfBook1_0") == "shelf book"


def test_decision_reply_is_read_from_prose_or_fences():
    reply = 'Looking at it...\n```json\n{"decision": "TRELLIS", "reason": "soft", ' \
            '"description": "a blue paper bag"}\n```'
    assert judge.parse_decision(reply) == {"decision": "trellis", "reason": "soft",
                                           "description": "a blue paper bag"}
    with pytest.raises(ValueError):
        judge.parse_decision('{"decision": "keep"}')


def test_prompt_names_the_item_and_the_guidance():
    item = candidates.find_candidates(room())[0]
    text = judge.decide_prompt(item, detected=False)
    assert item["id"] in text and "TRELLIS" in text and "could not confirm" in text


def test_footprint_keeps_a_turned_object_long_and_narrow():
    a = math.radians(30)
    turn = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    points = [[*(turn @ [x, y] + [1, 2]), z] for x in (-0.05, 0.05) for y in (-0.13, 0.13)
              for z in (0, 0.05)]
    print_ = fit.footprint(np.array(points))
    assert print_["long"] == pytest.approx(0.26, abs=1e-4)
    assert print_["short"] == pytest.approx(0.10, abs=1e-4)
    assert print_["centre"] == pytest.approx([1, 2], abs=1e-6)


def test_placement_aligns_the_long_side_and_faces_the_camera():
    target = {"centre": [0, 0], "angle": 0.0, "long": 0.3, "short": 0.1, "z": [0, 0.05]}
    # The asset is long along its Y axis: it must turn a quarter so Y lies along world X.
    pose = fit.placement(target, (0.1, 0.3, 0.05), camera_xy=(0, -5))
    assert pose["mismatch"] == pytest.approx(0, abs=1e-6)
    assert math.cos(pose["yaw"]) == pytest.approx(0, abs=1e-6)
    assert pose["scale"] == pytest.approx([1, 1, 1])
    # A square footprint: the front (-Y) turns toward the camera.
    square = {**target, "long": 0.2, "short": 0.2}
    pose = fit.placement(square, (0.2, 0.2, 0.05), camera_xy=(5, 0))
    assert math.sin(pose["yaw"]) == pytest.approx(1, abs=1e-6)


def test_placement_limits_stretching():
    target = {"centre": [0, 0], "angle": 0.0, "long": 1.0, "short": 0.1, "z": [0, 0.1]}
    pose = fit.placement(target, (0.3, 0.3, 0.3))
    low, high = min(pose["scale"]), max(pose["scale"])
    assert high / low <= fit.MAX_STRETCH ** 2 + 1e-9


def test_a_slab_shaped_old_model_does_not_flatten_the_new_mesh():
    # The old bag was a thin slab; the rebuilt bag is boxy and keeps most of its depth.
    target = {"centre": [0, 0], "angle": 0.0, "long": 0.23, "short": 0.13, "z": [0, 0.37]}
    pose = fit.placement(target, (0.3, 0.2, 0.35))
    sx, sy, sz = pose["scale"]
    assert sy * 0.2 > 0.13 * 1.15  # deeper than the slab
    assert sz * 0.35 == pytest.approx(0.37, rel=0.25)


def test_crop_keeps_a_minimum_size_inside_the_frame():
    assert evidence.crop_rect([100, 100, 110, 110], 1920, 1440) == [9, 9, 201, 201]
    x0, y0, x1, y1 = evidence.crop_rect([5, 5, 15, 15], 1920, 1440)
    assert (x0, y0) == (0, 0) and x1 <= 1920


def test_detection_far_from_the_projection_is_another_object():
    class Det:
        def __init__(self, box, score):
            self.box_xyxy, self.score = box, score

    box = [100, 100, 200, 200]
    near, far = Det([110, 105, 205, 210], 0.4), Det([1500, 900, 1600, 1000], 0.9)
    assert evidence.choose_detection([far, near], box)[1] is near
    assert evidence.choose_detection([far], box) is None


def test_projection_and_upright_turns():
    camera = {"position": [0, 0, 0], "forward": [0, 1, 0], "up": [0, 0, 1],
              "intrinsics": {"fx": 100, "fy": 100, "cx": 50, "cy": 50}, "resolution": [100, 100]}
    uv = evidence.project(camera, np.array([[0, 2, 0], [0, 2, 1]]))
    assert uv[0] == pytest.approx([50, 50]) and uv[1][1] < 50
    assert evidence.upright_turns(camera, [-0.1, 1.9, -0.1], [0.1, 2.1, 0.1]) == 0
    sideways = {**camera, "up": [1, 0, 0]}  # phone held on its side
    assert evidence.upright_turns(sideways, [-0.1, 1.9, -0.1], [0.1, 2.1, 0.1]) in (1, 3)


def test_dominant_hue_ignores_grey_and_reads_magenta_vs_red():
    from litereality_agent.pipeline.realism_authoring.small_objects.rebuild import dominant_hue

    magenta = np.array([[187, 24, 84]] * 50 + [[200, 200, 200]] * 50)
    hue, share, agreement = dominant_hue(magenta)
    assert 330 < hue < 345 and share == pytest.approx(0.5) and agreement == pytest.approx(1)
    assert dominant_hue(np.array([[200, 200, 200]] * 10))[0] is None
    spines = np.array([[220, 200, 30]] * 30 + [[40, 150, 60]] * 30 + [[30, 140, 150]] * 30)
    assert dominant_hue(spines)[2] < 0.85  # yellow, green and teal books do not agree


def test_material_correction_turns_a_drifted_texture_back_and_zeroes_metal(tmp_path):
    trimesh = pytest.importorskip("trimesh")
    from PIL import Image

    from litereality_agent.pipeline.realism_authoring.small_objects.rebuild import (
        correct_material,
        dominant_hue,
    )

    def textured(path):
        quad = trimesh.Trimesh([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [[0, 1, 2], [0, 2, 3]],
                               process=False)
        material = trimesh.visual.material.PBRMaterial(
            baseColorTexture=Image.new("RGB", (16, 16), (156, 13, 32)),  # TRELLIS's red
            metallicRoughnessTexture=Image.new("RGB", (16, 16), (0, 255, 120)), metallicFactor=1.0)
        quad.visual = trimesh.visual.TextureVisuals(uv=[[0, 0], [1, 0], [1, 1], [0, 1]],
                                                    material=material)
        quad.export(path)

    textured(tmp_path / "bag.glb")
    Image.new("RGB", (16, 16), (187, 24, 84)).save(tmp_path / "ref.png")  # the magenta reference
    report = correct_material(tmp_path / "bag.glb", tmp_path / "ref.png", "bag", tmp_path / "out.glb")
    assert report["hue_corrected"] and report["metallic_zeroed"]
    mesh = next(iter(trimesh.load(tmp_path / "out.glb", process=False).geometry.values()))
    hue = dominant_hue(np.asarray(mesh.visual.material.baseColorTexture.convert("RGB")).reshape(-1, 3))[0]
    assert abs((hue - report["reference_hue"] + 180) % 360 - 180) < 3
    assert np.asarray(mesh.visual.material.metallicRoughnessTexture)[..., 2].max() == 0

    fan = correct_material(tmp_path / "bag.glb", tmp_path / "ref.png", "fan", tmp_path / "fan.glb")
    assert not fan["metallic_zeroed"]

    # A many-coloured reference (a pile of books) is never turned.
    books = Image.new("RGB", (30, 10))
    for x, colour in ((0, (220, 200, 30)), (10, (40, 150, 60)), (20, (30, 140, 150))):
        books.paste(colour, (x, 0, x + 10, 10))
    books.save(tmp_path / "books.png")
    pile = correct_material(tmp_path / "bag.glb", tmp_path / "books.png", "book", tmp_path / "pile.glb")
    assert pile["reference_hue"] is None and not pile.get("hue_corrected")
