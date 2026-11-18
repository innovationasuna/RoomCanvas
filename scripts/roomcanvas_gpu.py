"""Local NVIDIA device identity and process leases shared by RoomCanvas launchers."""
from __future__ import annotations

import fcntl
import functools
import os
import re
import subprocess
import sys
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path

UUID = re.compile(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
# A waiting job polls instead of blocking in flock: it holds nothing while it waits, it can be
# stopped like any process, and it gives up with a clear error instead of hanging for a room's hours.
WAIT_SECONDS = 30 * 60
POLL_SECONDS = 2


@functools.cache  # waiting jobs ask every poll; the index-to-UUID mapping does not change
def device_uuid(selector):
    """Resolve nvidia-smi's physical index or UUID prefix before starting a CUDA process."""
    if UUID.fullmatch(selector):
        return selector.lower().replace("gpu-", "GPU-", 1)
    if not re.fullmatch(r"[0-9]+|GPU-[0-9a-fA-F-]+", selector):
        raise ValueError("Select one physical NVIDIA GPU by index or GPU UUID")
    uuid = subprocess.check_output(["nvidia-smi", f"--id={selector}", "--query-gpu=uuid",
                                    "--format=csv,noheader"], text=True).strip()
    if not UUID.fullmatch(uuid):
        raise ValueError(f"No unique physical GPU for {selector!r}")
    return device_uuid(uuid)


def lock_path(uuid, env):
    directory = Path(env.get("ROOMCANVAS_GPU_LOCK_DIR") or Path.home() / ".cache/roomcanvas/gpu-locks")
    if not directory.is_absolute():
        raise ValueError("ROOMCANVAS_GPU_LOCK_DIR must be an absolute path")
    return directory / f"gpu-{uuid}.lock"


@dataclass(frozen=True)
class Lease:
    uuid: str
    fd: int
    fds: tuple[int, ...]


def _hold(uuid, env, legacy_path, shared_legacy):
    physical = lock_path(uuid, env).resolve()
    modes = {Path(legacy_path).resolve(): fcntl.LOCK_SH if shared_legacy else fcntl.LOCK_EX,
             physical: fcntl.LOCK_EX}
    files = {}
    with ExitStack() as stack:
        for path in sorted(modes):
            path.parent.mkdir(parents=True, exist_ok=True)
            # Read access suffices for flock on local Linux. Allow a shared directory across users.
            fd = os.open(path, os.O_RDONLY | os.O_CREAT, 0o644)
            stack.callback(os.close, fd)
            try:
                fcntl.flock(fd, modes[path] | fcntl.LOCK_NB)
            except BlockingIOError:
                raise BlockingIOError(f"GPU {uuid} is locked by another job ({path})") from None
            files[path] = fd
        return stack.pop_all(), Lease(uuid, files[physical], tuple(files.values()))


@contextmanager
def acquire(uuid, env, legacy_path, *, shared_legacy=False, wait=False):
    """Hold the physical card and a compatibility lock until the last inheriting child exits."""
    deadline, reported = time.monotonic() + WAIT_SECONDS, False
    while True:
        try:
            held, lease = _hold(uuid, env, legacy_path, shared_legacy)
            break
        except BlockingIOError as error:
            if not wait:
                raise
            if time.monotonic() >= deadline:
                raise TimeoutError(f"{error}; gave up after waiting {WAIT_SECONDS // 60} min") from None
            if not reported:
                print(f"Waiting up to {WAIT_SECONDS // 60} min: {error}", file=sys.stderr, flush=True)
                reported = True
            time.sleep(POLL_SECONDS)
    # close(), without LOCK_UN, preserves a lease still in use by a subprocess.
    with held:
        yield lease


def object_lease(root, *, wait=False):
    uuid = device_uuid(os.environ.get("CUDA_VISIBLE_DEVICES", ""))
    legacy = os.environ.get("VIEWFORGE_GPU_LOCK")
    # Old workers and destructive input changes take the default lock exclusively.
    # Shared mode lets new jobs on different physical cards use the same data root.
    return acquire(uuid, os.environ, legacy or Path(root) / "cache/gpu.lock",
                   shared_legacy=not legacy, wait=wait)


def inherited_fd(uuid, fd):
    """Accept COVER's inherited lease only for the very same physical device."""
    if fd is None or not os.path.samestat(os.fstat(fd), lock_path(uuid, os.environ).stat()):
        raise ValueError("COVER requires the parent lock descriptor for the selected GPU")
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
