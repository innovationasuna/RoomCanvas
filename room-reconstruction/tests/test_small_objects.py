"""The small-object pass: which items it judges, how answers are read, where rebuilds go."""

from __future__ import annotations

import json
import math
import threading
from pathlib import Path

import numpy as np
import pytest

from litereality_agent.pipeline.realism_authoring.small_objects import (
    candidates,
    evidence,
    fit,
    judge,
)
from litereality_agent.pipeline.realism_authoring.small_objects.run import Pass


@pytest.fixture
def small_objects(tmp_path):
    paths = {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring"}
    (tmp_path / "scene.json").write_text(json.dumps({"paths": paths}))
    (tmp_path / "preview").mkdir()
    (tmp_path / "preview" / "room_layout.json").write_text('{"cameras": []}')
    return Pass(tmp_path)


def test_parallel_references_checkpoint_each_finished_item_and_retry_failed(small_objects, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    run = small_objects
    ids = ["Book", "Cup", "Bag"]
    run.items = [{"id": name, "views": [], "decision": {"decision": "trellis", "description": ""},
                  "reference_error": "prior error"} for name in ids]
    barrier = threading.Barrier(len(ids))

    def make_reference(item, tiles, description, folder):
        barrier.wait(timeout=5)
        if item["id"] == "Cup":
            raise ValueError("no reference")
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "reference.png").write_bytes(b"reference")
        return {"cost_usd": 0.25}

    monkeypatch.setattr(evidence, "generator_inputs", lambda *args: [])
    monkeypatch.setattr(rebuild, "make_reference", make_reference)
    monkeypatch.setattr(rebuild, "run_trellis", lambda *args: {})
    snapshots = []
    coordinator = threading.get_ident()
    save = run.save

    def checkpoint():
        assert threading.get_ident() == coordinator
        save()
        snapshots.append(json.loads(run.state_path.read_text()))

    monkeypatch.setattr(run, "save", checkpoint)
    run.rebuild()
    for completed, snapshot in enumerate(snapshots[:len(ids)], 1):
        assert sum(item.get("reference_error") != "prior error" for item in snapshot) == completed
    resumed = Pass(run.scene_dir)
    book, cup, bag = resumed.items
    for item in (book, bag):
        assert item["reference"].endswith(f"/{item['id']}/reference.png")
        assert item["image_cost_usd"] == 0.25
        assert "reference_error" not in item
    assert cup["reference_error"] == "ValueError: no reference"

    retried = []
    monkeypatch.setattr(rebuild, "make_reference", lambda item, *args: retried.append(item["id"]))
    resumed.rebuild()
    assert retried == ["Cup"]
    assert all("reference" in item and "reference_error" not in item
               for item in json.loads(run.state_path.read_text()))


def test_failed_checkpoint_keeps_previous_state_and_cleans_temporary_file(small_objects):
    run = small_objects
    run.items = [{"id": "Book"}]
    run.save()
    previous_files = set(run.out.iterdir())
    run.items.append({"bad": object()})
    with pytest.raises(TypeError):
        run.save()
    assert Pass(run.scene_dir).items == [{"id": "Book"}]
    assert set(run.out.iterdir()) == previous_files


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


def test_only_an_evenly_scaled_parent_keeps_a_turned_child_as_it_is():
    def turned(angle, scale):
        c, s = math.cos(angle), math.sin(angle)
        matrix = np.eye(4)
        matrix[:3, :3] = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]) * scale
        matrix[:3, 3] = [1.5, -2.0, 0.7]
        return matrix

    assert fit.keeps_shape(turned(0.3, 1))
    assert fit.keeps_shape(turned(0.3, 0.87))  # scaled evenly: still right angles
    tabletop = turned(0.3, [1.095, 1.247, 0.623])  # the author's stretched table part
    assert not fit.keeps_shape(tabletop)
    # What goes wrong there: a child turned on it has axes that are no longer at right angles.
    axes = (tabletop @ turned(0.15, 1))[:3, :3]
    assert abs(axes[:, 0] @ axes[:, 1]) > 0.03
    assert not fit.keeps_shape(np.zeros((4, 4)))
    # An empty scaled by the inverse of the part's own stretch stands level again on it, so the
    # child can stay under the part its support_part names (and move with it).
    lengths = fit.stretch(tabletop)
    assert np.allclose(lengths, [1.095, 1.247, 0.623])
    assert fit.keeps_shape(tabletop @ np.diag([*(1 / v for v in lengths), 1]))
    assert fit.stretch(tabletop @ turned(0.15, [1, 2, 1])) is None  # skewed axes: cannot be undone
    assert fit.stretch(np.zeros((4, 4))) is None


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


# ── operator steering: policy, forced decisions, close-up photos, trace records ──────────


def test_policy_and_photos_change_the_question_only_when_set():
    item = candidates.find_candidates(room())[0]
    default = judge.decide_prompt(item, detected=True)
    steered = judge.decide_prompt(item, True, photos=2, policy="trellis-first", describe=True)
    assert judge.GUIDANCE in default and "policy" not in default and "operator" not in default
    assert "otherwise empty" in default and "IMAGE 1" in default
    assert judge.GUIDANCE in steered and judge.TRELLIS_FIRST in steered
    assert "always, whatever you decide" in steered and "otherwise empty" not in steered
    assert "The last 2 image(s) are close-up photos the operator took" in steered
    only_photos = judge.decide_prompt({**item, "views": []}, False, photos=1)
    assert "IMAGE 1" not in only_photos and "No capture frame shows the object." in only_photos


def test_forced_decisions_are_validated():
    assert judge.parse_force("") == {}
    assert judge.parse_force(" Cup=TRELLIS, Pillow=drop ,Sheet=procedural") == {
        "Cup": "trellis", "Pillow": "drop", "Sheet": "procedural"}
    for bad in ("Cup=keep", "Cup", "=drop"):
        with pytest.raises(ValueError, match="LR_SMALL_OBJECTS_FORCE"):
            judge.parse_force(bad)


