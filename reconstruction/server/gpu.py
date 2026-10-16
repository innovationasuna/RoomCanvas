"""Pick one idle GPU and hold an exclusive lock on it for the whole run."""

from __future__ import annotations

import csv
import fcntl
import io
import subprocess
from dataclasses import dataclass
from pathlib import Path

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


def select_gpu(request: str, gpus: list[Gpu]) -> Gpu:
    """request is 'auto', an index such as '1', or a UUID such as 'GPU-d11de16f-...'."""
    if request == "auto":
        idle = [gpu for gpu in gpus if gpu.idle]
        if not idle:
            raise RuntimeError("no idle GPU: every GPU has memory in use or compute processes")
        return idle[0]
    matches = [gpu for gpu in gpus if request in (str(gpu.index), gpu.uuid)]
    if not matches:
        raise RuntimeError(f"no GPU matches {request!r}")
    gpu = matches[0]
    if not gpu.idle:
        raise RuntimeError(
            f"GPU {gpu.index} is busy: {gpu.memory_used_mib} MiB used, pids {gpu.compute_pids}"
        )
    return gpu


class GpuLock:
    """Non-blocking flock on lock_dir/gpu-<uuid>.lock, released when the context exits."""

    def __init__(self, lock_dir: Path, gpu: Gpu):
        self.path = Path(lock_dir) / f"gpu-{gpu.uuid}.lock"
        self._file = None

    def __enter__(self) -> GpuLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._file = self.path.open("w")
        try:
            fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self._file.close()
            raise RuntimeError(f"GPU is locked by another RoomCanvas run: {self.path}") from None
        return self

    def __exit__(self, *exc) -> None:
        fcntl.flock(self._file, fcntl.LOCK_UN)
        self._file.close()
