"""$LR_PROVIDED_MODELS: models the operator supplies are adopted once and rebuilt by nothing.

Every place below is one that used to regenerate or reject such a model: TRELLIS retires a GLB that
has no receipt, the procedural and openings passes rebuild a folder when forced, chair QC re-rolls
a chair it does not like, and the build poll traced whatever it found under its own method.
"""

from __future__ import annotations

import json
import os
import pickle
import time
from types import SimpleNamespace

import numpy as np
import pytest
import trimesh

from litereality_agent.models.object_generation import generate
from litereality_agent.pipeline.scene_init import paths as config
from litereality_agent.pipeline.scene_init.reconstruct import flow, provided
from litereality_agent.pipeline.scene_init.reconstruct.classify import classify_complexity
from litereality_agent.pipeline.scene_init.reconstruct.mesh_qc import chair_repair

SCAN = "provided-scan"
OLD = 1_500_000_000.0  # the earlier reconstruction's file times


def box_glb(path, extents):
    """A GLB box, extents in glTF axes (X width, Y up, Z depth), dated like an old model."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(trimesh.creation.box(extents=extents).export(file_type="glb"))
    os.utime(path, (OLD, OLD))
    return path


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    os.utime(path, (OLD, OLD))
    return path


def rows():
    trace = config.traces_dir(SCAN) / "trace.jsonl"
    return [json.loads(line) for line in trace.read_text().splitlines()] if trace.exists() else []


def adoptions():
    return [r for r in rows() if r["kind"] == "object_done" and r.get("method") == "provided"]


@pytest.fixture
def scan(tmp_path, monkeypatch):
    """A scan with objects, a chair cluster and a door, and a directory of models from an earlier
    reconstruction of the same room, under different ids there."""
    config.set_scan(SCAN)
    for name in ("Table0", "Sofa0", "Storage0"):
        write(config.object_refs_root() / SCAN / name / "reference_1024.png", name)
    write(config.opening_refs_root() / SCAN / "Wall1_Door_0" / "reference_1024.png", "door")
    chairs = config.chair_clusters_root() / SCAN
    write(chairs / "references" / "ChairCluster0.png", "chair")
    write(chairs / "chair_clusters.json", json.dumps(
        {"clusters": [{"cluster_id": "ChairCluster0", "members": ["Chair0"], "representative": "Chair0"}]}))
    scene_data = config.scene_data_dir(SCAN)
    scene_data.mkdir(parents=True)
    with (scene_data / "objects.pkl").open("wb") as f:  # RoomPlan boxes: bbox = [w, h, d]
        pickle.dump([{"mesh_id": "Table0", "bbox": np.array([1.6, 0.75, 0.8])},
                     {"mesh_id": "Sofa0", "bbox": np.array([2.0, 0.8, 0.9])},
                     {"mesh_id": "Chair0", "bbox": np.array([0.5, 0.9, 0.5])}], f)
    config.traces_dir(SCAN).mkdir(parents=True)

    src = tmp_path / "earlier"
    box_glb(src / "Sofa0.glb", [2.0, 0.8, 0.9])
    box_glb(src / "ChairCluster0.glb", [0.5, 0.9, 0.5])
    folder = src / "Storage0"  # the procedural folder of what was Storage2 last time
    box_glb(folder / "Storage2.glb", [1.0, 2.0, 0.5])
    write(folder / "object.py", '"""Storage2 cabinet."""\n'
          "OUT_GLB = _argv[1] if len(_argv) > 1 else os.path.join(HERE, 'Storage2.glb')\n"
          "TEX = os.path.join(TEXDIR, 'Storage2_oak.png')\n")
    write(folder / "object.md", "# Storage2\n\nA two-door cabinet. Storage20 is another one.\n")
    write(folder / "textures" / "Storage2_oak.png", "oak")
    write(folder / "previews" / "preview_front.png", "front")
    write(folder / "sim" / "Storage2.physics.json", "{}")
    door = src / "Wall1_Door_0"
    box_glb(door / "Wall3_Door_0.glb", [0.9, 2.0, 0.1])
    write(door / "object.py", "OUT = 'Wall3_Door_0.glb'\n")
    write(door / "object.md", "# Wall3_Door_0\n")
    monkeypatch.setenv("LR_PROVIDED_MODELS", str(src))
    monkeypatch.delenv("LR_PROVIDED_TURN", raising=False)
    return src


def test_models_are_adopted_under_this_scans_ids_with_fresh_times(scan):
    before = time.time() - 1
    adopted = provided.adopt(SCAN)
    recon = config.reconstruct_dir(SCAN)
    assert set(adopted) == {"Sofa0", "ChairCluster0", "Storage0", "Wall1_Door_0"}
    assert (recon / "Sofa0.glb").read_bytes() == (scan / "Sofa0.glb").read_bytes()
    folder = recon / "Storage0"
    assert sorted(str(p.relative_to(folder)) for p in folder.rglob("*") if p.is_file()) == [
        "Storage0.glb", "object.md", "object.py", "previews/preview_front.png",
        "textures/Storage2_oak.png"]  # no stale sim/ under the old id: the physics compile redoes it
    assert "'Storage0.glb'" in (folder / "object.py").read_text()
    assert "'Storage2_oak.png'" in (folder / "object.py").read_text()  # textures keep their names
    assert (folder / "object.md").read_text().startswith("# Storage0\n")
    assert "Storage20" in (folder / "object.md").read_text()
    assert (recon / "Wall1_Door_0" / "Wall1_Door_0.glb").is_file()
    assert all(p.stat().st_mtime >= before for p in recon.rglob("*") if p.is_file())
    from litereality_agent.pipeline.scene_init import flow as scene_flow

    assert all(scene_flow._asset_is_built(recon, name) for name in adopted)

    record = json.loads((recon / "provided.json").read_text())
    assert record["models"]["Storage0"]["source"] == str(scan / "Storage0")
    done = {r["name"]: r for r in adoptions()}
    assert set(done) == set(adopted)
    assert all(r["reused"] is True and r["status"] == "ok" and r["t"] >= before for r in done.values())
    assert done["Sofa0"]["source"] == str(scan / "Sofa0.glb")


def test_a_rerun_copies_nothing_unchanged_and_replaces_what_changed(scan):
    provided.adopt(SCAN)
    recon = config.reconstruct_dir(SCAN)
    times = {p: p.stat().st_mtime_ns for p in recon.rglob("*") if p.is_file() and ".stale" not in p.parts}
    provided.adopt(SCAN)
    assert {p: p.stat().st_mtime_ns for p in times} == times and len(adoptions()) == 4

    box_glb(scan / "Sofa0.glb", [2.1, 0.8, 0.9])
    provided.adopt(SCAN)
    assert (recon / "Sofa0.glb").read_bytes() == (scan / "Sofa0.glb").read_bytes()
    assert any((recon / ".stale").rglob("Sofa0.glb"))  # the old copy is kept, not deleted
    assert [r["name"] for r in adoptions()].count("Sofa0") == 2 and len(adoptions()) == 5


def test_unknown_names_are_rejected_with_the_valid_ones(scan):
    box_glb(scan / "Tabel0.glb", [1, 1, 1])
    with pytest.raises(ValueError, match=r"Tabel0 not in scan .*valid names: ChairCluster0, Sofa0, "
                                         r"Storage0, Table0, Wall1_Door_0"):
        provided.adopt(SCAN)


def test_a_relative_directory_or_a_bad_turn_is_rejected(scan, monkeypatch):
    monkeypatch.setenv("LR_PROVIDED_MODELS", "earlier")
    with pytest.raises(ValueError, match="absolute"):
        provided.find(SCAN)
    monkeypatch.setenv("LR_PROVIDED_MODELS", str(scan))
    monkeypatch.setenv("LR_PROVIDED_TURN", "Storage0=90")
    with pytest.raises(ValueError, match="procedural folder"):
        provided.adopt(SCAN)
    monkeypatch.setenv("LR_PROVIDED_TURN", "Table0=90")
    with pytest.raises(ValueError, match="not a provided model"):
        provided.adopt(SCAN)


def test_a_model_turned_against_its_box_is_warned_about_and_can_be_turned(scan, monkeypatch, capsys):
    # Last time the table stood the other way round: long side along Z, the new box is long in X.
    box_glb(scan / "Table0.glb", [0.8, 0.75, 1.6])
    provided.adopt(SCAN)
    out = capsys.readouterr().out
    assert "WARNING Table0" in out and "LR_PROVIDED_TURN=Table0=90" in out
    assert "Sofa0" not in out.split("WARNING", 1)[1].split("\n")[0]
    recon = config.reconstruct_dir(SCAN)
    assert "warning" in json.loads((recon / "provided.json").read_text())["models"]["Table0"]

    monkeypatch.setenv("LR_PROVIDED_TURN", "Table0=90")
    provided.adopt(SCAN)
    assert "WARNING" not in capsys.readouterr().out
    x, _, z = provided.extents(recon / "Table0.glb")
    assert (round(x, 3), round(z, 3)) == (1.6, 0.8)
    # trimesh, which the physics compile loads models with, sees the same turn.
    x, _, z = trimesh.load(str(recon / "Table0.glb"), force="scene").extents
    assert (round(x, 3), round(z, 3)) == (1.6, 0.8)
    # Only the node tree changed: the mesh data is byte for byte the provided model's.
    turned, source = (recon / "Table0.glb").read_bytes(), (scan / "Table0.glb").read_bytes()
    assert turned.endswith(provided._split(source)[1])
    assert provided._split(turned)[0]["nodes"][-1]["name"] == "provided_turn"
    assert json.loads((recon / "provided.json").read_text())["models"]["Table0"]["turn"] == 90


def test_provided_names_are_routed_provided_without_asking_the_classifier(scan, monkeypatch):
    asked = []
    monkeypatch.setattr(classify_complexity.classification, "classify_image",
                        lambda ref, *a, **k: asked.append(ref.parent.name) or {
                            "route": "trellis", "complexity": "high", "is_organic": False,
                            "primitive_buildable": False, "reason": "t"})
    got = {r["name"]: r["route"] for r in classify_complexity.classify_for_scan(SCAN)["records"]}
    assert got == {"Sofa0": "provided", "Storage0": "provided", "ChairCluster0": "provided",
                   "Table0": "trellis"}
    assert asked == ["Table0"]


def test_trellis_never_receives_a_provided_model(scan):
    provided.adopt(SCAN)
    names = lambda: [aid for aid, _ in flow.collect_references(SCAN)]  # noqa: E731
    assert names() == ["Table0"]  # no routing at all: the fallback takes everything else
    routing = config.work_root() / "routing"
    routing.mkdir(parents=True)
    (routing / "routing_manifest.json").write_text(json.dumps({"scans": {SCAN: [
        {"name": n, "route": "trellis"} for n in ("Table0", "Sofa0", "ChairCluster0")]}}))
    assert names() == ["Table0"]  # even a stale manifest routing them to TRELLIS


def test_procedural_and_opening_jobs_skip_provided_folders(scan):
    provided.adopt(SCAN)
    work, out = config.work_root(), config.reconstruct_dir(SCAN)
    routing = work / "routing"
    routing.mkdir(parents=True)
    (routing / "routing_manifest.json").write_text(json.dumps({"scans": {SCAN: [
        {"name": n, "route": "procedural", "category": "storage",
         "reference": str(config.object_refs_root() / SCAN / n / "reference_1024.png")}
        for n in ("Storage0", "Table0")]}}))
    # Job collection does not look at --skip-existing, so this holds for a forced run as well.
    assert [j.name for j in generate.collect_jobs(work, [SCAN], None, out)] == ["Table0"]
    assert generate.collect_opening_jobs(work, [SCAN], None, out) == []


def test_chair_qc_leaves_a_provided_chair_alone(scan, monkeypatch):
    provided.adopt(SCAN)
    monkeypatch.setattr(chair_repair, "_qa", lambda *a: {"status": "fail", "flags": ["blob"]})

    def regenerate(*_a, **_k):
        raise AssertionError("a provided chair was re-rolled")

    monkeypatch.setattr(chair_repair.chair_clusters, "generate_for_cluster", regenerate)
    report = chair_repair.repair_scan(SCAN)
    assert report["chairs"] == []


def test_the_physics_compile_and_the_pack_take_adopted_models_like_any_other(scan, monkeypatch):
    from litereality_agent.models.object_generation.sim import pipeline as sim
    from litereality_agent.room_ops.compile import pack_assets

    provided.adopt(SCAN)
    recon = config.reconstruct_dir(SCAN)
    compiled = []
    monkeypatch.setattr(sim, "compile_object",
                        lambda glb, **_k: compiled.append(glb.name) or {"status": "ok"})
    sim.compile_directory(recon)
    assert sorted(compiled) == ["ChairCluster0.glb", "Sofa0.glb", "Storage0.glb", "Wall1_Door_0.glb"]

    monkeypatch.setattr(pack_assets.config, "reconstruct_dir", lambda _scan: recon)
    monkeypatch.setattr(pack_assets, "cluster_members", lambda _scan: {"ChairCluster0": ["Chair0"]})
    out = recon.parent / "packed"
    out.mkdir()
    packed = {e["object"]: (e["source"], e["maps_to_prim"]) for e in pack_assets.from_scan(SCAN, out)}
    assert packed == {"Storage0": ("procedural", "Storage0"), "Wall1_Door_0": ("procedural", "Door0"),
                      "Sofa0": ("TRELLIS", "Sofa0"), "ChairCluster0": ("TRELLIS", "Chair0")}


@pytest.mark.parametrize("force", [False, True])
def test_the_reconstruction_phase_adopts_first_and_traces_each_model_once(scan, monkeypatch, force):
    from litereality_agent.pipeline.scene_init import flow as scene_flow

    seen = {}

    def trellis(*_a, **kw):
        seen["trellis"] = (kw["skip_existing"], provided.adopted(config.reconstruct_dir(SCAN)))
        return {"generated": 0}

    monkeypatch.setattr(scene_flow.reconstruct, "run_for_scan", trellis)
    monkeypatch.setattr(scene_flow.reconstruct, "run_procedural_for_scan", lambda *a, **kw: {"generated": 0})
    monkeypatch.setattr(scene_flow, "branch_concurrency", lambda n, c: 1)
    monkeypatch.delenv("LR_SEQUENTIAL", raising=False)
    routing = config.work_root() / "routing"
    routing.mkdir(parents=True)
    (routing / "routing_manifest.json").write_text(json.dumps({"scans": {SCAN: [
        {"name": "Table0", "route": "trellis"}, {"name": "Sofa0", "route": "provided"},
        {"name": "Storage0", "route": "provided"}, {"name": "ChairCluster0", "route": "provided"}]}}))
    args = SimpleNamespace(reconstruct=True, chair_qc=False, procedural=True, build_openings=True,
                           trellis_python=None, seed=42, decimation=50000, texture_size=1024,
                           force_reconstruct=force, dry_run_reconstruct=False, concurrency=1,
                           procedural_python=None, blender_path=None, retries=0, budget=0,
                           agent_model=None)
    result = {}
    for _ in range(2):  # a rerun, forced or not, adds nothing
        scene_flow._reconstruction_phase(SCAN, args, result, full=False)
    assert "error" not in result["reconstruct"], result
    assert seen["trellis"] == (not force, {"Sofa0", "Storage0", "ChairCluster0", "Wall1_Door_0"})
    assert result["provided"] == ["ChairCluster0", "Sofa0", "Storage0", "Wall1_Door_0"]
    done = [r for r in rows() if r["kind"] == "object_done"]
    assert sorted((r["name"], r["method"]) for r in done) == [
        ("ChairCluster0", "provided"), ("Sofa0", "provided"), ("Storage0", "provided"),
        ("Wall1_Door_0", "provided")]


def test_an_ingest_run_with_the_same_settings_adopts_nothing(scan, monkeypatch, tmp_path):
    """Every phase gets the same --set, and at ingest the directory may not even exist yet."""
    from litereality_agent.pipeline.scene_init import flow as scene_flow

    monkeypatch.setenv("LR_PROVIDED_MODELS", str(tmp_path / "not-prepared-yet"))
    monkeypatch.setenv("LR_SEQUENTIAL", "1")
    args = SimpleNamespace(reconstruct=False, chair_qc=False, procedural=False, build_openings=False,
                           concurrency=0)
    result = {}
    scene_flow._reconstruction_phase(SCAN, args, result, full=False)
    assert "provided" not in result and not config.reconstruct_dir(SCAN).exists()
