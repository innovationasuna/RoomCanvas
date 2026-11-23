import json
import sys
from pathlib import Path

import pytest
import trimesh
from PIL import Image

from litereality_agent.pipeline.realism_authoring.author import entrypoint
from litereality_agent.pipeline.realism_authoring.small_objects import ready, rebuild
from litereality_agent.pipeline.realism_authoring.small_objects.run import Pass


def box(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    mesh = trimesh.creation.box()
    mesh.visual = trimesh.visual.TextureVisuals(material=trimesh.visual.material.PBRMaterial())
    mesh.export(path)
    return path


@pytest.fixture
def two_cups(tmp_path):
    preview = tmp_path / "preview"
    preview.mkdir()
    (tmp_path / "scene.json").write_text(json.dumps({
        "paths": {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring"}}))
    cups = [{"id": f"Cup{i}", "category": "cup", "small_marker": True,
             "bbox_min": [i, 0, 0], "bbox_max": [i + .1, .1, .1]} for i in (0, 1)]
    (preview / "room_layout.json").write_text(json.dumps({
        "objects": cups, "cameras": [{"frame_index": 1, "position": [0, 0, 1]}]}))
    return tmp_path


@pytest.mark.parametrize("checkpoint", ["clean", "raw", "supplied", "unrecoverable", "corrupt", "missing_reference"])
def test_resumed_pass_applies_good_models_even_if_one_final_mesh_was_lost(two_cups, monkeypatch, checkpoint):
    if checkpoint == "supplied":
        source = box(two_cups / "models" / "Cup1.glb")
        monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(source.parent))
    run = Pass(two_cups)
    run.find()
    for item in run.items:
        folder = run.out / "rebuild" / item["id"]
        folder.mkdir(parents=True)
        final, reference = folder / "model.glb", folder / "reference.png"
        if checkpoint != "missing_reference" or item["id"] == "Cup0":
            Image.new("RGB", (4, 4), "red").save(reference)
        item.update(glb=str(final), reference=str(reference), material={},
                    views=[{"frame": 1, "detected": True}], decision={"decision": "trellis"})
        if item["id"] == "Cup0":
            box(final)
        elif checkpoint == "supplied":
            item["decision"]["source"] = str(source)
        elif checkpoint in ("clean", "corrupt", "missing_reference"):
            box(folder / "mesh.glb")
            item["fragments"] = {"pieces_after": 1}  # legacy state before clean_glb
            if checkpoint == "corrupt":
                final.write_bytes(b"truncated GLB")
        elif checkpoint == "raw":
            box(run.out / "rebuild" / "_trellis" / "glb" / "Cup1.glb")
    run.save()

    resumed = Pass(two_cups)
    applied = []

    def apply(_blend, request, _label):
        for entry in request["replace"]:
            assert rebuild.usable_mesh(Path(entry["glb"]))
            applied.append(entry["id"])
        folder = Path(request["out_dir"])
        folder.mkdir(parents=True)
        for name in ("Room.blend", "Room.glb", "room_layout.json"):
            (folder / name).write_bytes(b"room")

    def trellis(refs, *_args):
        assert checkpoint == "unrecoverable" and set(refs) == {"Cup1"}
        return {}

    def reference(item, _tiles, _description, folder):
        assert checkpoint == "missing_reference" and item["id"] == "Cup1"
        Image.new("RGB", (4, 4), "red").save(folder / "reference.png")

    monkeypatch.setattr("litereality_agent.pipeline.realism_authoring.small_objects.evidence.generator_inputs",
                        lambda *_: [])
    monkeypatch.setattr(rebuild, "make_reference", reference)
    monkeypatch.setattr(rebuild, "run_trellis", trellis)
    monkeypatch.setattr(resumed, "blender", apply)
    monkeypatch.setattr(resumed, "render_pairs", lambda *_args: None)
    resumed.run()
    assert applied == (["Cup0"] if checkpoint == "unrecoverable" else ["Cup0", "Cup1"])
    assert json.loads((run.out / "summary.json").read_text())["undone"] == (
        ["Cup1"] if checkpoint == "unrecoverable" else [])
    if checkpoint == "unrecoverable":
        assert resumed.items[1]["glb_error"] == "TRELLIS wrote no mesh"


def test_material_retry_resumes_from_persisted_clean_mesh(two_cups, monkeypatch):
    run = Pass(two_cups, only=["Cup0"])
    run.find()
    item = run.active()[0]
    reference = two_cups / "reference.png"
    Image.new("RGB", (4, 4), "red").save(reference)
    item.update(reference=str(reference), decision={"decision": "trellis"})

    def trellis(_references, work, _log):
        return {"Cup0": {"pipeline": "default", "glb": box(work / "glb" / "Cup0.glb")}}

    correct = rebuild.correct_material

    def interrupt(clean, *_args):
        saved = Pass(two_cups, only=["Cup0"]).active()[0]
        assert saved["clean_glb"] == str(clean) and clean.is_file()
        raise ValueError("material failed")

    monkeypatch.setattr(rebuild, "run_trellis", trellis)
    monkeypatch.setattr(rebuild, "correct_material", interrupt)
    run.rebuild()
    assert item["glb_error"] == "ValueError: material failed" and "glb" not in item
    monkeypatch.setattr(rebuild, "correct_material", correct)
    monkeypatch.setattr(rebuild, "run_trellis", lambda *_: pytest.fail("waited for the GPU"))
    monkeypatch.setattr(rebuild, "drop_fragments", lambda *_: pytest.fail("cleaned twice"))
    resumed = Pass(two_cups, only=["Cup0"])
    resumed.rebuild()
    done = resumed.active()[0]
    assert done["material"] and rebuild.usable_mesh(Path(done["glb"]))


def test_author_starts_with_usable_premades_and_keeps_old_room_copy(tmp_path, monkeypatch, capsys):
    room = tmp_path / "room"
    room.mkdir()
    source = box(tmp_path / "supplied" / "Bad.glb")
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(source.parent))
    ready.stage(room)
    old = (room / "Models" / "Bad.glb").read_bytes()
    source.write_bytes(b"invalid GLB")
    box(source.parent / "Good.glb")
    ready.stage(room)
    (room / "Models" / "Good.glb").write_bytes(b"broken room copy")
    briefs = []

    async def author(*args, brief, **_kwargs):
        briefs.append(brief)

    monkeypatch.setattr(entrypoint, "run", author)
    monkeypatch.setattr(entrypoint.scratch, "finish", lambda: None)
    monkeypatch.setattr(sys, "argv", ["author", "--room", str(room), "--surface-ref", str(tmp_path),
                                      "--scan", str(tmp_path)])
    with pytest.raises(SystemExit) as exited:
        entrypoint.main()
    assert exited.value.code == 0
    assert len(briefs) == 1 and "Models/Good.glb" in briefs[0] and "Models/Bad.glb" not in briefs[0]
    assert "scene.mark_small" in briefs[0] and "skipping Bad.glb:" in capsys.readouterr().err
    assert (room / "Models" / "Bad.glb").read_bytes() == old
    assert rebuild.usable_mesh(room / "Models" / "Good.glb")


@pytest.mark.parametrize("staged", [True, False], ids=["author", "standalone"])
def test_skipped_source_uses_photo_judgement_and_good_item_reaches_apply(two_cups, monkeypatch, staged):
    from litereality_agent import artifact_cache as cache

    models = two_cups / "models"
    bad, good = box(models / "Cup0.glb"), box(models / "Cup1.glb")
    room = two_cups / "room"
    room.mkdir()
    monkeypatch.setenv("LR_SMALL_OBJECTS_MODELS", str(models))
    sources = None
    if staged:
        ready.stage(room)
        old = (room / ready.FOLDER / bad.name).read_bytes()
        bad.write_bytes(b"broken GLB")
        assert [row["kind"] for row in ready.stage(room)] == ["Cup1"]
        assert (room / ready.FOLDER / bad.name).read_bytes() == old
        sources = room / ready.FOLDER / ready.SOURCES

    file_hash = cache.file_hash
    reads = []

    def read(path):
        if path in (bad, good):
            reads.append(path)
            if path == bad:
                assert not staged, "a source excluded by the author was opened again"
                raise PermissionError("read denied")
        return file_hash(path)

    monkeypatch.setattr(cache, "file_hash", read)
    run = Pass(two_cups, ready_sources=sources)
    run.find()
    for item in run.items:
        item["views"] = [{"frame": 1, "detected": True}]
    run.save()

    async def ask(images, _prompt, *, cwd, **kwargs):
        assert cwd.name == "Cup0" and images
        return '{"decision":"drop","reason":"blurred","description":"cup"}'

    def apply(_blend, request, _label):
        assert [i["id"] for i in request["drop"]] == ["Cup0"]
        [replacement] = request["replace"]
        assert replacement["id"] == "Cup1" and rebuild.usable_mesh(Path(replacement["glb"]))
        folder = Path(request["out_dir"])
        folder.mkdir(parents=True)
        for name in ("Room.blend", "Room.glb", "room_layout.json"):
            (folder / name).write_bytes(b"room")

    monkeypatch.setattr("litereality_agent.agent.providers.vision.ask_images", ask)
    monkeypatch.setattr(run, "render_pairs", lambda *_: None)
    monkeypatch.setattr(run, "blender", apply)
    run.run()
    assert run.items[0]["decision"]["reason"] == "blurred"
    assert json.loads((run.out / "summary.json").read_text())["undone"] == []
    assert reads.count(good) == 1 and reads.count(bad) == (0 if staged else 1)
