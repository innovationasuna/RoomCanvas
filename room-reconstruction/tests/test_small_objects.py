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

    from litereality_agent.pipeline.realism_authoring.small_objects import rebuild

    def full_run(run_id):
        monkeypatch.setenv("LITEREALITY_RUN_ID", run_id)
        run = Pass(scene)
        monkeypatch.setattr(run, "gather_evidence", lambda: seen(run, "Cup", "Pillow", "Sheet"))
        monkeypatch.setattr(run, "render_pairs", lambda *args: None)
        monkeypatch.setattr(run, "apply", lambda: None)
        monkeypatch.setattr(run, "summarize", lambda: None)
        answer(run, monkeypatch, {"Cup": "drop", "Pillow": "trellis", "Sheet": "procedural"})
        run.run()

    monkeypatch.setattr(evidence, "generator_inputs", lambda *args: [])
    monkeypatch.setattr(rebuild, "make_reference", lambda *args: {})
    monkeypatch.setattr(rebuild, "run_trellis", lambda refs, *_: {
        oid: {"glb": "trellis.glb", "pipeline": "default"} for oid in refs})
    monkeypatch.setattr(rebuild, "drop_fragments", lambda *args: {})
    monkeypatch.setattr(rebuild, "correct_material", lambda *args: {})
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

    def drop_fragments(source, target):
        target.write_bytes(Path(source).read_bytes() + b", cleaned")
        return {"pieces_before": 2, "pieces_after": 1}

    def correct_material(source, reference, category, target):
        target.write_bytes(Path(source).read_bytes() + b", coloured")
        return {"category": category}

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
    assert set(replace) == {"Book0", "Cup"}
    assert replace["Book0"]["glb"] == str(run.out / "rebuild" / "Book0" / "model.glb")
    assert Path(replace["Book0"]["glb"]).read_bytes() == b"premade book"
    assert replace["Book0"]["camera"] is None and replace["Cup"]["camera"] == [0, 0, 1.5]
    assert [line for line in capsys.readouterr().out.splitlines()
            if "models for no candidate" in line] == ["[small-objects] models for no candidate (ignored): Lamp.glb"]

    (models / "Cup.glb").write_bytes(b"premade cup, better")
    run, asked = full_run("attempt-02")
    assert asked == {} and calls == {"reference": [], "trellis": []}
    assert Path(run.out / "rebuild" / "Cup" / "model.glb").read_bytes() == b"premade cup, better"
    for run_id, reused in (("attempt-01", {"Book0": False, "Cup": False}),
                           ("attempt-02", {"Book0": True, "Cup": False})):
        done = {r["name"]: r for r in trace(scene) if r["run"] == run_id and r["kind"] == "small_object_done"}
        for oid, again in reused.items():
            assert (done[oid]["method"], done[oid]["status"], done[oid]["reused"]) == ("trellis", "ok", again)
        assert done["Book0"]["source"] == str(models.resolve() / "Book.glb")
        assert "source" not in done["Pillow"]
    final = [r for r in trace(scene) if r["kind"] == "small_objects_done"][-1]
    assert (final["rebuilt"], final["dropped"], final["kept"]) == (2, 1, 1)


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
