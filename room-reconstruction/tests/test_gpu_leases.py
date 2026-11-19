"""Cross-process GPU scheduling using real flock descriptors and two simulated cards."""
from __future__ import annotations

import multiprocessing
import os
import subprocess
import sys
from contextlib import ExitStack, contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import gpu  # noqa: E402
import roomcanvas_gpu  # noqa: E402

CARD0 = gpu.Gpu(0, "GPU-00000000-0000-0000-0000-000000000001", 0, ())
CARD1 = gpu.Gpu(1, "GPU-00000000-0000-0000-0000-000000000002", 0, ())


@pytest.fixture
def machine(tmp_path, monkeypatch):
    monkeypatch.setenv("ROOMCANVAS_GPU_LOCK_DIR", str(tmp_path / "physical"))
    monkeypatch.delenv("VIEWFORGE_GPU_LOCK", raising=False)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", CARD0.uuid)
    monkeypatch.setattr(gpu, "list_gpus", lambda: [CARD0, CARD1])
    return tmp_path


def _object_worker(root, uuid, pipe):
    os.environ["CUDA_VISIBLE_DEVICES"] = uuid
    pipe.send("started")
    with roomcanvas_gpu.object_lease(root, wait=True) as lease:
        pipe.send(lease.uuid)
        pipe.recv()
    pipe.close()


@contextmanager
def object_worker(root, card):
    # spawn gives the worker independent descriptors even when the test already holds a room lease.
    ctx = multiprocessing.get_context("spawn")
    parent, child = ctx.Pipe()
    process = ctx.Process(target=_object_worker, args=(root, card.uuid, child))
    process.start()
    child.close()
    try:
        assert parent.poll(10) and parent.recv() == "started"
        yield process, parent
    finally:
        if process.is_alive():
            process.terminate()
        process.join(5)
        parent.close()


def test_room_auto_skips_an_object_lease_and_respects_visibility(machine):
    root = machine / "objects"
    both = dict(os.environ, ROOMCANVAS_GPU="auto", CUDA_VISIBLE_DEVICES=f"{CARD0.uuid},{CARD1.uuid}")
    with object_worker(root, CARD0) as (_, pipe):
        assert pipe.poll(5) and pipe.recv() == CARD0.uuid
        with pytest.raises(RuntimeError):
            with gpu.room_lease(machine, dict(both, CUDA_VISIBLE_DEVICES=CARD0.uuid)):
                pytest.fail("a room borrowed a card outside its visible set")
        with pytest.raises(RuntimeError):
            with gpu.room_lease(machine, dict(both, ROOMCANVAS_GPU=CARD1.uuid, CUDA_VISIBLE_DEVICES=CARD0.uuid)):
                pytest.fail("explicit room selection escaped its visible set")
        with gpu.room_lease(machine, both) as (card, lease):
            assert card.uuid == lease.uuid == CARD1.uuid
        # Distinct cards can also work on separate object jobs in one data root.
        with object_worker(root, CARD1) as (_, other):
            assert other.poll(5) and other.recv() == CARD1.uuid


def test_cancelled_waiter_does_not_release_room_and_another_waiter_resumes(machine):
    room = dict(os.environ, ROOMCANVAS_GPU=CARD0.uuid)
    with ExitStack() as children:
        with gpu.room_lease(machine, room):
            with object_worker(machine / "objects", CARD0) as (cancelled, pipe):
                assert not pipe.poll(.15)
                cancelled.terminate()
                cancelled.join(5)
                assert not cancelled.is_alive()
            waiter, pipe = children.enter_context(object_worker(machine / "objects", CARD0))
            assert not pipe.poll(.15)
        assert pipe.poll(5) and pipe.recv() == CARD0.uuid
        with pytest.raises(RuntimeError):
            with gpu.room_lease(machine, room):
                pytest.fail("the waiting object lost its newly acquired lease")
        # Abrupt termination releases the descriptor with no code running in the worker.
        waiter.kill()
        waiter.join(5)
        with gpu.room_lease(machine, room) as (card, _):
            assert card == CARD0


def test_child_keeps_parents_physical_lease_until_it_exits(machine):
    env = dict(os.environ, ROOMCANVAS_GPU=CARD0.uuid)
    script = """
import sys
from roomcanvas_gpu import inherited_fd
inherited_fd(sys.argv[1], int(sys.argv[2]))
sys.stdin.buffer.read()
"""
    with roomcanvas_gpu.object_lease(machine / "objects") as lease:
        env["PYTHONPATH"] = str(Path(roomcanvas_gpu.__file__).parent)
        child = subprocess.Popen([sys.executable, "-c", script, lease.uuid, str(lease.fd)],
                                 stdin=subprocess.PIPE, env=env, pass_fds=lease.fds)
    try:
        with pytest.raises(RuntimeError):
            with gpu.room_lease(machine, env):
                pytest.fail("the card was released while the COVER subprocess still held it")
        child.communicate(timeout=5)
        assert child.returncode == 0
        with gpu.room_lease(machine, env) as (card, _):
            assert card == CARD0
    finally:
        if child.poll() is None:
            child.kill()
            child.communicate()


def test_room_rechecks_card_occupancy_while_locked(machine, monkeypatch):
    reads = []

    def inventory():
        reads.append(None)
        if len(reads) == 1:
            return [CARD0]
        with pytest.raises(BlockingIOError):
            with roomcanvas_gpu.object_lease(machine / "objects"):
                pytest.fail("the free-memory recheck ran before the physical lease was acquired")
        return [gpu.Gpu(0, CARD0.uuid, 12000, (123,))]

    monkeypatch.setattr(gpu, "list_gpus", inventory)
    with pytest.raises(RuntimeError):
        with gpu.room_lease(machine, dict(os.environ, ROOMCANVAS_GPU=CARD0.uuid)):
            pytest.fail("the room started with insufficient resources")
    assert len(reads) == 2
    with roomcanvas_gpu.object_lease(machine / "objects") as lease:
        assert lease.uuid == CARD0.uuid


def test_waiting_for_a_held_card_is_bounded_with_a_clear_error(machine, monkeypatch):
    for module in (roomcanvas_gpu, gpu):
        monkeypatch.setattr(module, "WAIT_SECONDS", .3)
        monkeypatch.setattr(module, "POLL_SECONDS", .05)
    room = dict(os.environ, ROOMCANVAS_GPU=CARD0.uuid)
    with gpu.room_lease(machine, room):
        with pytest.raises(TimeoutError, match="locked by another job.*gave up after waiting"):
            with roomcanvas_gpu.object_lease(machine / "objects", wait=True):
                pytest.fail("an object job shared the card with a room")
    with roomcanvas_gpu.object_lease(machine / "objects"):
        with pytest.raises(RuntimeError, match="No GPU became available.*locked by another job"):
            with gpu.room_lease(machine, room, wait=True):
                pytest.fail("a room shared the card with an object job")
