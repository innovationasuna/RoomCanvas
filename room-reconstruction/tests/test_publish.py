"""Publishing: the room and the real-vs-render comparison.

Blender is never spawned here — `run_module` and the Blender process are stubbed, so what is exercised is
the order the stage does things in and what survives each part failing.

The web copy `view` serves is deliberately NOT part of this: it is made on first view, and the
tests that it is live beside the viewer in `test_walk_viewer.py`.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.result import StageStatus
from litereality_agent.pipeline.room_qc import publish


@pytest.fixture
def scene(tmp_path: Path) -> Path:
    scene = tmp_path / "run" / "Scan-1"
    (scene / "realism_authoring" / "room").mkdir(parents=True)
    (scene / "realism_authoring" / "room" / "Room.py").write_text("# room\n")
    (tmp_path / "capture").mkdir()
    return scene


def _context(scene: Path) -> RunContext:
    return RunContext(
        scan="Scan-1",
        capture_dir=scene.parent.parent / "capture",
        scene_dir=scene,
        output_root=scene.parent,
    )


class Recorder:
    """Stands in for `run_module`, creating whatever each real module would have produced."""

    def __init__(self, context: RunContext, *, compare_rc: int = 0, compile_rc: int = 0,
                 export_layout: bool = True) -> None:
        self.context = context
        self.compare_rc = compare_rc
        self.compile_rc = compile_rc
        self.export_layout = export_layout
        self.calls: list[str] = []

    def __call__(self, _context, module: str, args=(), *, log_name=None):
        short = module.rsplit(".", 1)[-1]
        self.calls.append(short)
        if short == "build_from_room":
            if self.compile_rc:
                return self.compile_rc, Path("compile.log")
            glb = self.context.preview_dir / "Room.glb"
            glb.parent.mkdir(parents=True, exist_ok=True)
            glb.write_bytes(b"glTF")
            glb.with_suffix(".blend").write_bytes(b"assembled scene")
            if self.export_layout:
                (glb.parent / "room_layout.json").write_text('{"objects": []}')
        elif short == "checks":
            assert args == ["--layout", self.context.preview_dir / "room_layout.json",
                            "--shell", self.context.authored_room / "Room.py"]
            assert json.loads(args[1].read_text()) == {"objects": []}
        elif short == "render_vs_capture":
            if self.compare_rc:
                return self.compare_rc, Path("compare.log")
            pairs = self.context.authoring_root / "compare" / "pairs"
            pairs.mkdir(parents=True, exist_ok=True)
            (pairs / "pair_00001.png").write_bytes(b"\x89PNG")
        return 0, None


@pytest.fixture
def stub(monkeypatch):
    """The Blender subprocess exports to the requested path. Compression must stay lazy."""
    from litereality_agent.room_ops import api

    def export(cmd, **kwargs):
        output = Path(cmd[cmd.index("--") + 1])
        output.write_bytes(b"baked room")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(api, "blender_bin", lambda: "blender")
    monkeypatch.setattr(api, "subprocess", SimpleNamespace(run=export, STDOUT=subprocess.STDOUT))
    monkeypatch.setattr("litereality_agent.pipeline.realism_authoring.acceptance.assess",
                        lambda *a: {"accepted": True})

    def never(*_a, **_k):
        raise AssertionError("publish must not compress; the web copy is made on first view")

    monkeypatch.setattr("litereality_agent.room_ops.compress.compressed", never)

    def install(context, **kw):
        rec = Recorder(context, **kw)
        monkeypatch.setattr(publish, "run_module", rec)
        return rec

    return install


def test_publishes_the_room_and_the_comparison(scene: Path, stub) -> None:
    """No web copy and no `room_web_glb` artifact: publishing a room a browser may never open must
    not spend a Blender launch on the body that only a browser reads. The `stub` fixture raises if
    the compressor is called at all."""
    context = _context(scene)
    rec = stub(context)

    result = publish.run(context, {"compare_frames": 4})

    assert result.status is StageStatus.COMPLETED
    assert (context.preview_dir / "Room.glb").read_bytes() == b"baked room"
    assert not (context.preview_dir / publish.WEB_GLB_NAME).exists()
    assert "room_web_glb" not in result.artifacts
    assert "render_vs_capture" in rec.calls
    assert rec.calls.index("build_from_room") < rec.calls.index("checks")


def test_missing_layout_reports_unavailable_quality_and_keeps_the_model(scene: Path, stub) -> None:
    context = _context(scene)
    rec = stub(context, export_layout=False)
    result = publish.run(context, {"compare_frames": 0})
    assert result.status is StageStatus.COMPLETED
    assert any("produced no room_layout.json" in warning for warning in result.warnings)
    assert "checks" not in rec.calls


def test_no_compare_frames_means_no_render(scene: Path, stub) -> None:
    context = _context(scene)
    rec = stub(context)

    result = publish.run(context, {"compare_frames": 0})

    assert result.status is StageStatus.COMPLETED
    assert "render_vs_capture" not in rec.calls


def test_a_failed_comparison_render_still_publishes_the_room(scene: Path, stub) -> None:
    """The comparison is a review artifact, not the deliverable — losing it must not lose the room."""
    context = _context(scene)
    stub(context, compare_rc=3)

    result = publish.run(context, {"compare_frames": 4})

    assert result.status is StageStatus.COMPLETED
    assert any("comparison renders exited 3" in w for w in result.warnings)
    assert (context.preview_dir / "Room.glb").is_file()


def test_a_failed_compile_fails_the_stage(scene: Path, stub) -> None:
    context = _context(scene)
    stub(context, compile_rc=1)

    result = publish.run(context, {"compare_frames": 4})

    assert result.status is StageStatus.FAILED
    assert "final compile failed" in (result.error or "")


@pytest.mark.parametrize("existing_blend", [None, b"", b"previous assembly"],
                         ids=["missing", "empty", "unchanged"])
def test_publish_requires_a_new_blend_before_recording_success(scene, monkeypatch, existing_blend):
    from litereality_agent.pipeline.scene_init import seed
    from litereality_agent.room_ops import api
    from litereality_agent.room_ops.compile import build_from_room

    context = _context(scene)
    preview = context.preview_dir
    preview.mkdir()
    if existing_blend is not None:
        (preview / "Room.blend").write_bytes(existing_blend)
    (preview / "acceptance.json").write_text('{"status":"published"}')
    stamp = context.authored_room / ".compile_stamp"
    stamp.write_text("previously compiled")

    # This assembly returns zero and exports a candidate GLB, but fails to save its .blend.
    def blender(*args):
        (preview / "Room.glb").write_bytes(b"glTF")
        return SimpleNamespace(returncode=0)

    def run(_context, module, args, **kwargs):
        if module.endswith("build_from_room"):
            log = preview / "build.log"
            return build_from_room.run_assembly([], log, require_blend="--require-blend" in args), log
        return 0, None

    monkeypatch.setattr(build_from_room.console, "run_logged", blender)
    monkeypatch.setattr(publish, "run_module", run)
    monkeypatch.setattr(api, "blender_bin", lambda: pytest.fail("attempted to bake stale input"))
    monkeypatch.setattr(seed, "saved", lambda *args: pytest.fail("recorded an unbaked final model"))
    result = publish.run(context, {"compare_frames": 0})

    assert result.status is StageStatus.FAILED
    assert "build.log" in result.error
    assert "Room.blend" in (preview / "build.log").read_text()
    assert (preview / "Room.glb").read_bytes() == b"glTF"
    assert not (preview / "acceptance.json").exists()
    assert not stamp.exists()
    if existing_blend is not None:
        assert (preview / "Room.blend").read_bytes() == existing_blend


def test_complete_requires_fresh_acceptance(scene: Path) -> None:
    """`complete` used to also require `viewer.html`. With the page gone, requiring anything but the
    room would make every publish re-run forever."""
    context = _context(scene)
    assert publish.complete(context) is False

    glb = context.preview_dir / "Room.glb"
    glb.parent.mkdir(parents=True, exist_ok=True)
    glb.write_bytes(b"glTF")
    assert publish.complete(context) is False
    from litereality_agent.pipeline.realism_authoring.acceptance import SCHEMA, fingerprint
    (context.preview_dir / "room_layout.json").write_text("{}")
    (context.preview_dir / "manifest.json").write_text("{}")
    (context.preview_dir / "acceptance.json").write_text(json.dumps({
        "schema": SCHEMA, "accepted": True,
        "fingerprint": fingerprint(context.authored_room, context.preview_dir)}))
    assert publish.complete(context) is True
    glb.write_bytes(b"changed")
    assert publish.complete(context) is False


def test_compare_frames_prefers_the_flag_then_the_environment(monkeypatch) -> None:
    monkeypatch.delenv("COMPARE_FRAMES", raising=False)
    assert publish.compare_frames({}) == publish.DEFAULT_COMPARE_FRAMES
    assert publish.compare_frames({"compare_frames": 0}) == 0
    assert publish.compare_frames({"compare_frames": 12}) == 12

    monkeypatch.setenv("COMPARE_FRAMES", "0")
    assert publish.compare_frames({}) == 0
    assert publish.compare_frames({"compare_frames": 3}) == 3, "an explicit flag outranks it"

    monkeypatch.setenv("COMPARE_FRAMES", "nonsense")
    assert publish.compare_frames({}) == publish.DEFAULT_COMPARE_FRAMES


def test_cli_carries_the_publish_knob_to_the_stage() -> None:
    """`run` keys options by stage while `run_stage` takes them flat, so the two paths build the
    dict differently — and a knob wired into only one of them is the easy mistake."""
    from litereality_agent import cli

    parser = cli._parser()
    assert cli._publish_options(parser.parse_args(
        ["run", "scan-1", "--compare-frames", "0"])) == {"compare_frames": 0}
    assert cli._publish_options(parser.parse_args(
        ["stage", "publish", "scan-1"])) == {"compare_frames": None}