@pytest.fixture
def scene(tmp_path):
    paths = {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring"}
    (tmp_path / "scene.json").write_text(json.dumps({"paths": paths}))
    (tmp_path / "preview").mkdir()
    layout = {**room(), "cameras": [{"frame_index": 1, "position": [0, 0, 1.5]}]}
    (tmp_path / "preview" / "room_layout.json").write_text(json.dumps(layout))
    for name in ("Room.blend", "Room.glb"):
        (tmp_path / "preview" / name).write_bytes(b"room")
    return tmp_path


def seen(run, *ids):
    """Give these items one detected capture view, as gather_evidence would."""
    for item in run.items:
        if item["id"] in ids:
            item["views"] = [{"image": str(run.out / "evidence" / item["id"] / "view0.jpg"),
                              "frame": 1, "detected": True}]
        else:
            item.setdefault("views", [])


def answer(run, monkeypatch, decisions, asked=None):
    async def ask_all(jobs):
        for item, key, images, prompt, _parse in jobs:
            if asked is not None:
                asked[item["id"]] = (images, prompt)
            item[key] = {"decision": decisions[item["id"]], "reason": "", "description": "a thing"}

    monkeypatch.setattr(run, "_ask_all", ask_all)


def test_unknown_policy_or_forced_item_is_refused(scene, monkeypatch):
    monkeypatch.setenv("LR_SMALL_OBJECTS_POLICY", "trellis-always")
    with pytest.raises(ValueError, match="LR_SMALL_OBJECTS_POLICY"):
        Pass(scene)
    monkeypatch.delenv("LR_SMALL_OBJECTS_POLICY")
    monkeypatch.setenv("LR_SMALL_OBJECTS_FORCE", "Mug9=trellis")
    with pytest.raises(ValueError, match="Mug9"):
        Pass(scene).find()


def test_a_forced_decision_overrides_astra_until_it_is_lifted(scene, monkeypatch):
    monkeypatch.setenv("LR_SMALL_OBJECTS_FORCE", "Cup=trellis,Pillow=drop,Book0=trellis")
    run = Pass(scene)
    run.find()
    seen(run, "Cup", "Pillow", "Sheet")
    asked = {}
    answer(run, monkeypatch, {"Cup": "drop", "Pillow": "trellis", "Sheet": "procedural"}, asked)
    run.decide()
    decisions = {i["id"]: i["decision"] for i in run.items}
    assert decisions["Cup"]["decision"] == "trellis" and decisions["Cup"]["judged"] == "drop"
    assert decisions["Cup"]["forced"] and decisions["Cup"]["description"] == "a thing"
    assert decisions["Pillow"]["decision"] == "drop"
    assert decisions["Sheet"] == {"decision": "procedural", "reason": "", "description": "a thing"}
    # Nothing shows Book0, so there is nothing to rebuild it from: the force is not applied.
    assert decisions["Book0"]["decision"] == "drop" and "forced" not in decisions["Book0"]
    # A forced item is asked for its description whatever Astra decides; the others as before.
    assert "always, whatever you decide" in asked["Cup"][1]
    assert "otherwise empty" in asked["Sheet"][1]

    monkeypatch.delenv("LR_SMALL_OBJECTS_FORCE")
    lifted = Pass(scene)
    lifted.find()
    answer(lifted, monkeypatch, {})  # nothing is asked again
    lifted.decide()
    decisions = {i["id"]: i["decision"]["decision"] for i in lifted.items}
    assert decisions == {"Cup": "drop", "Pillow": "trellis", "Sheet": "procedural", "Book0": "drop"}


def photo(path, size=(60, 80)):
    """An upright photo, red above and blue below."""
    from PIL import Image

    path.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", size, "blue")
    image.paste("red", (0, 0, size[0], size[1] // 2))
    image.save(path, quality=95)
    return path


def test_operator_photos_are_evidence_for_their_item_only(scene, monkeypatch, tmp_path):
    photos = tmp_path / "close-ups"
    photo(photos / "Cup" / "b.jpg")
    photo(photos / "Cup" / "a.JPG")
    photo(photos / "Book0" / "pile.jpeg")
    (photos / "Cup" / "notes.txt").write_text("not a photo")
    photo(photos / "Mug9" / "x.jpg")  # names no candidate: ignored with a note
    monkeypatch.setenv("LR_SMALL_OBJECTS_PHOTOS", str(photos))
    run = Pass(scene)
    run.find()
    seen(run, "Cup", "Sheet")
    asked = {}
    answer(run, monkeypatch, {"Cup": "trellis", "Sheet": "drop", "Book0": "trellis", "Pillow": "drop"}, asked)
    run.decide()
    images, prompt = asked["Cup"]
    assert [p.name for p in images[-2:]] == ["a.JPG", "b.jpg"] and "The last 2 image(s)" in prompt
    assert "operator" not in asked["Sheet"][1]
    # Seen in no capture frame, but photographed: judged from the photos instead of dropped.
    images, prompt = asked["Book0"]
    assert [p.name for p in images] == ["pile.jpeg"] and "No capture frame shows" in prompt
    assert "Pillow" not in asked  # neither seen nor photographed
    run.listing()
    table = (run.out / "candidates.md").read_text()
    assert "| Book0 | Book0, Book1, Score | book |" in table and "| 2 |" in table


def test_new_photos_rebuild_only_their_item(scene, monkeypatch, tmp_path):
    from litereality_agent import artifact_cache as cache

    photos = tmp_path / "close-ups"
    photo(photos / "Cup" / "a.jpg")
    monkeypatch.setenv("LR_SMALL_OBJECTS_PHOTOS", str(photos))
    run = Pass(scene)
    run.find()
    cup = next(i for i in run.items if i["id"] == "Cup")
    assert cup["inputs"] and all("inputs" not in i for i in run.items if i["id"] != "Cup")
    for item in run.items:  # judged and rebuilt
        item.update(views=[], decision={"decision": "trellis", "description": ""},
                    reference="ref.png", glb="model.glb", material={})
        (run.out / "rebuild" / item["id"]).mkdir(parents=True)
    (run.out / "rebuild" / "_trellis" / "glb").mkdir(parents=True)
    (run.out / "rebuild" / "_trellis" / "glb" / "Cup.glb").write_bytes(b"mesh")
    run.save()
    key = cache.read_json(run.out / "dependencies.json")["key"]

    again = Pass(scene)
    again.find()
    assert again.items == run.items  # same photos: nothing to redo

    photo(photos / "Cup" / "b.jpg")
    later = Pass(scene)
    later.find()
    cup = next(i for i in later.items if i["id"] == "Cup")
    assert not {"decision", "reference", "glb", "material"} & set(cup) and cup["views"] == []
    assert all(i["glb"] == "model.glb" for i in later.items if i["id"] != "Cup")
    assert not (later.out / "rebuild" / "Cup").exists()
    assert not (later.out / "rebuild" / "_trellis" / "glb" / "Cup.glb").exists()
    assert (later.out / "rebuild" / "Sheet").is_dir()
    assert cache.read_json(later.out / "dependencies.json")["key"] == key  # the pass was not retired


def test_photos_lead_the_reference_sheet_and_end_up_upright(scene, monkeypatch, tmp_path):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild
    from litereality_agent.pipeline.scene_init.ingest.references.object_references import (
        oriented_image,
    )

    photo(tmp_path / "close-ups" / "Cup" / "a.jpg")
    monkeypatch.setenv("LR_SMALL_OBJECTS_PHOTOS", str(tmp_path / "close-ups"))
    run = Pass(scene)
    run.find()
    seen(run, "Cup")
    for item in run.items:
        item["decision"] = {"decision": "trellis" if item["id"] == "Cup" else "drop", "description": ""}
    sheets = {}
    monkeypatch.setattr(evidence, "generator_inputs", lambda views, out: [{"image": "crop0.jpg"}])
    monkeypatch.setattr(rebuild, "make_reference", lambda item, tiles, *_: sheets.setdefault(item["id"], tiles))
    monkeypatch.setattr(rebuild, "run_trellis", lambda *args: {})
    run.rebuild()
    tiles = sheets["Cup"]
    assert tiles[0]["image"].endswith("photo_tile0.jpg") and tiles[-1] == {"image": "crop0.jpg"}
    # The sheet turns every tile a quarter clockwise, as it does the scan's crops.
    upright = oriented_image(Path(tiles[0]["image"]))
    assert upright.size == (60, 80)
    assert upright.getpixel((30, 5))[0] > 200 and upright.getpixel((30, 75))[2] > 200


def trace(scene):
    path = scene / "scene_init" / "obj_stage" / "traces" / "trace.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_each_item_is_traced_once_per_run_with_a_fresh_time_also_from_the_cache(scene, monkeypatch):
    import time

    def full_run(run_id):
        monkeypatch.setenv("LITEREALITY_RUN_ID", run_id)
        run = Pass(scene)
        monkeypatch.setattr(run, "gather_evidence", lambda: seen(run, "Cup", "Pillow", "Sheet"))
        monkeypatch.setattr(run, "render_pairs", lambda *args: None)
        monkeypatch.setattr(run, "apply", lambda: None)
        monkeypatch.setattr(run, "summarize", lambda: None)
        answer(run, monkeypatch, {"Cup": "drop", "Pillow": "trellis", "Sheet": "procedural"})
        run.run()

    fake_steps(monkeypatch)
    full_run("attempt-01")
    started = time.time()
    full_run("attempt-02")
    rows = trace(scene)
    for run_id, reused in (("attempt-01", False), ("attempt-02", True)):
        mine = [r for r in rows if r["run"] == run_id]
        assert mine[0]["kind"] == "small_objects_start" and mine[-1]["kind"] == "small_objects_done"
        assert {k: mine[-1][k] for k in ("rebuilt", "dropped", "kept")} == {"rebuilt": 1, "dropped": 2, "kept": 1}
        done = {r["name"]: r for r in mine if r["kind"] == "small_object_done"}
        assert len(done) == len([r for r in mine if r["kind"] == "small_object_done"]) == 4
        assert {n: r["method"] for n, r in done.items()} == {
            "Cup": "dropped", "Pillow": "trellis", "Sheet": "procedural", "Book0": "dropped"}
        assert all(r["status"] == "ok" and r["reused"] is reused and r["stage"] == "small_objects"
                   for r in done.values())
    assert all(r["t"] >= round(started, 3) - 0.001 for r in rows if r["run"] == "attempt-02")


def test_a_rebuild_that_failed_is_traced_as_kept(scene, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    run = Pass(scene)
    run.find()
    seen(run, "Pillow")
    for item in run.items:
        item["decision"] = {"decision": "trellis" if item["id"] == "Pillow" else "drop", "description": ""}
    monkeypatch.setattr(evidence, "generator_inputs", lambda *args: [])
    monkeypatch.setattr(rebuild, "make_reference", lambda *args: {})
    monkeypatch.setattr(rebuild, "run_trellis", lambda *args: {})
    run.rebuild()
    (row,) = [r for r in trace(scene) if r["kind"] == "small_object_done"]
    assert (row["name"], row["method"], row["status"], row["reused"]) == ("Pillow", "kept", "failed", False)


# ── models made up front (premake) and adopted by the pass (LR_SMALL_OBJECTS_MODELS) ─────


def fake_steps(monkeypatch, fail=()):
    """make_reference, TRELLIS and the mesh steps as files that say where they came from; returns
    the calls made, so a test can tell which kinds or items reached the image model and TRELLIS."""
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    calls = {"reference": [], "trellis": []}

    def make_reference(item, tiles, description, folder):
        calls["reference"].append((item, tiles, description))
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "reference.png").write_bytes(b"reference of " + item["id"].encode())
        return {"cost_usd": 0.1}

    def run_trellis(references, work, log):
        calls["trellis"].append(sorted(references))
        (work / "glb").mkdir(parents=True, exist_ok=True)
        made = {}
        for oid, reference in references.items():
            if oid not in fail:
                (work / "glb" / f"{oid}.glb").write_bytes(b"mesh from " + reference.read_bytes())
                made[oid] = {"glb": work / "glb" / f"{oid}.glb", "pipeline": "default"}
        return made

    def drop_fragments(source, target, size=None):
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(Path(source).read_bytes() + b", cleaned")
        return {"pieces_before": 2, "pieces_after": 1}

    def correct_material(source, reference, category, target):
        target.write_bytes(Path(source).read_bytes() + b", coloured")
        return {"category": category}

    monkeypatch.setattr(rebuild, "usable_mesh", lambda path: path.is_file() and path.stat().st_size > 0)
    for name, fake in (("make_reference", make_reference), ("run_trellis", run_trellis),
                       ("drop_fragments", drop_fragments), ("correct_material", correct_material)):
        monkeypatch.setattr(rebuild, name, fake)
    monkeypatch.setattr(evidence, "generator_inputs", lambda *args: [])  # no capture crops on disk
    return calls


def test_premake_makes_one_model_per_kind_and_skips_unchanged_kinds(tmp_path, monkeypatch, capsys):
    from litereality_agent.pipeline.realism_authoring.small_objects import premake

    photos, out = tmp_path / "by-kind", tmp_path / "models"
    photo(photos / "TissueBox" / "a.jpg")
    photo(photos / "TissueBox" / "b.JPEG")
    photo(photos / "WaterBottle" / "x.jpg")
    (photos / "WaterBottle" / "description.txt").write_text("a clear plastic bottle, blue cap\n")
    calls = fake_steps(monkeypatch)
    assert premake.main([str(photos), "--out", str(out)]) == 0
    assert calls["trellis"] == [["TissueBox", "WaterBottle"]]  # one TRELLIS process for all
    asked = {item["id"]: (item, tiles, text) for item, tiles, text in calls["reference"]}
    item, tiles, text = asked["TissueBox"]
    assert (item["label"], item["category"], text) == ("tissue box", "box", "a tissue box")
    assert [Path(t["image"]).name for t in tiles] == ["photo_tile0.jpg", "photo_tile1.jpg"]
    assert asked["WaterBottle"][2] == "a clear plastic bottle, blue cap"
    assert (out / "TissueBox.glb").read_bytes() == b"mesh from reference of TissueBox, cleaned, coloured"
    receipt = json.loads((out / "TissueBox.json").read_text())
    assert set(receipt["inputs"]["photos"]) == {"a.jpg", "b.JPEG"}
    assert receipt["inputs"]["description"] == "a tissue box" and "image_model" in receipt["inputs"]["settings"]
    assert receipt["material"] == {"category": "box"} and receipt["fragments"]["pieces_after"] == 1
    printed = capsys.readouterr().out
    assert f"[premake] TissueBox: 2 photos, {out / 'TissueBox.glb'}" in printed

    calls["reference"].clear()
    assert premake.main([str(photos), "--out", str(out)]) == 0
    assert calls == {"reference": [], "trellis": [["TissueBox", "WaterBottle"]]}
    assert "TissueBox: 2 photos, reused" in capsys.readouterr().out

    photo(photos / "TissueBox" / "a.jpg", size=(80, 60))  # a new photo of one kind
    calls["trellis"].clear()
    assert premake.main([str(photos), "--out", str(out)]) == 0
    assert [item["id"] for item, *_ in calls["reference"]] == ["TissueBox"]
    assert calls["trellis"] == [["TissueBox"]]

    calls["reference"].clear()
    photo(photos / "PotPlant" / "p.jpg")
    assert premake.main([str(photos), "--out", str(out), "--only", "PotPlant"]) == 0
    assert [item["id"] for item, *_ in calls["reference"]] == ["PotPlant"]
    assert (out / "PotPlant.glb").is_file()


def test_premake_takes_a_supplied_cut_out_as_the_reference_without_the_image_model(tmp_path, monkeypatch):
    from PIL import Image

    from litereality_agent.pipeline.realism_authoring.small_objects import premake

    photos, out = tmp_path / "by-kind", tmp_path / "models"
    cut_out = np.zeros((60, 200, 4), np.uint8)
    cut_out[10:50, 20:180] = (12, 12, 12, 255)  # a dark book: only its transparency tells it from black
    (photos / "ShelfBooks").mkdir(parents=True)
    Image.fromarray(cut_out).save(photos / "ShelfBooks" / "reference.png")
    photo(photos / "PotPlant" / "p.jpg")
    calls = fake_steps(monkeypatch)
    assert premake.main([str(photos), "--out", str(out)]) == 0
    assert [item["id"] for item, *_ in calls["reference"]] == ["PotPlant"]  # the image model only for photos
    assert calls["trellis"] == [["PotPlant", "ShelfBooks"]]
    reference = np.asarray(Image.open(out / "work" / "ShelfBooks" / "reference.png"))
    assert reference.shape == (1024, 1024, 4)
    ys, xs = np.where(reference[..., 3] > 0)
    assert (xs.max() + 1 - xs.min(), ys.max() + 1 - ys.min()) == (799, 200)  # centred, 78 % of the canvas
    assert abs((xs.min() + xs.max()) / 2 - 511.5) <= 1 and abs((ys.min() + ys.max()) / 2 - 511.5) <= 1
    assert "reference" in json.loads((out / "ShelfBooks.json").read_text())["inputs"]

    calls["trellis"].clear()
    assert premake.main([str(photos), "--out", str(out)]) == 0 and calls["trellis"] == []
    cut_out[10:50, 20:180, :3] = (200, 30, 30)
    Image.fromarray(cut_out).save(photos / "ShelfBooks" / "reference.png")  # another cut-out: made again
    assert premake.main([str(photos), "--out", str(out)]) == 0 and calls["trellis"] == [["ShelfBooks"]]


def test_premake_leaves_nothing_of_a_failed_kind_and_exits_non_zero(tmp_path, monkeypatch, capsys):
    from litereality_agent.pipeline.realism_authoring.small_objects import premake

    photos, out = tmp_path / "by-kind", tmp_path / "models"
    photo(photos / "TissueBox" / "a.jpg")
    photo(photos / "WaterBottle" / "x.jpg")
    fake_steps(monkeypatch)
    assert premake.main([str(photos), "--out", str(out)]) == 0
    photo(photos / "TissueBox" / "a.jpg", size=(80, 60))
    (photos / "CardboardBox").mkdir()  # no photos
    fake_steps(monkeypatch, fail={"TissueBox"})
    assert premake.main([str(photos), "--out", str(out)]) == 1
    # The older model of the failed kind is not left for the pass to adopt.
    assert sorted(p.name for p in out.glob("*.glb")) == ["WaterBottle.glb"]
    assert not (out / "TissueBox.json").exists() and not list(out.glob(".*.part"))
    printed = capsys.readouterr().out
    assert "TissueBox: 1 photos, FAILED: RuntimeError: TRELLIS wrote no mesh" in printed
    assert "CardboardBox: 0 photos, FAILED: no .jpg/.jpeg" in printed


def models_dir(tmp_path, **models):
    folder = tmp_path / "models"
    folder.mkdir(exist_ok=True)
    for name, data in models.items():
        (folder / f"{name}.glb").write_bytes(data)
    return folder


def test_a_supplied_model_is_found_by_exact_id_or_by_kind_and_digits(scene, monkeypatch, tmp_path):
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models_dir(tmp_path, TissueBox=b"t", Book=b"b",
                                                                 Book0=b"b0")))
    run = Pass(scene)
    found = {oid: run.model({"id": oid}) for oid in
             ("TissueBox", "TissueBox0", "TissueBox12", "TissueBoxes", "Tissue0", "Book0", "Book1", "12")}
    assert {oid: path and path.name for oid, path in found.items()} == {
        "TissueBox": "TissueBox.glb", "TissueBox0": "TissueBox.glb", "TissueBox12": "TissueBox.glb",
        "TissueBoxes": None, "Tissue0": None, "Book0": "Book0.glb", "Book1": "Book.glb", "12": None}
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(tmp_path / "missing"))
    with pytest.raises(FileNotFoundError, match="LR_SMALL_OBJECTS_MODELS"):
        Pass(scene)


