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


def test_sharing_needs_room_for_the_run_on_the_card():
    roomy = Gpu(1, "GPU-b", 6644, (19915,), 24564)
    crowded = Gpu(1, "GPU-b", 7900, (19915,), 16000)
    assert select_gpu("1", [roomy], shared_mib=8192, need_mib=10448) is roomy
    with pytest.raises(RuntimeError, match="needed free"):
        select_gpu("1", [crowded], shared_mib=8192, need_mib=10448)
    assert roomy.usable(8192) and not crowded.usable(8192, 10448)  # without a need, only the others' use counts
