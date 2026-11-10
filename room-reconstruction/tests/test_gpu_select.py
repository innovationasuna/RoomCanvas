"""run_room.py's GPU choice: only an idle card by default; on a shared machine, a named card that
others use lightly (ROOMCANVAS_GPU / ROOMCANVAS_GPU_SHARED_MIB)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from gpu import Gpu, select_gpu  # noqa: E402

BUSY = Gpu(0, "GPU-a", 18174, (433406, 2403252))
LIGHT = Gpu(1, "GPU-b", 2197, (19915,))
FREE = Gpu(2, "GPU-c", 2, ())


def test_only_an_idle_card_by_default():
    assert select_gpu("auto", [BUSY, LIGHT, FREE]) is FREE
    with pytest.raises(RuntimeError, match="no idle GPU"):
        select_gpu("auto", [BUSY, LIGHT])
    with pytest.raises(RuntimeError, match="busy"):
        select_gpu("1", [BUSY, LIGHT])


def test_a_shared_machine_accepts_light_use_by_others():
    assert select_gpu("auto", [BUSY, LIGHT], shared_mib=4096) is LIGHT
    assert select_gpu("1", [BUSY, LIGHT], shared_mib=4096) is LIGHT
    with pytest.raises(RuntimeError, match="busy"):
        select_gpu("0", [BUSY, LIGHT], shared_mib=4096)