def test_the_pass_adopts_supplied_models_without_astra_or_trellis(scene, monkeypatch, tmp_path, capsys):
    from litereality_agent import artifact_cache as cache

    models = models_dir(tmp_path, Book=b"premade book", Cup=b"premade cup", Lamp=b"lamp")
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models))
    calls = fake_steps(monkeypatch)
    applied = []

    def full_run(run_id):
        monkeypatch.setenv("LITEREALITY_RUN_ID", run_id)
        run = Pass(scene)
        monkeypatch.setattr(run, "gather_evidence", lambda: seen(run, "Cup", "Pillow"))
        monkeypatch.setattr(run, "render_pairs", lambda *args: None)

        def blender(_blend, request, _label):
            applied.append(request)
            for name in ("Room.blend", "Room.glb", "room_layout.json"):
                Path(request["out_dir"], name).parent.mkdir(parents=True, exist_ok=True)
                Path(request["out_dir"], name).write_bytes(b"room")

        monkeypatch.setattr(run, "blender", blender)
        asked = {}
        answer(run, monkeypatch, {"Pillow": "procedural"}, asked)
        run.run()
        return run, asked

    run, asked = full_run("attempt-01")
    assert set(asked) == {"Pillow"}  # Book0 (by kind, seen in no frame) and Cup are not asked
    assert calls == {"reference": [], "trellis": []}
    items = {item["id"]: item for item in run.items}
    assert items["Book0"]["decision"] == {"decision": "trellis", "reason": "the operator supplied a model",
                                          "description": "", "forced": True,
                                          "source": str(models.resolve() / "Book.glb")}
    assert items["Book0"]["inputs"] == cache.fingerprint(
        {"policy": None, "photos": {}, "model": cache.file_hash(models / "Book.glb")})
    replace = {entry["id"]: entry for entry in applied[-1]["replace"]}
    assert set(replace) == {"Book0", "Book1", "Cup"}
    assert replace["Book0"]["glb"] == str(run.out / "rebuild" / "Book0" / "model.glb")
    # Its loose pieces gone again here, also from a model premade before that went by contact.
    assert Path(replace["Book0"]["glb"]).read_bytes() == b"premade book, cleaned"
    assert replace["Book0"]["camera"] is None and replace["Cup"]["camera"] == [0, 0, 1.5]
    assert [line for line in capsys.readouterr().out.splitlines()
            if "models for no candidate" in line] == [
        "[small-objects] models for no candidate (placed by the author or not in the room): Lamp.glb"]

    (models / "Cup.glb").write_bytes(b"premade cup, better")
    run, asked = full_run("attempt-02")
    assert asked == {} and calls == {"reference": [], "trellis": []}
    assert Path(run.out / "rebuild" / "Cup" / "model.glb").read_bytes() == b"premade cup, better, cleaned"
    for run_id, reused in (("attempt-01", {"Book0": False, "Cup": False}),
                           ("attempt-02", {"Book0": True, "Cup": False})):
        done = {r["name"]: r for r in trace(scene) if r["run"] == run_id and r["kind"] == "small_object_done"}
        for oid, again in reused.items():
            assert (done[oid]["method"], done[oid]["status"], done[oid]["reused"]) == ("trellis", "ok", again)
        assert done["Book0"]["source"] == str(models.resolve() / "Book.glb")
        assert "source" not in done["Pillow"]
    final = [r for r in trace(scene) if r["kind"] == "small_objects_done"][-1]
    assert (final["rebuilt"], final["dropped"], final["kept"], final["undone"]) == (3, 1, 1, 1)


