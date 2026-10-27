"""`$LITEREALITY_BLENDER` may name Blender's install directory or the binary itself.

The publish comparison render and the author prompt used to append `/blender` to it
unconditionally, so a binary path (or the macOS app fallback) gave `.../blender/blender` and every
comparison render failed, which publish read as needing repair.
"""

import os

import pytest

from litereality_agent.agent import author
from litereality_agent.room_ops.rendering.room_render import render_vs_capture


@pytest.fixture
def blender(tmp_path):
    install = tmp_path / "blender-5.1.2-linux-x64"
    install.mkdir()
    binary = install / "blender"
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    return install, binary


@pytest.mark.parametrize("given", ["dir", "binary"])
@pytest.mark.parametrize("resolve", [render_vs_capture._blender_bin, author._blender_bin])
def test_blender_bin_accepts_dir_or_binary(monkeypatch, blender, given, resolve):
    install, binary = blender
    for key in ("BLENDER_PATH", "BLENDER"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("LITEREALITY_BLENDER", str(install if given == "dir" else binary))
    found = resolve()
    # samefile: on a case-insensitive disk the resolver may spell it `Blender`
    assert os.path.samefile(found, binary) and os.access(found, os.X_OK)
