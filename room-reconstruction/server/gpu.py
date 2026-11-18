"""Pick one idle GPU (or, on a shared machine, one others use only lightly) and hold an exclusive
lock on it for the whole run."""

from __future__ import annotations

import csv
import io
import subprocess
import sys
import time
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from roomcanvas_gpu import acquire, device_uuid  # noqa: E402

IDLE_MEMORY_MIB = 100


@dataclass(frozen=True)
class Gpu:
    index: int
    uuid: str
    memory_used_mib: int
    compute_pids: tuple[int, ...]

    @property
    def idle(self) -> bool:
        return self.memory_used_mib <= IDLE_MEMORY_MIB and not self.compute_pids

    def usable(self, shared_mib: int = 0) -> bool:
        """Idle, or with `shared_mib` > 0, other people's processes use at most that much memory."""
        return self.memory_used_mib <= shared_mib if shared_mib > 0 else self.idle


def _query(*args: str) -> list[list[str]]:
    output = subprocess.run(
        ["nvidia-smi", *args, "--format=csv,noheader,nounits"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(output)) if row]


def list_gpus() -> list[Gpu]:
    pids: dict[str, list[int]] = {}
    for uuid, pid in _query("--query-compute-apps=gpu_uuid,pid"):
        pids.setdefault(uuid, []).append(int(pid))
    return [
        Gpu(int(index), uuid, int(used), tuple(pids.get(uuid, ())))
        for index, uuid, used in _query("--query-gpu=index,uuid,memory.used")
    ]


def select_gpu(request: str, gpus: list[Gpu], shared_mib: int = 0) -> Gpu:
    """request is 'auto', an index such as '1', or a UUID such as 'GPU-d11de16f-...'.

    `shared_mib` > 0 also accepts a GPU that other processes use up to that much memory (a shared
    machine where a card is never completely free); the run then has that much less memory."""
    if request == "auto":
        idle = [gpu for gpu in gpus if gpu.usable(shared_mib)]
        if not idle:
            raise RuntimeError("no idle GPU: every GPU has memory in use or compute processes"
                               + (f" (more than {shared_mib} MiB)" if shared_mib > 0 else ""))
        return idle[0]
    matches = [gpu for gpu in gpus if request in (str(gpu.index), gpu.uuid)]
    if not matches:
        raise RuntimeError(f"no GPU matches {request!r}")
    gpu = matches[0]
    if not gpu.usable(shared_mib):
        raise RuntimeError(
            f"GPU {gpu.index} is busy: {gpu.memory_used_mib} MiB used, pids {gpu.compute_pids}"
        )
    return gpu


@contextmanager
def room_lease(runtime, env, *, wait=False):
    """Pick an allowed physical GPU and check its occupancy again under the shared lock."""
    request = env.get("ROOMCANVAS_GPU", "auto")
    allowed = None
    if "CUDA_VISIBLE_DEVICES" in env:
        allowed = {device_uuid(s.strip()) for s in env["CUDA_VISIBLE_DEVICES"].split(",")}
    requested_uuid = None if request == "auto" else device_uuid(request)
    shared_mib = int(env.get("ROOMCANVAS_GPU_SHARED_MIB", "0"))
    reported_wait = False
    while True:
        cards = [gpu for gpu in list_gpus() if (allowed is None or gpu.uuid in allowed)
                 and (requested_uuid is None or gpu.uuid == requested_uuid)]
        if not cards:
            raise RuntimeError(f"No visible GPU matches ROOMCANVAS_GPU={request!r}")
        for card in cards:
            if not card.usable(shared_mib):
                continue
            with ExitStack() as stack:
                legacy = runtime / "locks" / f"gpu-{card.uuid}.lock"
                try:
                    lease = stack.enter_context(acquire(card.uuid, env, legacy))
                except BlockingIOError:
                    continue
                try:
                    current = select_gpu(card.uuid, list_gpus(), shared_mib)
                except RuntimeError:
                    continue
                yield current, lease
                return
        if not wait:
            raise RuntimeError(f"No available GPU: selected card(s) busy or locked: {[g.uuid for g in cards]}")
        if not reported_wait:
            print(f"Waiting for an available GPU: {[g.uuid for g in cards]}", file=sys.stderr, flush=True)
            reported_wait = True
        time.sleep(1)