def test_supplied_and_rebuilt_items_share_one_pass(scene, monkeypatch, tmp_path):
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models_dir(tmp_path, Cup=b"premade cup")))
    calls = fake_steps(monkeypatch)
    run = Pass(scene)
    run.find()
    seen(run, "Cup", "Pillow")
    answer(run, monkeypatch, {"Pillow": "trellis"})
    run.decide()
    run.rebuild()
    assert [item["id"] for item, *_ in calls["reference"]] == ["Pillow"]
    assert calls["trellis"] == [["Pillow"]]
    items = {item["id"]: item for item in run.items}
    assert items["Cup"]["material"] == {"supplied": str(tmp_path.resolve() / "models" / "Cup.glb")}
    assert Path(items["Pillow"]["glb"]).name == "model.glb" and items["Pillow"]["material"]


def test_a_rebuilt_room_keeps_the_work_of_the_items_it_did_not_change(scene, monkeypatch):
    """After the check's repair the room is built again; only what the repair changed is judged again."""
    run = Pass(scene)
    run.find()
    for item in run.items:
        item["decision"] = {"decision": "drop", "reason": "", "description": ""}
        (run.out / "evidence" / item["id"]).mkdir(parents=True)
    run.save()
    layout = json.loads((scene / "preview" / "room_layout.json").read_text())
    for entry in layout["objects"]:
        if entry["id"] == "Pillow":  # the repair moved it
            entry["bbox_min"][0] += 0.2
            entry["bbox_max"][0] += 0.2
    (scene / "preview" / "room_layout.json").write_text(json.dumps(layout))
    (scene / "preview" / "Room.blend").write_bytes(b"the repaired room")
    run = Pass(scene)
    run.find()
    items = {item["id"]: item for item in run.items}
    assert "decision" not in items["Pillow"] and not (run.out / "evidence" / "Pillow").exists()
    assert all("decision" in item for oid, item in items.items() if oid != "Pillow")
    assert (run.out / "evidence" / "Cup").is_dir()


def test_ready_models_are_copied_into_the_room_and_listed_for_the_author(tmp_path, monkeypatch):
    import trimesh

    from litereality_agent.pipeline.realism_authoring.small_objects import ready

    models = tmp_path / "models"
    (models / "work" / "TissueBox").mkdir(parents=True)
    # glTF is Y-up: a box 0.2 wide, 0.1 tall and 0.1 deep.
    trimesh.creation.box(extents=(0.2, 0.1, 0.1)).export(models / "TissueBox.glb")
    (models / "TissueBox.json").write_text(json.dumps({"inputs": {"description": "a white tissue box"}}))
    (models / "work" / "TissueBox" / "reference.png").write_bytes(b"png")
    room = tmp_path / "room"
    room.mkdir()
    (room / "Room.py").write_text("SHELL = {}")
    assert ready.stage(room) == []  # no models named
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models))
    rows = ready.stage(room)
    copy = trimesh.load(room / "Models" / "TissueBox.glb", force="scene")  # cleaned, the same box
    assert np.allclose(copy.extents, trimesh.load(models / "TissueBox.glb", force="scene").extents)
    made = (room / "Models" / "TissueBox.glb").stat().st_mtime_ns
    assert ready.stage(room) == rows and (room / "Models" / "TissueBox.glb").stat().st_mtime_ns == made
    assert rows == [{"kind": "TissueBox", "glb": "Models/TissueBox.glb", "proportions": [2.0, 1.0, 1.0],
                     "description": "a white tissue box",
                     "reference": str(models / "work" / "TissueBox" / "reference.png")}]
    brief = ready.prompt(rows)
    assert "scene.place_model(" in brief and "Models/TissueBox.glb: a white tissue box" in brief
    assert "scene.mark_small(" in brief  # what has no model is marked for the pass
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(tmp_path / "missing"))
    with pytest.raises(FileNotFoundError, match="LR_SMALL_OBJECTS_MODELS"):
        ready.stage(room)


def test_an_object_the_author_placed_from_a_ready_model_is_not_a_candidate():
    layout = room()
    layout["objects"].append(obj("TissueBox0", "small_object", [1.1, 1.8, 1.1], [1.2, 1.9, 1.15],
                                 rests_on="Shelf", source_glb="TissueBox.glb", rebuilt="model"))
    assert "TissueBox0" not in {c["id"] for c in candidates.find_candidates(layout)}


def test_loose_pieces_go_by_contact_and_a_shelf_row_of_things_stays(tmp_path):
    """A shelf row as one model (glTF, Y up): two things on its bottom, a book on one of them, a
    piece floating beside them and a speck. Only what touches nothing kept goes, however big."""
    import trimesh

    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    def box(size, centre):
        return trimesh.creation.box(size, trimesh.transformations.translation_matrix(centre))

    parts = [box((0.4, 0.6, 0.4), (0, 0.3, 0)),        # a vase on the bottom: the largest
             box((0.3, 0.3, 0.3), (0.6, 0.15, 0)),     # a box beside it, also on the bottom
             box((0.3, 0.05, 0.28), (0.62, 0.325, 0)),  # a book lying on that box
             box((0.25, 0.25, 0.25), (1.1, 0.6, 0)),   # floating beside them, not small
             box((0.01, 0.01, 0.01), (0, 0.8, 0))]     # a speck above the vase
    source = tmp_path / "row.glb"
    trimesh.Scene([trimesh.util.concatenate(parts)]).export(source)
    counts = rebuild.drop_fragments(source, tmp_path / "clean.glb")
    assert (counts["pieces_before"], counts["pieces_after"]) == (5, 3)
    kept = trimesh.load(tmp_path / "clean.glb", force="scene").dump(concatenate=True)
    assert np.allclose(kept.bounds, [[-0.2, 0, -0.2], [0.77, 0.6, 0.2]])
    assert 0 < counts["dropped_share"] < 0.25
    # A piece 1 cm beside the vase, off the bottom: as a 1 m thing in the room that is 1 cm apart
    # and goes; as a 0.1 m thing it is 1 mm from the vase, which the room's check counts as touching.
    parts[3] = box((0.25, 0.25, 0.25), (-0.335, 0.3, 0))
    trimesh.Scene([trimesh.util.concatenate(parts)]).export(source)
    assert rebuild.drop_fragments(source, tmp_path / "small.glb", size=0.1)["pieces_after"] == 4
    assert rebuild.drop_fragments(source, tmp_path / "clean.glb")["pieces_after"] == 3


