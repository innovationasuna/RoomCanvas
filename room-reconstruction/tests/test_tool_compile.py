"""compile — build the active Room.py into Room.glb, and surface build errors for the model to fix.

The freshness stamp is pure filesystem, so it tests offline. It matters more than it looks: the
model calls `render` in a loop, and every render recompiles unless the stamp says the room is
unchanged. A stamp that wrongly reports "fresh" means the model renders a stale room and reasons
about work it already replaced.

The Blender build itself is `-m blender`.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from litereality_agent.agent.tools.compile.tool import (
    CompileInvocation,
    CompileParams,
    CompileTool,
    compile_is_fresh,
)

ROOM_PY = '''\
SHELL = {"walls": {}, "openings": {}, "floor_height": 0.0, "ceiling_height": 2.6}


def build():
    return SHELL
'''


@pytest.fixture
def room(tmp_path):
    d = tmp_path / "room"
    d.mkdir()
    (d / "Room.py").write_text(ROOM_PY, encoding="utf-8")
    return d


def test_schema_is_well_formed():
    fn = CompileTool().schema["function"]
    assert fn["name"] == "compile"
    assert "regenerate" in fn["parameters"]["properties"]


def test_a_room_that_never_compiled_is_not_fresh(room):
    assert compile_is_fresh(room) is False


def test_fresh_only_while_room_py_is_unchanged(room):
    from litereality_agent.agent.tools.compile.tool import _write_compile_stamp

    _write_compile_stamp(room)
    assert compile_is_fresh(room) is True, "a stamped, unedited room should not rebuild"

    (room / "Room.py").write_text(ROOM_PY + "\n# the model edited a material\n", encoding="utf-8")
    assert compile_is_fresh(room) is False, (
        "stamp survived an edit — the model would render a stale room and reason about "
        "work it had already replaced"
    )


def test_stamp_never_raises_on_an_unwritable_room(room, monkeypatch):
    """The stamp is an optimisation. If it cannot be written the compile must still succeed."""
    from litereality_agent.agent.tools.compile.tool import _write_compile_stamp

    def _boom(*a, **k):
        raise OSError("read-only filesystem")

    monkeypatch.setattr("pathlib.Path.write_text", _boom)
    _write_compile_stamp(room)  # must not raise


def test_missing_room_py_is_not_fresh_rather_than_an_error(tmp_path):
    assert compile_is_fresh(tmp_path / "no-such-room") is False


def test_compile_api_rejects_a_missing_glb(room, tmp_path, monkeypatch):
    from litereality_agent.room_ops import api

    monkeypatch.setattr(api.subprocess, "run", lambda _cmd: SimpleNamespace(returncode=0))
    assert api.compile_room(room, out_dir=tmp_path / "preview", bake=False) is None


def test_standalone_bake_still_accepts_a_legacy_preview_without_a_blend(tmp_path):
    from litereality_agent.room_ops import api

    glb = tmp_path / "Room.glb"
    glb.write_bytes(b"existing preview")
    assert api.bake_room(tmp_path / "Room.blend", glb) == 0
    assert glb.read_bytes() == b"existing preview"


def test_compile_tool_does_not_stamp_a_missing_glb(room, tmp_path, monkeypatch):
    missing = tmp_path / "preview" / "Room.glb"
    monkeypatch.setattr("litereality_agent.room_ops.compile_room", lambda *_a, **_k: missing)

    inv = CompileInvocation(CompileParams(regenerate=False))
    inv.bind(str(room), None)
    result = asyncio.run(inv.execute())

    assert not result.is_success()
    assert result.build == {"status": "error", "glb_path": None}
    assert not (room / ".compile_stamp").exists()


@pytest.mark.parametrize("failure", ["nonzero", "no-output"])
def test_failed_rebake_retains_assembly_invalidates_stamp_and_retries(room, monkeypatch, failure):
    from litereality_agent.room_ops import api

    preview = room.parent / "room_preview"
    preview.mkdir()
    glb = preview / "Room.glb"
    outcomes = ["success", failure, "success"]
    calls = []
    records = []

    def run(cmd, **kwargs):
        if "--python" not in cmd:
            calls.append("assemble")
            glb.write_bytes(b"assembled")
            (preview / "Room.blend").write_bytes(f"blend {len(calls)}".encode())
            return SimpleNamespace(returncode=0)
        calls.append("bake")
        assert cmd[cmd.index("--python") - 2 : cmd.index("--python")] == ["--python-exit-code", "1"]
        output = Path(cmd[cmd.index("--") + 1])
        outcome = outcomes.pop(0)
        if outcome == "success":
            output.write_bytes(b"baked")
        elif outcome == "nonzero":
            output.write_bytes(b"partial")
            print("script failed", file=kwargs["stdout"])
            return SimpleNamespace(returncode=7)
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(api.subprocess, "run", run)
    monkeypatch.setattr(api, "blender_bin", lambda: "blender")
    monkeypatch.setattr(api, "_record_build", lambda *args: records.append(glb.read_bytes()))
    inv = CompileInvocation(CompileParams())
    inv.bind(str(room), None)
    assert asyncio.run(inv.execute()).is_success()
    assert compile_is_fresh(room)

    failed = asyncio.run(inv.execute())
    assert failed.build == {"status": "error", "glb_path": None}
    assert "bake.log" in failed.error
    assert (preview / "bake.log").read_text()
    assert glb.read_bytes() == b"assembled"
    assert not compile_is_fresh(room)
    assert records == [b"baked"]
    assert list(preview.glob(".bake-*")) == []

    assert asyncio.run(inv.execute()).is_success()
    assert compile_is_fresh(room)
    assert records == [b"baked", b"baked"]
    assert calls == ["assemble", "bake"] * 3


@pytest.mark.parametrize("old_blend", [False, True])
def test_baked_compile_requires_the_current_blend(room, monkeypatch, old_blend):
    from litereality_agent.room_ops import api
    from litereality_agent.room_ops.compile import build_from_room

    preview = room.parent / "room_preview"
    preview.mkdir()
    if old_blend:
        (preview / "Room.blend").write_bytes(b"older scene")

    def blender(*args):
        (preview / "Room.glb").write_bytes(b"assembled")
        return SimpleNamespace(returncode=0)

    def assemble(cmd):
        rc = build_from_room.run_assembly([], preview / "build.log", require_blend="--require-blend" in cmd)
        return SimpleNamespace(returncode=rc)

    monkeypatch.setattr(build_from_room.console, "run_logged", blender)
    monkeypatch.setattr(api.subprocess, "run", assemble)
    assert api.compile_room(room) is None
    if old_blend:
        assert (preview / "Room.blend").read_bytes() == b"older scene"
    assert api.compile_room(room, bake=False) == preview / "Room.glb"


def test_assembly_accepts_identical_output_on_a_coarse_filesystem(tmp_path, monkeypatch):
    from litereality_agent.room_ops.compile import build_from_room

    blend = tmp_path / "Room.blend"
    blend.write_bytes(b"same scene")
    original = Path.stat
    stamp = blend.stat()

    def coarse_stat(path, *args, **kwargs):
        # Still raise when a file doesn't exist. Existing revisions have identical stat values.
        actual = original(path, *args, **kwargs)
        return stamp if path == blend else actual

    def blender(*args):
        assert not blend.exists()
        blend.write_bytes(b"same scene")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(Path, "stat", coarse_stat)
    monkeypatch.setattr(build_from_room.console, "run_logged", blender)
    assert build_from_room.run_assembly([], tmp_path / "build.log", require_blend=True) == 0
    assert blend.read_bytes() == b"same scene"
    assert list(tmp_path.glob(".previous-blend-*")) == []


@pytest.mark.blender
@pytest.mark.scan
def test_compiles_a_real_seed_room(example_scan):
    """Full build through Blender. Run with `-m 'blender and scan'`."""
    inv = CompileInvocation(CompileParams(regenerate=False))
    inv.bind(str(example_scan.room), None)
    res = asyncio.run(inv.execute())
    assert res.is_success(), f"seed room failed to compile: {res.error}"
    assert compile_is_fresh(example_scan.room), "a successful compile must leave a valid stamp"
