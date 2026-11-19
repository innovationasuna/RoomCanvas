"""Regression coverage for stale expensive artifacts and coherent author recovery."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from litereality_agent import artifact_cache as cache


def overwrite_preserving_metadata(path, data):
    stat = path.stat()
    path.write_bytes(data)
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))


def test_local_trellis_invalidates_on_content_parameters_and_force(tmp_path, monkeypatch):
    from litereality_agent.models.trellis.service import LocalTrellisService

    launcher = tmp_path / "launcher.py"
    launcher.write_text("# test")
    ref = tmp_path / "input.png"
    ref.write_bytes(b"first")
    calls = []

    def run(cmd):
        calls.append(cmd)
        target = Path(cmd[cmd.index("-o") + 1])
        target.mkdir()
        (target / "Chair.glb").write_bytes(b"fresh")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr("litereality_agent.models.trellis.service.subprocess.run", run)
    service = LocalTrellisService(python=sys.executable, launcher=str(launcher))
    opts = dict(out_dir=str(tmp_path / "out"), seed=9, decimation=1234, texture_size=512)
    service.reconstruct_many({"Chair": ref}, **opts)
    service.reconstruct_many({"Chair": ref}, **opts)
    assert len(calls) == 1
    overwrite_preserving_metadata(ref, b"other")
    service.reconstruct_many({"Chair": ref}, **opts)
    assert len(calls) == 2
    service.reconstruct_many({"Chair": ref}, **{**opts, "seed": 10})
    service.reconstruct_many({"Chair": ref}, **opts, skip_existing=False)
    assert len(calls) == 4
    assert "--skip-existing" not in calls[-1]
    assert calls[-1][calls[-1].index("--decimation") + 1] == "1234"
    assert calls[-1][calls[-1].index("--texture-size") + 1] == "512"

    monkeypatch.setattr("litereality_agent.models.trellis.service.subprocess.run",
                        lambda cmd: SimpleNamespace(returncode=1))
    assert service.reconstruct_many({"Chair": ref}, **opts, skip_existing=False) == {"Chair": ""}
    assert not (tmp_path / "out" / "Chair.glb").exists()
    assert list((tmp_path / "out" / ".stale").glob("*/Chair.glb"))


def test_inference_reports_failure_and_quarantines_partial_or_old_output(tmp_path, monkeypatch):
    from litereality_agent.models.trellis import inference

    image, output = tmp_path / "Chair.png", tmp_path / "Chair.glb"
    image.write_bytes(b"ref")
    output.write_bytes(b"old")
    monkeypatch.setattr(sys, "argv", ["trellis", "-i", str(image), "-o", str(output)])
    monkeypatch.setattr(inference, "load_pipeline", lambda *a, **k: object())
    monkeypatch.setattr(inference, "prepare_local_model", lambda model: model)

    def fail(*args, **kwargs):
        output.write_bytes(b"partial")
        raise RuntimeError("GPU failure")

    monkeypatch.setattr(inference, "generate", fail)
    assert inference.main() == 1
    assert not output.exists()


def test_parallel_shard_membership_is_stable_when_other_outputs_are_cached(tmp_path, monkeypatch):
    from litereality_agent.models.trellis import inference

    inputs, outputs = tmp_path / "inputs", tmp_path / "outputs"
    inputs.mkdir()
    for name in "ABCD":
        (inputs / f"{name}.png").write_bytes(b"old")
    calls = []
    monkeypatch.setattr(inference, "load_pipeline", lambda *a, **k: object())
    monkeypatch.setattr(inference, "prepare_local_model", lambda model: model)
    monkeypatch.setattr(inference, "_install_stdout_prefix", lambda prefix: None)

    def generate(_pipeline, image, output, **kwargs):
        calls.append(image.stem)
        output.write_bytes(b"mesh")

    monkeypatch.setattr(inference, "generate", generate)
    argv = ["trellis", "-i", str(inputs), "-o", str(outputs), "--skip-existing"]
    monkeypatch.setattr(sys, "argv", argv)
    assert inference.main() == 0
    calls.clear()
    for name in "BC":
        overwrite_preserving_metadata(inputs / f"{name}.png", b"new")
    monkeypatch.setattr(sys, "argv", [*argv, "--_shard", "1/2"])
    assert inference.main() == 0
    assert calls == ["B"], "a cache miss must not move C from shard zero to shard one"


def test_cli_reconstruction_options_reach_stage_command(tmp_path, monkeypatch):
    from litereality_agent import cli
    from litereality_agent.pipeline.context import RunContext
    from litereality_agent.pipeline.scene_init import reconstruct
    from litereality_agent.settings import LiteRealitySettings

    args = cli._parser().parse_args(["stage", "reconstruct", "scan", "--seed", "7",
                                    "--decimation", "123", "--texture-size", "512", "--force"])
    opts = {**cli._reconstruct_options(args), "force": args.force}
    commands = []
    monkeypatch.setattr(reconstruct, "run_module",
                        lambda ctx, module, cmd, **kw: (commands.append(cmd) or 0, None))
    settings = LiteRealitySettings(_env_file=None, repo_root=tmp_path)
    reconstruct.run(RunContext("scan", tmp_path, tmp_path, tmp_path, settings=settings), opts)
    cmd = commands[0]
    assert "--force-reconstruct" in cmd
    assert cmd[cmd.index("--seed") + 1] == 7
    assert cmd[cmd.index("--decimation") + 1] == 123
    assert cmd[cmd.index("--texture-size") + 1] == 512


def test_modal_decimation_and_force_are_effective_and_failure_hides_old_output(tmp_path):
    from litereality_agent.models.trellis.modal import ModalTrellisService

    class Client:
        fail = False
        calls = []

        def map(self, payloads):
            self.calls.append(payloads)
            return [{"error": "generation failed"} if self.fail else
                    {"glb_b64": base64.b64encode(b"glb").decode()}]

    client = Client()
    service = ModalTrellisService(app_name="test", client=client)
    opts = dict(out_dir=str(tmp_path), decimation=12345)
    service.reconstruct_many({"Chair": b"image"}, **opts)
    service.reconstruct_many({"Chair": b"image"}, **opts)
    assert len(client.calls) == 1
    assert client.calls[0][0]["decimation"] == 12345
    client.fail = True
    assert service.reconstruct_many({"Chair": b"image"}, **opts, skip_existing=False) == {"Chair": ""}
    assert not (tmp_path / "Chair.glb").exists()


def scene(tmp_path):
    paths = {"capture": "capture", "authoring_preview": "preview", "authoring": "authoring",
             "authoring_room": "room"}
    (tmp_path / "scene.json").write_text(json.dumps({"paths": paths}))
    (tmp_path / "preview").mkdir()
    (tmp_path / "preview" / "room_layout.json").write_text('{"cameras": [], "objects": []}')
    for name in ("Room.blend", "Room.glb"):
        (tmp_path / "preview" / name).write_bytes(b"old")
    return tmp_path


@pytest.mark.parametrize("module", ["articulate", "small_objects"])
def test_pass_invalidation_reaches_all_substages_despite_same_mtime(tmp_path, module):
    import importlib

    Pass = importlib.import_module(f"litereality_agent.pipeline.realism_authoring.{module}.run").Pass
    run = Pass(scene(tmp_path))
    run.items = [{"id": "old", "box": {}, "plan": {}, "check": {}}]
    run.save()
    for name in ("views", "draft", "check", "rebuild", "room_preview"):
        (run.out / name).mkdir()
        (run.out / name / "artifact").write_bytes(b"stale")
    assert Pass(tmp_path).items == run.items
    overwrite_preserving_metadata(tmp_path / "preview" / "Room.blend", b"new")
    resumed = Pass(tmp_path)
    assert resumed.items is None
    assert not any((run.out / name).exists() for name in
                   ("views", "draft", "check", "rebuild", "room_preview"))
    assert list((run.out / ".stale").glob("*/items.json"))


def test_small_objects_rebuilds_legacy_planless_bundle_and_failed_apply_cannot_publish(tmp_path, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.small_objects.run import Pass

    run = Pass(scene(tmp_path))
    run.items = []
    final = run.out / "room_preview"
    final.mkdir()
    (final / "Room.blend").write_bytes(b"old")
    calls = []

    def apply(_blend, request, _name):
        calls.append(request)
        folder = Path(request["out_dir"])
        folder.mkdir()
        for name in ("Room.blend", "Room.glb", "room_layout.json"):
            (folder / name).write_bytes(b"new")

    monkeypatch.setattr(run, "blender", apply)
    monkeypatch.setattr(run, "render_pairs", lambda *args: None)
    run.apply()
    run.apply()
    assert len(calls) == 1
    overwrite_preserving_metadata(final / "Room.glb", b"bad")

    def fail(*args):
        final.mkdir()
        (final / "Room.blend").write_bytes(b"partial")
        raise RuntimeError("build failed")

    monkeypatch.setattr(run, "blender", fail)
    with pytest.raises(RuntimeError, match="build failed"):
        run.apply()
    assert not final.exists()


def test_articulation_summary_distinguishes_existing_joints_from_added(tmp_path, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.articulate.run import Pass

    run = Pass(scene(tmp_path))
    run.items = [{"id": "Desk0", "category": "desk", "existing": ["top_hinge"],
                  "plan": {"parts": [], "reason": "already articulated"}}]
    monkeypatch.setattr(run, "overview", lambda: None)
    run.summarize()
    summary = cache.read_json(run.out / "summary.json")
    assert summary["existing"] == 1
    assert summary["added"] == 0
    assert summary["candidates"] == 1
    assert summary["zero_added_reason"]
    assert summary["units"]["existing"] == "joints"


def test_stage_input_fingerprint_checks_content_with_preserved_timestamps(tmp_path):
    from litereality_agent.pipeline.context import RunContext
    from litereality_agent.pipeline.fingerprint import input_fingerprint
    from litereality_agent.settings import LiteRealitySettings

    capture = tmp_path / "capture"
    capture.mkdir()
    image = capture / "frame_00001.jpg"
    image.write_bytes(b"old")
    settings = LiteRealitySettings(_env_file=None, repo_root=tmp_path)
    context = RunContext("scan", capture, tmp_path / "scene", tmp_path, settings=settings)
    first = input_fingerprint(context, "ingest", {})
    overwrite_preserving_metadata(image, b"new")
    assert input_fingerprint(context, "ingest", {}) != first


def test_stage_input_fingerprint_ignores_own_outputs_job_location_and_unused_settings(tmp_path):
    import shutil

    from litereality_agent.pipeline.context import RunContext
    from litereality_agent.pipeline.fingerprint import input_fingerprint
    from litereality_agent.settings import LiteRealitySettings

    def context(root, **settings):
        values = LiteRealitySettings(_env_file=None, repo_root=root, **settings)
        return RunContext("scan", root / "capture", root / "run" / "scan", root / "run", settings=values)

    job = context(tmp_path / "job")
    job.capture_dir.mkdir(parents=True)
    (job.capture_dir / "room.usdz").write_bytes(b"scan")
    job.seed_room.mkdir(parents=True)
    (job.seed_room / "Room.py").write_text("seed = 1")
    first = input_fingerprint(job, "author", {})
    (job.authoring_root / "surface_ref").mkdir(parents=True)
    (job.authoring_root / "surface_ref" / "surface_ref_manifest.json").write_text("{}")
    assert input_fingerprint(job, "author", {}) == first
    shutil.copytree(tmp_path / "job", tmp_path / "moved")
    assert input_fingerprint(context(tmp_path / "moved"), "author", {}) == first
    ingest = input_fingerprint(job, "ingest", {})
    assert input_fingerprint(context(tmp_path / "job", codex_model="other"), "ingest", {}) == ingest
    assert input_fingerprint(context(tmp_path / "job", codex_model="other"), "author", {}) != first


def test_reconstruct_fingerprint_covers_chair_references_and_the_procedural_agent(tmp_path):
    from litereality_agent.pipeline.context import RunContext
    from litereality_agent.pipeline.fingerprint import input_fingerprint
    from litereality_agent.settings import LiteRealitySettings

    def context(**settings):
        values = LiteRealitySettings(_env_file=None, repo_root=tmp_path, **settings)
        return RunContext("scan", tmp_path / "capture", tmp_path / "run/scan", tmp_path / "run", settings=values)

    chairs = context().object_root / "object_init/chair_clusters/scan"
    (chairs / "references").mkdir(parents=True)
    (chairs / "references/ChairCluster0.png").write_bytes(b"first")
    first = input_fingerprint(context(), "reconstruct", {})
    (chairs / "references/ChairCluster0.png").write_bytes(b"second")
    assert input_fingerprint(context(), "reconstruct", {}) != first
    second = input_fingerprint(context(), "reconstruct", {})
    assert input_fingerprint(context(codex_model="other"), "reconstruct", {}) != second


def test_author_checkpoint_restores_matching_source_and_resources(tmp_path):
    from litereality_agent.agent import author_checkpoint as checkpoint

    room = tmp_path / "room"
    (room / "materials").mkdir(parents=True)
    (room / "Room.py").write_text("TEXTURE = 'materials/a.png'\n")
    (room / "textures.json").write_text('{"a": 1}')
    (room / "materials" / "a.png").write_bytes(b"old")
    last_good = tmp_path / ".room_checkpoint.py"
    assert checkpoint.save(room, last_good)
    (room / "Room.py").write_text("TEXTURE = 'materials/b.png'\n")
    assert not checkpoint.save(room, last_good), "a missing resource must not become last-known-good"
    (room / "Room.py").write_text("def broken(:")
    (room / "materials" / "a.png").write_bytes(b"new")
    (room / "textures.json").write_text('{"a": 2}')
    assert checkpoint.restore(room, last_good)
    assert (room / "Room.py").read_text() == "TEXTURE = 'materials/a.png'\n"
    assert (room / "materials" / "a.png").read_bytes() == b"old"
    assert json.loads((room / "textures.json").read_text()) == {"a": 1}


def test_an_unresolved_path_literal_holds_back_a_checkpoint_but_never_restores_over_the_room(tmp_path):
    from litereality_agent.agent import author_checkpoint as checkpoint

    room = tmp_path / "room"
    room.mkdir()
    last_good = tmp_path / ".room_checkpoint.py"
    (room / "Room.py").write_text("x = 1\n")
    assert checkpoint.save(room, last_good)
    (room / "Room.py").write_text("import glob\nTEX = glob.glob('materials/*.jpg')\n")
    assert checkpoint.save(room, last_good), "a glob pattern is not a missing file"
    (room / "Room.py").write_text("OUT = 'textures/baked_preview.png'\n")
    assert not checkpoint.save(room, last_good)
    assert checkpoint.source_error(room) == "", "valid sources must not be replaced by the checkpoint"


def test_broken_checkpoint_blob_never_partially_restores_room(tmp_path):
    from litereality_agent.agent import author_checkpoint as checkpoint

    room = tmp_path / "room"
    room.mkdir()
    (room / "Room.py").write_text("x = 1\n")
    last_good = tmp_path / ".room_checkpoint.py"
    assert checkpoint.save(room, last_good)
    manifest = cache.read_json(last_good.with_suffix(".d") / "manifest.json")
    (last_good.with_suffix(".d") / "blobs" / manifest["files"]["Room.py"]).write_bytes(b"corrupt")
    (room / "Room.py").write_text("broken(")
    assert checkpoint.restore(room, last_good) is False
    assert (room / "Room.py").read_text() == "broken("


def test_interrupted_multifile_restore_cannot_replace_last_good_manifest(tmp_path, monkeypatch):
    from litereality_agent.agent import author_checkpoint as checkpoint

    room = tmp_path / "room"
    room.mkdir()
    (room / "Room.py").write_text("x = 1\n")
    (room / "textures.json").write_text('{"old": true}')
    last_good = tmp_path / ".room_checkpoint.py"
    assert checkpoint.save(room, last_good)
    (room / "Room.py").write_text("x = 2\n")
    (room / "textures.json").write_text('{"new": true}')
    copyfile = checkpoint.shutil.copyfile

    def fail_one_blob(source, target):
        if Path(source).parent.name == "blobs" and Path(target).name == "textures.json":
            raise OSError("interrupted copy")
        return copyfile(source, target)

    monkeypatch.setattr(checkpoint.shutil, "copyfile", fail_one_blob)
    with pytest.raises(OSError, match="interrupted copy"):
        checkpoint.restore(room, last_good)
    assert checkpoint.save(room, last_good) is False
    monkeypatch.setattr(checkpoint.shutil, "copyfile", copyfile)
    assert checkpoint.restore(room, last_good)
    assert json.loads((room / "textures.json").read_text()) == {"old": True}
    assert not (tmp_path / ".author_restore_pending.json").exists()


def test_resumed_author_receives_saved_summary_and_detects_changed_evidence(tmp_path, monkeypatch):
    from litereality_agent.agent import author, providers

    room, refs, scan = tmp_path / "work" / "room", tmp_path / "refs", tmp_path / "scan"
    for folder in (room, refs, scan):
        folder.mkdir(parents=True)
    (room / "Room.py").write_text("x = 1\n")
    photo = scan / "frame_00001.jpg"
    photo.write_bytes(b"old")
    prompts = []

    class Harness:
        name = "test"
        supports = set()

        def effective_model(self, spec):
            return spec.model

        async def run(self, spec):
            prompts.append(spec.prompt)
            yield providers.SessionResult(result="Floor saved; walls pending", stopped="step budget")

    monkeypatch.setattr(providers, "resolve", lambda *args: Harness())
    monkeypatch.setattr(author, "surfaces_for", lambda *args: [])
    monkeypatch.setattr("litereality_agent.agent.scratch.bind", lambda **kwargs: None)
    monkeypatch.setattr("litereality_agent.agent.scratch.prompt_line", lambda: "")
    asyncio.run(author.run(room, refs, scan, "test", 1))
    saved = cache.read_json(room.parent / ".author_resume.json")
    assert saved["status"] == "incomplete"
    assert saved["pending"] and saved["last_valid_output"]
    assert saved["summary"] == "Floor saved; walls pending"
    overwrite_preserving_metadata(photo, b"new")
    asyncio.run(author.run(room, refs, scan, "test", 1))
    assert ".author_resume.json" in prompts[1]
    assert "inputs or configuration changed" in prompts[1]
    assert list((room.parent / ".stale").glob("*/.room_checkpoint.d")), "old-input checkpoint is retired"


def test_refine_poses_share_one_content_verified_compile(tmp_path, monkeypatch):
    from litereality_agent.pipeline.realism_authoring.author import refine_objects as refine

    (tmp_path / "object.py").write_text("x = 1\n")
    calls = []

    def run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[3].endswith("object.py"):
            Path(cmd[-1]).write_bytes(b"mesh")
        else:
            folder = Path(cmd[-3])
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "view_0.png").write_bytes(b"image")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(refine.subprocess, "run", run)
    assert refine._snapshot_views(tmp_path, "blender", tmp_path / "_closed")
    assert refine._snapshot_views(tmp_path, "blender", tmp_path / "_open", 1.0)
    assert sum(cmd[3].endswith("object.py") for cmd in calls) == 1
    overwrite_preserving_metadata(tmp_path / "object.py", b"x = 2\n")
    assert refine._snapshot_views(tmp_path, "blender", tmp_path / "_after")
    assert sum(cmd[3].endswith("object.py") for cmd in calls) == 2


def test_refine_snapshot_does_not_block_other_async_sessions(tmp_path, monkeypatch):
    from PIL import Image

    from litereality_agent.agent import providers
    from litereality_agent.pipeline.realism_authoring.author import refine_objects as refine

    obj = tmp_path / "room" / "Objects" / "Procedural" / "Chair0"
    obj.mkdir(parents=True)
    (obj / "object.py").write_text("x = 1\n")
    selected = tmp_path / "refs" / "Chair0" / "images"
    selected.mkdir(parents=True)
    (selected / "frame_00001.jpg").write_bytes(b"selected")
    scan = tmp_path / "scan"
    scan.mkdir()
    Image.new("RGB", (2, 2)).save(scan / "frame_00001.jpg")

    class Harness:
        name = "test"
        supports = {"inproc_tools"}

        async def run(self, spec):
            yield providers.SessionResult(result="done")

    monkeypatch.setattr(providers, "resolve", lambda *args: Harness())
    monkeypatch.setattr(refine, "build_server", lambda *args: (object(), []))
    monkeypatch.setattr(refine, "RESULTS", tmp_path / "results")
    monkeypatch.setattr(refine, "_SEM", asyncio.Semaphore(1))
    started = False
    ticks_during_snapshot = []

    def snapshot(_obj, _blender, views, **kwargs):
        nonlocal started
        started = True
        views.mkdir(parents=True, exist_ok=True)
        time.sleep(0.08)
        started = False
        return False

    monkeypatch.setattr(refine, "_snapshot_views", snapshot)

    async def exercise():
        task = asyncio.create_task(refine.refine_one(
            "Chair0", tmp_path / "room", tmp_path / "refs", scan, "blender", "test", 1, {}))
        while not task.done():
            await asyncio.sleep(0.005)
            if started:
                ticks_during_snapshot.append(True)
        await task

    asyncio.run(exercise())
    assert ticks_during_snapshot


def test_cancelled_background_render_terminates_its_child(tmp_path):
    from litereality_agent.pipeline.realism_authoring.author import refine_objects as refine

    ready = tmp_path / "ready"
    cmd = [sys.executable, "-c", "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(30)",
           str(ready)]

    async def exercise():
        task = asyncio.create_task(refine._background_render(refine._run_blender, cmd))
        for _ in range(200):
            if ready.exists():
                break
            await asyncio.sleep(0.01)
        assert ready.exists()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=3)

    asyncio.run(exercise())


def test_simulate_fingerprint_uses_selected_source_and_ignores_viewer_cache(tmp_path):
    from litereality_agent.pipeline.context import RunContext
    from litereality_agent.pipeline.fingerprint import input_fingerprint
    from litereality_agent.settings import LiteRealitySettings

    settings = LiteRealitySettings(_env_file=None, repo_root=tmp_path)
    context = RunContext("scan", tmp_path, tmp_path / "scene", tmp_path, settings=settings)
    context.seed_room.mkdir(parents=True)
    context.authored_room.mkdir(parents=True)
    context.preview_dir.mkdir()
    (context.seed_room / "Room.py").write_text("seed = 1")
    (context.authored_room / "Room.py").write_text("author = 1")
    first = input_fingerprint(context, "simulate", {"from_seed": True})
    normal = input_fingerprint(context, "simulate", {})
    (context.preview_dir / "Room.web.glb").write_bytes(b"viewer-only")
    (context.preview_dir / "bake.log").write_text("new log")
    assert input_fingerprint(context, "simulate", {}) == normal
    (context.authored_room / "Room.py").write_text("author = 2")
    assert input_fingerprint(context, "simulate", {"from_seed": True}) == first
    (context.seed_room / "Room.py").write_text("seed = 2")
    assert input_fingerprint(context, "simulate", {"from_seed": True}) != first