def test_trellis_on_a_shared_card_waits_for_room_and_gives_up_without_it(tmp_path, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    log, shared = tmp_path / "log", {"ROOMCANVAS_GPU_SHARED_MIB": "8192", "CUDA_VISIBLE_DEVICES": "GPU-b"}
    assert rebuild.room_for_trellis(log, env={"CUDA_VISIBLE_DEVICES": "GPU-b"})  # a card of its own: at once
    frees, now = iter([9000, 20000]), [0.0]
    monkeypatch.setattr(rebuild, "free_mib", lambda device: next(frees))
    assert rebuild.room_for_trellis(log, env=shared, sleep=lambda s: now.__setitem__(0, now[0] + s), clock=lambda: now[0])
    assert "waiting for 18848 MiB" in log.read_text()
    monkeypatch.setattr(rebuild, "free_mib", lambda device: 9000)
    assert not rebuild.room_for_trellis(log, env=shared, sleep=lambda s: now.__setitem__(0, now[0] + s), clock=lambda: now[0])
    assert "TRELLIS skipped" in log.read_text()

def test_items_never_judged_or_not_rebuilt_are_undone_not_kept(tmp_path):
    from litereality_agent.pipeline.realism_authoring.small_objects.run import Pass

    ready = tmp_path / "Rebuilt.glb"
    ready.write_bytes(b"model")
    done = Pass.__new__(Pass)
    done.items = [{"id": "Kept", "decision": {"decision": "procedural"}},
                  {"id": "Dropped", "decision": {"decision": "drop"}},
                  {"id": "Rebuilt", "decision": {"decision": "trellis"}, "glb": str(ready), "material": {}},
                  {"id": "Uncorrected", "decision": {"decision": "trellis"}, "glb": "mesh.glb"},
                  {"id": "Unjudged", "decision_error": "RuntimeError: timed out"},
                  {"id": "NoMesh", "decision": {"decision": "trellis"}, "glb_error": "TRELLIS wrote no mesh"}]
    assert done.undone() == ["Uncorrected", "Unjudged", "NoMesh"]


# ── boxes the author marked for the pass (RoomScene.mark_small) ─────────────────────────


def marked_room():
    """room() plus what an author marks instead of modelling: a tissue box, a desk lamp (a
    category the pass never takes from built geometry), and two books stacked on the floor."""
    layout = room()
    layout["objects"] += [
        obj("TissueBox0", "tissue_box", [1.1, 1.75, 1.1], [1.34, 1.87, 1.2], rests_on="Shelf",
            small_marker=True, description="a white tissue box"),
        obj("DeskLamp0", "light", [-1.8, -1.8, 0], [-1.6, -1.6, 0.4], rests_on="Floor0",
            small_marker=True, description="a black metal desk lamp"),
        obj("Book2", "book", [-1.0, 1.2, 0], [-0.7, 1.4, 0.04], rests_on="Floor0",
            small_marker=True, description="a red hardback"),
        obj("Book3", "book", [-1.0, 1.2, 0.04], [-0.72, 1.39, 0.07], rests_on="Book2",
            small_marker=True, description="a blue paperback"),
    ]
    return layout


def test_rebuilt_marker_lamps_keep_their_mount_in_web_groups(small_objects, tmp_path, monkeypatch):
    import trimesh

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "web/scripts"))
    from room_objects import build

    layout = room()
    lamps = [
        obj("WallLamp0", "light", [0, 2, 1], [.2, 2.1, 1.2], small_marker=True, attached_to="Wall0"),
        obj("DeskLamp0", "light", [1, 1.7, 1.1], [1.2, 1.9, 1.3], small_marker=True, rests_on="Shelf"),
    ]
    layout["objects"].extend(lamps)
    model = tmp_path / "lamp.glb"
    trimesh.creation.box().export(model)
    items = [dict(i, decision={"decision": "trellis"}, views=[], glb=str(model), material={})
             for i in candidates.find_candidates(layout) if i["marker"]]
    _, replacements = small_objects.plan(items)
    plan = {i["id"]: i for i in replacements}
    assert "movable" not in plan["WallLamp0"] and plan["DeskLamp0"]["movable"]
    for lamp in lamps:
        lamp.update(rebuilt="trellis")
        if "movable" in plan[lamp["id"]]:
            lamp["movable"] = plan[lamp["id"]]["movable"]
    result = build(layout)
    records = {o["id"]: o for o in result["objects"]}
    groups = {g["id"]: g["members"] for g in result["groups"]}
    wall = records["WallLamp0"]
    assert (wall["role"], wall["mount"], wall["attached_to"]) == ("fixture", "wall", "Wall0")
    assert "WallLamp0" not in groups
    assert records["DeskLamp0"]["role"] == "furniture" and groups["DeskLamp0"] == ["DeskLamp0"]


def test_marked_boxes_are_candidates_with_their_description():
    items = {item["id"]: item for item in candidates.find_candidates(marked_room())}
    assert items["TissueBox0"]["marker"] and items["TissueBox0"]["description"] == "a white tissue box"
    assert items["DeskLamp0"]["marker"]  # marked: a candidate whatever its category
    assert items["Book2"]["members"] == ["Book2", "Book3"] and items["Book2"]["marker"]
    assert items["Book2"]["description"] == "a red hardback; a blue paperback"
    # What the author built itself is a candidate as before, never a marker.
    assert all(not items[oid]["marker"] and items[oid]["description"] == ""
               for oid in ("Sheet", "Pillow", "Book0", "Cup"))
    assert {oid for oid, item in items.items() if not item["marker"]} == {
        c["id"] for c in candidates.find_candidates(room())}


def test_supplied_book_splits_a_cached_marker_stack(marked_scene, monkeypatch):
    import trimesh

    run = Pass(marked_scene, only=["Book2", "Book3"])
    run.find()
    stack, = run.active()
    assert stack["members"] == ["Book2", "Book3"]
    stack["decision"] = {"decision": "drop"}
    run.save()

    models = marked_scene / "models"
    models.mkdir()
    trimesh.creation.box().export(models / "Book.glb")
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models))
    run = Pass(marked_scene, only=["Book2", "Book3"])
    run.find()
    seen(run)
    run.decide()
    run.rebuild()
    drop, replacements = run.plan(run.active())
    assert not drop
    assert [item["rests_on"] for item in run.active()] == ["Floor0", "Book2"]
    assert [item["decision"]["source"] for item in run.active()] == [str(models / "Book.glb")] * 2
    assert [(item["id"], item["members"]) for item in replacements] == [
        ("Book2", ["Book2"]), ("Book3", ["Book3"])]
    assert all(trimesh.load_scene(item["glb"]).geometry for item in replacements)


def test_rotated_marker_dimensions_in_both_prompts_and_world_bounds_in_projection(tmp_path, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    dims = [.24, .12, .10]
    half = (dims[0] + dims[1]) / (2 * math.sqrt(2))
    box = obj("Box0", "box", [-half, -half, 0], [half, half, dims[2]], small_marker=True,
              marker_pose={"size": dims, "bottom": [0, 0, 0], "yaw_deg": 45})
    item, = candidates.find_candidates({"objects": [box]})
    assert "0.24 x 0.12 x 0.10 metres" in judge.decide_prompt(item, True)
    bounds = []

    def rank(_cameras, low, high):
        bounds.append((low, high))
        return []

    monkeypatch.setattr(evidence, "rank_frames", rank)
    evidence.collect_views(item, [], tmp_path, tmp_path)
    assert bounds == [([-round(half, 4), -round(half, 4), 0], [round(half, 4), round(half, 4), .1])]

    def generate(sheet, prompt, raw, **kwargs):
        raw.write_bytes(sheet.read_bytes())

    monkeypatch.setattr(rebuild.image_gen, "generate_reference", generate)
    rebuild.make_reference(item, [], "", tmp_path)
    assert "dimensions xyz=0.24,0.12,0.10 meters" in (tmp_path / "prompt.txt").read_text()


def test_a_marker_is_asked_only_to_rebuild_or_drop():
    items = {item["id"]: item for item in candidates.find_candidates(marked_room())}
    for policy in (None, "trellis-first"):
        text = judge.decide_prompt(items["TissueBox0"], True, policy=policy)
        assert "placeholder box" in text and '"a white tissue box"' in text
        assert '"trellis" | "drop"' in text and "procedural" not in text
        assert judge.GUIDANCE not in text and judge.TRELLIS_FIRST not in text
        assert "always, whatever you decide" in text
    assert "IMAGE 2 the CURRENT MODEL is that placeholder box" in text
    only_photos = judge.decide_prompt({**items["TissueBox0"], "views": []}, False, photos=1)
    assert "No capture frame shows the object." in only_photos and "IMAGE 2" not in only_photos
    # Built geometry keeps today's question.
    (cup,) = [item for item in candidates.find_candidates(room()) if item["id"] == "Cup"]
    assert judge.decide_prompt(items["Cup"], True) == judge.decide_prompt(cup, True)
    assert '"drop" | "procedural" | "trellis"' in judge.decide_prompt(items["Cup"], True)


@pytest.fixture
def marked_scene(scene):
    layout = {**marked_room(), "cameras": [{"frame_index": 1, "position": [0, 0, 1.5]}]}
    (scene / "preview" / "room_layout.json").write_text(json.dumps(layout))
    return scene


def test_a_marker_judged_procedural_is_rebuilt_and_built_geometry_is_not(marked_scene, monkeypatch):
    run = Pass(marked_scene)
    run.find()
    seen(run, "TissueBox0", "DeskLamp0", "Cup", "Sheet")
    asked = {}
    answer(run, monkeypatch, {"TissueBox0": "procedural", "DeskLamp0": "drop", "Cup": "procedural",
                              "Sheet": "trellis"}, asked)
    run.decide()
    decisions = {i["id"]: i["decision"] for i in run.items}
    assert decisions["TissueBox0"] == {"decision": "trellis", "reason": "", "description": "a thing",
                                       "judged": "procedural", "forced": True, "coerced": True}
    assert decisions["DeskLamp0"] == {"decision": "drop", "reason": "", "description": "a thing"}
    assert decisions["Cup"] == {"decision": "procedural", "reason": "", "description": "a thing"}
    assert decisions["Book2"]["decision"] == "drop"  # seen in no frame, as any item
    assert "a white tissue box" in asked["TissueBox0"][1] and "placeholder" not in asked["Cup"][1]
    # The coerced decision stands on a later run; nothing is asked again.
    again = Pass(marked_scene)
    again.find()
    answer(again, monkeypatch, {})
    again.decide()
    assert {i["id"]: i["decision"] for i in again.items} == decisions


def test_forcing_a_marker_procedural_still_rebuilds_it(marked_scene, monkeypatch):
    monkeypatch.setenv("LR_SMALL_OBJECTS_FORCE", "TissueBox0=procedural,Cup=procedural")
    run = Pass(marked_scene)
    run.find()
    seen(run, "TissueBox0", "Cup")
    answer(run, monkeypatch, {"TissueBox0": "drop", "Cup": "trellis"})
    run.decide()
    decisions = {i["id"]: i["decision"] for i in run.items}
    assert (decisions["TissueBox0"]["decision"], decisions["TissueBox0"]["coerced"]) == ("trellis", True)
    assert decisions["Cup"]["decision"] == "procedural" and "coerced" not in decisions["Cup"]


def test_the_policy_concerns_only_built_geometry(marked_scene, monkeypatch):
    monkeypatch.setenv("LR_SMALL_OBJECTS_POLICY", "trellis-first")
    run = Pass(marked_scene)
    run.find()
    items = {i["id"]: i for i in run.items}
    assert "inputs" not in items["TissueBox0"] and items["Cup"]["inputs"]


def test_a_changed_description_judges_only_that_marker_again(marked_scene):
    run = Pass(marked_scene)
    run.find()
    for item in run.items:
        item["decision"] = {"decision": "trellis", "reason": "", "description": ""}
    run.save()
    layout = json.loads((marked_scene / "preview" / "room_layout.json").read_text())
    for entry in layout["objects"]:
        if entry["id"] == "TissueBox0":
            entry["description"] = "a pink tissue box"
        if entry["id"] == "Cup":  # rebuilt as a marker at the same place
            entry.update(small_marker=True, description="a green mug")
    (marked_scene / "preview" / "room_layout.json").write_text(json.dumps(layout))
    (marked_scene / "preview" / "Room.blend").write_bytes(b"the repaired room")
    again = Pass(marked_scene)
    again.find()
    items = {i["id"]: i for i in again.items}
    assert {oid for oid, item in items.items() if "decision" not in item} == {"TissueBox0", "Cup"}
    assert items["Cup"]["marker"] and items["TissueBox0"]["description"] == "a pink tissue box"


def test_a_marker_rebuild_that_failed_keeps_the_box_and_says_why(marked_scene, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    run = Pass(marked_scene)
    run.find()
    seen(run, "TissueBox0", "Pillow")
    for item in run.items:
        wanted = item["id"] in ("TissueBox0", "Pillow")
        item["decision"] = {"decision": "trellis" if wanted else "drop", "description": ""}
    descriptions = {}
    monkeypatch.setattr(evidence, "generator_inputs", lambda *args: [])
    monkeypatch.setattr(rebuild, "make_reference", lambda item, tiles, description, folder:
                        descriptions.update({item["id"]: description}))
    monkeypatch.setattr(rebuild, "run_trellis", lambda *args: {})  # e.g. the GPU wait gave up
    run.rebuild()
    # Astra gave no description: the author's stands in for the marker.
    assert descriptions == {"TissueBox0": "a white tissue box", "Pillow": ""}
    rows = {r["name"]: r for r in trace(marked_scene) if r["kind"] == "small_object_done"}
    box = rows["TissueBox0"]
    assert (box["method"], box["status"], box["marker"]) == ("kept", "failed", True)
    assert box["reason"] == "TRELLIS wrote no mesh"
    assert rows["Pillow"]["method"] == "kept" and "marker" not in rows["Pillow"]
    items = {i["id"]: i for i in run.items}
    assert run.outcome(items["TissueBox0"]).startswith("marker box kept, rebuild failed")
    assert run.outcome(items["Pillow"]).startswith("unchanged, rebuild failed")
    assert "TissueBox0" in run.undone()


@pytest.mark.parametrize("yaw", [0, 30, 180])
def test_marker_placement_preserves_directed_front_and_all_three_dimensions(yaw):
    target = {"bottom": [1, 2, .8], "size": [.24, .12, .1], "yaw_deg": yaw}
    asset = np.array([.24, .24, .1])
    pose = fit.placement(target, asset, camera_xy=[1, 5])
    assert asset * pose["scale"] == pytest.approx(target["size"])
    assert pose["yaw"] == pytest.approx(math.radians(yaw))


def test_marker_overhang_has_strict_underside_support(monkeypatch):
    import runpy
    import sys
    from unittest.mock import MagicMock

    import trimesh

    from litereality_agent.agent.author import TEMPLATE
    from litereality_agent.pipeline.room_qc.support_audit import vertical_contacts

    bpy = MagicMock()
    monkeypatch.setitem(sys.modules, "bpy", bpy)
    monkeypatch.setitem(sys.modules, "mathutils", MagicMock())
    mesh = runpy.run_path(str(TEMPLATE))["_unit_cube_mesh"]("box")
    verts, _, faces = mesh.from_pydata.call_args.args
    box = trimesh.Trimesh(np.asarray(verts) * [.24, .12, .1] + [0, 0, .05], faces)
    top = trimesh.creation.box([.2, .1, .02])
    top.apply_translation([0, 0, -.01])
    contact = vertical_contacts(box, top, tolerance=.005, sink_tolerance=.005)
    assert contact["contact_samples"] > 0 and contact["center_over_contact_hull"]


def test_the_room_template_has_the_marker():
    from litereality_agent.agent.author import TEMPLATE

    source = TEMPLATE.read_text()
    assert "def mark_small" in source and 'handle["small_marker"] = True' in source


@pytest.mark.blender
def test_mark_small_makes_one_coloured_box_on_its_support(tmp_path, monkeypatch):
    import os
    import subprocess
    from types import SimpleNamespace

    import trimesh

    from litereality_agent.pipeline.realism_authoring import passes
    from litereality_agent.room_ops.paths import find_blender

    source = Path(__file__).resolve().parents[1] / "src"
    preview = tmp_path / "preview"
    preview.mkdir()
    script = tmp_path / "scene.py"
    script.write_text(
        """
import sys, json
sys.path.insert(0, SOURCE)
import bpy
from litereality_agent.room_ops.compile.build_room import RoomScene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,-.05))
floor=bpy.context.object; floor.name='Floor0'; floor.dimensions=(4,4,.1)
table=bpy.data.objects.new('Table0',None)
table['room_id']='Table0'; table['category']='table'
bpy.context.scene.collection.objects.link(table)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,.75))
top=bpy.context.object; top.name='Desktop'; top.dimensions=(1,1,.1); top.parent=table
scene=object.__new__(RoomScene)
scene.objects={}; scene.cameras=[]; scene.scan_dir=str(OUT); scene.out_glb=OUT
handle=scene.mark_small('TissueBox0','tissue_box',bottom=(0.1,0,0.8),size=(0.24,0.12,0.1),
                        yaw_deg=30,rests_on='Table0',description='a white tissue box',
                        color=(255,255,255))
lamp=scene.mark_small('DeskLamp0','light',bottom=(-.2,0,.8),size=(.24,.12,.1),rests_on='Table0')
scene.mark_small('Mug0','mug',bottom=(0,.3,.8),size=(.1,.1,.1),rests_on='Table0')
parts=[o for o in handle.children_recursive]
assert len(parts)==1 and parts[0].type=='MESH' and len(parts[0].data.vertices)==8
assert tuple(round(v,6) for v in parts[0].scale)==(1,1,1)
colour=parts[0].data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value
assert min(colour[:3])>0.99
scene.bind_supports()
lamp.location.x += .05
lamp.children[0].rotation_euler.z = 3.14159265
table.location.x += .02
scene.export_glb()
assert handle.parent==table
scene.export_layout(LAYOUT)
bpy.ops.wm.save_as_mainfile(filepath=BLEND)
""".replace("LAYOUT", repr(str(preview / "room_layout.json")))
        .replace("BLEND", repr(str(preview / "Room.blend")))
        .replace("SOURCE", repr(str(source)))
        .replace("OUT", repr(str(preview / "Room.glb")))
    )
    result = subprocess.run(
        [find_blender(), "-b", "--python-exit-code", "1", "--python", str(script)],
        capture_output=True, text=True, env=dict(os.environ), timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    layout = json.loads((preview / "room_layout.json").read_text())
    entry = {o["id"]: o for o in layout["objects"]}["TissueBox0"]
    assert (entry["small_marker"], entry["description"]) == (True, "a white tissue box")
    assert (entry["category"], entry["rests_on"]) == ("tissue_box", "Table0")
    c, s = math.cos(math.radians(30)), math.sin(math.radians(30))
    assert entry["size"] == pytest.approx([0.24 * c + 0.12 * s, 0.24 * s + 0.12 * c, 0.1], abs=1e-3)
    assert entry["bbox_min"][2] == pytest.approx(0.8, abs=1e-4)
    (item,) = [i for i in candidates.find_candidates(layout) if i["id"] == "TissueBox0"]
    assert item["marker"] and item["description"] == "a white tissue box"

    assert item["marker_pose"]["yaw_deg"] == 30
    assert item["marker_pose"]["bottom"] == pytest.approx([.12, 0, .8])
    assert item["marker_pose"]["size"] == pytest.approx([.24, .12, .1])

    layout["cameras"] = [{"frame_index": 1, "position": [0, 5, 1.5]}]
    (preview / "room_layout.json").write_text(json.dumps(layout))
    (preview / "manifest.json").write_text('{"assets": []}')
    paths = {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring"}
    (tmp_path / "scene.json").write_text(json.dumps({"paths": paths}))
    models = models_dir(tmp_path, TissueBox0=b"invalid GLB")
    trimesh.creation.box([.24, .1, .24]).export(models / "DeskLamp0.glb")
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models))

    def run_pass(*args, **kwargs):
        run = Pass(tmp_path)
        monkeypatch.setattr(run, "gather_evidence", lambda: seen(run, "DeskLamp0"))
        monkeypatch.setattr(run, "render_pairs", lambda *args: None)
        run.run()
        return 0, None

    monkeypatch.setattr(passes, "run_module", run_pass)
    ctx = SimpleNamespace(scene_dir=tmp_path, authoring_root=tmp_path / "authoring",
                          authored_room=tmp_path / "authoring" / "room",
                          preview_dir=preview, object_root=tmp_path / "scene_init/obj_stage")
    report = passes.run(ctx, {"articulate": False})
    assert report["small_objects"] == "partial" and report["left"] == {"small_objects": ["TissueBox0"]}
    final = tmp_path / report["room"]
    layout = json.loads((final / "room_layout.json").read_text())
    entries = {o["id"]: o for o in layout["objects"]}
    assert entries["TissueBox0"]["small_marker"] and "Mug0" not in entries
    assert entries["DeskLamp0"]["movable"] and not entries["DeskLamp0"].get("small_marker")
    assert entries["DeskLamp0"]["size"] == pytest.approx([.24, .12, .1], abs=.0001)
    assert entries["DeskLamp0"]["center"] == pytest.approx([-.13, 0, .85], abs=.0001)
    glb = trimesh.load_scene(final / "Room.glb")
    matrix, _ = glb.graph[entries["DeskLamp0"]["handle"]]
    # The author turned the marker's front (glTF +Z) through half a turn after creation.
    assert matrix[:3, 2] == pytest.approx([0, 0, -1], abs=1e-5)
    monkeypatch.syspath_prepend(str(source.parents[1] / "web/scripts"))
    from room_objects import build

    groups = {g["id"]: g["members"] for g in build(layout, set(glb.graph.nodes))["groups"]}
    assert groups["DeskLamp0"] == ["DeskLamp0"]


def migrate_445ec9f_model_template(path, template):
    import inspect
    import subprocess

    from litereality_agent.agent import author

    legacy = subprocess.check_output(
        ["git", "show", "445ec9f:room-reconstruction/src/litereality_agent/room_ops/compile/build_room.py"],
        cwd=author.TEMPLATE.parent, text=True)
    prompt = "scene.place_model("
    path.write_text(legacy)
    assert not author._template_migrations(path, "")
    notes = author._template_migrations(path, prompt)
    assert "Copy the missing RoomScene.place_model" in notes and "Copy the model_world_bbox helper" in notes
    assert "copy the rebuilt argument and its assignment" in notes
    assert "copy the model_world_bbox branch" in notes
    assert 'forward rebuilt=o.get("rebuilt")' in notes

    # Apply only the indicated edits to the historical room, keeping its register and index.
    room = legacy.replace("class RoomScene:", inspect.getsource(template["model_world_bbox"])
                          + "\nclass RoomScene:\n" + inspect.getsource(template["RoomScene"].place_model))
    room = room.replace("support_part=None):\n        mn, mx = world_bbox(meshes)",
                        'support_part=None, rebuilt=None):\n'
                        '        mn, mx = model_world_bbox(meshes, source) if rebuilt == "model" else world_bbox(meshes)')
    room = room.replace("    def index(self):", '        if rebuilt:\n'
                        '            self.objects[rid]["rebuilt"] = rebuilt\n\n    def index(self):')
    path.write_text(room)
    assert "copy the rebuilt argument" not in author._template_migrations(path, prompt)
    assert "forward rebuilt" in author._template_migrations(path, prompt)
    path.write_text(room.replace('support_part=o.get("support_part"),',
                                 'support_part=o.get("support_part"), rebuilt=o.get("rebuilt"),'))
    assert not author._template_migrations(path, prompt)


@pytest.mark.parametrize("legacy", [False, True], ids=["current", "445ec9f"])
def test_place_model_measures_rotated_cylinder_vertices(tmp_path, monkeypatch, legacy):
    import runpy
    import sys
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    import trimesh

    from litereality_agent.agent.author import TEMPLATE

    class Vector(np.ndarray):
        def __new__(cls, xyz):
            return np.asarray(xyz, dtype=float).view(cls)

        @property
        def z(self):
            return self[2]

    class Empty(dict):
        type = "EMPTY"

        def __init__(self, name):
            self.name = name

    cylinder = trimesh.creation.cylinder(radius=.05, height=.1, sections=64)
    transform = trimesh.transformations.rotation_matrix(math.pi / 4, [0, 0, 1])
    transform[:3, 3] = [.3, -.2, .1]
    mesh = MagicMock(type="MESH")
    mesh.parent = None
    mesh.name = "Cylinder"
    mesh.bound_box = trimesh.bounds.corners(cylinder.bounds)
    evaluated = MagicMock()
    vertices = evaluated.data.vertices
    vertices.__len__.return_value = len(cylinder.vertices)
    vertices.foreach_get.side_effect = lambda prop, out: np.copyto(out, cylinder.vertices.ravel())

    def evaluate(_depsgraph):
        fit = mesh.parent
        evaluated.matrix_world = fit.parent.matrix_world @ fit.matrix_basis @ transform if fit is not None else transform
        return evaluated

    mesh.evaluated_get.side_effect = evaluate
    mesh.matrix_world.__matmul__.side_effect = lambda p: (evaluate(None).matrix_world @ [*p, 1])[:3]
    bpy = MagicMock()
    bpy.data.objects.new.side_effect = lambda name, data: Empty(name)
    matrices = SimpleNamespace(Translation=trimesh.transformations.translation_matrix,
                               Diagonal=np.diag, Rotation=lambda angle, dims, axis:
                               trimesh.transformations.rotation_matrix(angle, [0, 0, 1]))
    monkeypatch.setitem(sys.modules, "bpy", bpy)
    monkeypatch.setitem(sys.modules, "mathutils", SimpleNamespace(Matrix=matrices, Vector=Vector))
    template = runpy.run_path(str(TEMPLATE))
    if legacy:
        path = tmp_path / "Room.py"
        migrate_445ec9f_model_template(path, template)
        template = runpy.run_path(str(path))
    scene = object.__new__(template["RoomScene"])
    scene.objects, scene.cameras, scene.scan_dir = {}, [], str(tmp_path)
    monkeypatch.setitem(scene.place_model.__globals__, "import_glb", lambda _: [mesh])
    monkeypatch.setitem(scene.place_model.__globals__, "mesh_descendants", lambda _: [mesh])
    size = [.24, .12, .1]
    handle = scene.place_model("Direct", "asset.glb", bottom=(1, 0, .8), size=size)
    world = handle.matrix_world @ mesh.parent.matrix_basis @ transform
    points = trimesh.transform_points(cylinder.vertices, world)
    assert np.ptp(points, axis=0) == pytest.approx(size, abs=1e-6)
    assert (points.max(0) + points.min(0)) / 2 == pytest.approx([1, 0, .85], abs=1e-6)
    assert scene.objects["Direct"]["rebuilt"] == "model"
    assert scene.objects["Direct"]["size"] == pytest.approx(size)
    top = scene.top_surface("Direct")
    assert top["size"] == pytest.approx(size[:2]) and top["z"] == pytest.approx(.9)

    bpy.data.objects.__iter__.side_effect = lambda: iter([handle, mesh])
    handle.matrix_world[0, 3] += .5
    scene.index()
    layout = tmp_path / "room_layout.json"
    scene.export_layout(layout)
    entry, = json.loads(layout.read_text())["objects"]
    assert entry["rebuilt"] == "model" and entry["size"] == pytest.approx(size)
    assert entry["bbox_min"] == pytest.approx([1.38, -.06, .8])
    assert entry["bbox_max"] == pytest.approx([1.62, .06, .9])


@pytest.mark.blender
def test_rotated_asset_root_fits_each_marker_axis_in_exported_glb(tmp_path):
    import subprocess

    import trimesh

    from litereality_agent.room_ops.paths import find_blender

    source = Path(__file__).resolve().parents[1] / "src"
    script = tmp_path / "fit_rotated.py"
    script.write_text("""
import math, sys
from pathlib import Path
source, folder = sys.argv[sys.argv.index('--') + 1:]
# As in production: Room.py carries build_room's source and blender_ops runs as a script, so neither
# imports the litereality_agent package (whose settings need pydantic, absent from Blender's Python).
sys.path.insert(0, source + '/litereality_agent/room_ops/compile')
sys.path.insert(0, source + '/litereality_agent/pipeline/realism_authoring/small_objects')
import bpy
from build_room import RoomScene
import blender_ops

folder = Path(folder)
asset = str(folder / 'asset.glb')
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=.05, depth=.1, location=(0.3, -0.2, 0.1))
cylinder = bpy.context.object
cylinder.rotation_euler.z = math.pi / 4
bpy.ops.export_scene.gltf(filepath=asset, use_selection=True)
bpy.data.objects.remove(cylinder, do_unlink=True)

scene = object.__new__(RoomScene)
scene.objects = {}
scene.out_glb = str(folder / 'Room.glb')
size = (.24, .12, .1)
scene.place_model('Direct', asset, bottom=(1, 0, .8), size=size)
assert scene.objects['Direct']['size'] == list(size)
assert scene.top_surface('Direct')['size'] == list(size[:2])
scene.mark_small('Swap', 'mug', bottom=(-1, 0, .8), size=size)
scene.index()
item = dict(id='Swap', members=['Swap'], category='mug', glb=asset,
            marker_pose=scene.objects['Swap']['marker_pose'])
blender_ops.place(item, blender_ops.handles(), folder, dict(removed=[], placed=[], moved=[]))
scene.export_glb()
scene.cameras, scene.scan_dir = [], str(folder)
scene.export_layout()
""")
    result = subprocess.run(
        [find_blender(), "-b", "--python-exit-code", "1", "--python", str(script),
         "--", str(source), str(tmp_path)], capture_output=True, text=True, timeout=90)
    assert result.returncode == 0, result.stdout + result.stderr
    glb = trimesh.load_scene(tmp_path / "Room.glb")
    layout = json.loads((tmp_path / "room_layout.json").read_text())
    direct = next(o for o in layout["objects"] if o["id"] == "Direct")
    assert direct["size"] == pytest.approx([.24, .12, .1])
    for name, x in (("Direct", 1), ("Swap", -1)):
        nodes = glb.graph.transforms.successors(name) & set(glb.graph.nodes_geometry)
        (node,) = nodes
        matrix, geometry = glb.graph[node]
        points = trimesh.transform_points(glb.geometry[geometry].vertices, matrix)
        assert np.ptp(points, axis=0) == pytest.approx([.24, .1, .12], abs=1e-5)  # glTF Y-up
        assert (points.max(0) + points.min(0)) / 2 == pytest.approx([x, .85, 0], abs=1e-5)


@pytest.mark.parametrize("built", ["Book2", "Book3"])
def test_built_and_marked_books_keep_separate_decisions_and_support(built):
    layout = marked_room()
    next(o for o in layout["objects"] if o["id"] == built).pop("small_marker")
    items = {i["id"]: i for i in candidates.find_candidates(layout)}
    for name in ("Book2", "Book3"):
        assert items[name]["marker"] is (name != built)
        assert items[name]["members"] == [name]
    assert items["Book3"]["rests_on"] == "Book2"


def test_mixed_category_marker_stack_reuses_its_decision():
    import os
    import subprocess
    import sys

    from litereality_agent.pipeline.realism_authoring.pass_cache import carry

    layout = marked_room()
    next(o for o in layout["objects"] if o["id"] == "Book3")["category"] = "paper"
    old = candidates.find_candidates(layout)
    stack = next(i for i in old if i["id"] == "Book2")
    assert stack["category"] == "book"
    stack["decision"] = {"decision": "trellis"}
    layout["objects"].reverse()
    script = ("import json, sys; from litereality_agent.pipeline.realism_authoring.small_objects "
              "import candidates; print(json.dumps(candidates.find_candidates(json.load(sys.stdin))))")
    for seed in ("1", "3"):
        rerun = subprocess.run([sys.executable, "-c", script], input=json.dumps(layout),
                               capture_output=True, text=True, check=True,
                               env={**os.environ, "PYTHONHASHSEED": seed})
        reused, changed = carry(old, json.loads(rerun.stdout))
        assert not changed and next(i for i in reused if i["id"] == "Book2") is stack


@pytest.mark.parametrize("force", ["procedural", "trellis"])
def test_marker_force_without_images_drops_before_rebuilding(marked_scene, monkeypatch, force):
    monkeypatch.setenv("LR_SMALL_OBJECTS_FORCE", f"TissueBox0={force}")
    calls = fake_steps(monkeypatch)
    run = Pass(marked_scene)
    run.find()
    seen(run)
    answer(run, monkeypatch, {})
    run.decide()
    run.rebuild()
    assert next(i for i in run.items if i["id"] == "TissueBox0")["decision"]["decision"] == "drop"
    assert calls == {"trellis": [], "reference": []}


def test_articulation_skips_marker_until_it_is_replaced():
    from litereality_agent.pipeline.realism_authoring.articulate import candidates as parts

    layout = marked_room()
    assert "TissueBox0" not in {i["id"] for i in parts.find_candidates(layout)}
    box = next(o for o in layout["objects"] if o["id"] == "TissueBox0")
    box.pop("small_marker")
    box.update(rebuilt="trellis", source_glb="TissueBox0.glb")
    assert "TissueBox0" in {i["id"] for i in parts.find_candidates(layout)}


def test_marker_override_provenance_changes_without_rebuilding(marked_scene, monkeypatch):
    calls = fake_steps(monkeypatch)
    for force in (None, "procedural", "trellis", None):
        monkeypatch.setenv("LR_SMALL_OBJECTS_FORCE", f"TissueBox0={force}" if force else "")
        run = Pass(marked_scene)
        run.find()
        seen(run, "TissueBox0")
        answer(run, monkeypatch, {"TissueBox0": "trellis"} if not calls["trellis"] else {})
        run.decide()
        run.rebuild()
        box = next(i for i in json.loads(run.state_path.read_text()) if i["id"] == "TissueBox0")
        assert box["decision"]["decision"] == "trellis"
        assert box["decision"].get("override") == force
        assert bool(box["decision"].get("coerced")) is (force == "procedural")
    assert calls["trellis"] == [["TissueBox0"]]


def test_retry_reports_the_current_mesh_failure_in_trace_and_summary(marked_scene, monkeypatch):
    from litereality_agent.agent.providers import vision

    fake_steps(monkeypatch, fail={"TissueBox0"})
    async def timeout(*args, **kwargs):
        raise TimeoutError("judge timed out")

    monkeypatch.setattr(vision, "ask_images", timeout)
    run = Pass(marked_scene)
    run.find()
    seen(run, "TissueBox0")
    run.decide()
    box = next(i for i in run.items if i["id"] == "TissueBox0")
    assert box["decision_error"] == "TimeoutError: judge timed out"

    async def success(*args, **kwargs):
        return '{"decision": "trellis"}'

    monkeypatch.setattr(vision, "ask_images", success)
    run = Pass(marked_scene)
    run.decide()
    run.rebuild()
    run.summarize()
    row = next(r for r in trace(marked_scene) if r["kind"] == "small_object_done"
               and r["run"] == run.run_id and r["name"] == "TissueBox0")
    assert row["reason"] == "TRELLIS wrote no mesh"
    assert row["reason"] in (run.out / "summary.md").read_text()
    box = next(i for i in run.items if i["id"] == "TissueBox0")
    assert "decision_error" not in box


def test_half_turn_with_identical_bounds_invalidates_marker_placement(marked_scene):
    path = marked_scene / "preview" / "room_layout.json"
    layout = json.loads(path.read_text())
    box = next(o for o in layout["objects"] if o["id"] == "TissueBox0")
    box["marker_pose"] = {"bottom": [1.22, 1.81, 1.1], "size": [.24, .12, .1], "yaw_deg": 0}
    path.write_text(json.dumps(layout))
    run = Pass(marked_scene)
    run.find()
    for item in run.items:
        item["decision"] = {"decision": "drop"}
    run.save()
    box["marker_pose"]["yaw_deg"] = 180
    path.write_text(json.dumps(layout))
    again = Pass(marked_scene)
    again.find()
    assert [i["id"] for i in again.items if "decision" not in i] == ["TissueBox0"]


@pytest.mark.parametrize("stage", ["run_trellis", "drop_fragments", "correct_material"])
def test_generated_mesh_failure_is_isolated_and_retried(marked_scene, monkeypatch, stage):
    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    fake_steps(monkeypatch)
    run = Pass(marked_scene)
    run.find()
    seen(run, "DeskLamp0", "TissueBox0")
    answer(run, monkeypatch, {"DeskLamp0": "trellis", "TissueBox0": "trellis"})
    run.decide()
    original = getattr(rebuild, stage)

    def fail(*args):
        if stage == "run_trellis":
            original({"DeskLamp0": args[0]["DeskLamp0"]}, *args[1:])
            raise OSError("launcher failed")
        if "TissueBox0" in str(args[0]):
            raise ValueError("bad mesh")
        return original(*args)

    monkeypatch.setattr(rebuild, stage, fail)
    run.rebuild()
    assert run.undone() == ["TissueBox0"]
    assert [i["id"] for i in run.plan(run.items)[1]] == ["DeskLamp0"]
    box = next(i for i in run.items if i["id"] == "TissueBox0")
    assert box["glb_error"] == ("OSError: launcher failed" if stage == "run_trellis" else "ValueError: bad mesh")
    monkeypatch.setattr(rebuild, stage, original)
    again = Pass(marked_scene)
    again.rebuild()
    assert not again.undone()
    assert "glb_error" not in next(i for i in again.items if i["id"] == "TissueBox0")


def test_corrupt_premade_leaves_only_its_marker_and_recovers_after_replacement(marked_scene, monkeypatch):
    import trimesh

    models = models_dir(marked_scene, TissueBox0=b"invalid GLB")
    trimesh.creation.box().export(models / "DeskLamp0.glb")
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models))
    run = Pass(marked_scene)
    run.find()
    seen(run)
    run.decide()
    run.rebuild()
    drop, replace = run.plan(run.items)
    assert run.undone() == ["TissueBox0"]
    assert "TissueBox0" not in {i["id"] for i in drop}
    assert [i["id"] for i in replace] == ["DeskLamp0"]
    assert replace[0]["movable"] and trimesh.load_scene(replace[0]["glb"]).geometry
    run.summarize()
    assert "marker box kept, rebuild failed" in (run.out / "summary.md").read_text()
    (models / "TissueBox0.glb").write_bytes((models / "DeskLamp0.glb").read_bytes())
    again = Pass(marked_scene)
    again.find()
    again.decide()
    again.rebuild()
    assert not again.undone()
    assert [i["id"] for i in again.plan(again.items)[1]] == ["DeskLamp0", "TissueBox0"]
