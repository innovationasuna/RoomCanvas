"""Wall/CPU observations and a read-only report; durations may overlap, never sum blindly.

Run ``python -m litereality_agent.timing JOB_DIR`` to inspect one job's queue,
GPU lease, stage retries and provider timing. GPU lease wall time is NOT kernel time.
"""
from __future__ import annotations

import argparse
import json
import resource
import time
from pathlib import Path


def cpu_seconds():
    def used(who):
        value = resource.getrusage(who)
        return value.ru_utime + value.ru_stime
    return used(resource.RUSAGE_SELF), used(resource.RUSAGE_CHILDREN)


class Measurement:
    def __init__(self):
        self.started = time.monotonic()
        self.cpu = cpu_seconds()

    def finish(self):
        current = cpu_seconds()
        return {"wall_seconds": max(0., time.monotonic() - self.started),
                "process_cpu_seconds": max(0., current[0] - self.cpu[0]),
                "finished_children_cpu_seconds": max(0., current[1] - self.cpu[1])}


def report(root: Path):
    def read(path):
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return {}
    job = read(root / "job.json")
    stages = []
    for path in root.rglob("pipeline.json"):
        if path.parent.name != ".litereality":
            continue
        for name, stage in read(path).get("stages", {}).items():
            reused = stage.get("status") == "reused"
            stages.append({"state": str(path.relative_to(root)), "stage": name,
                           "status": stage.get("status"), "duration_seconds": 0. if reused else stage.get("duration_seconds"),
                           "attempts": [] if reused else stage.get("details", {}).get("timing_attempts", [])})
    attempts = [{"path": str(path.relative_to(root)), **read(path)} for path in root.rglob("runtime-timing.json")]
    providers = []
    for path in root.rglob("agent-timing.jsonl"):
        for line in path.read_text().splitlines():
            try:
                providers.append({"path": str(path.relative_to(root)), **json.loads(line)})
            except (ValueError, TypeError):
                continue
    return {"queue": job.get("timing", {}), "attempts": attempts, "stages": stages, "providers": providers,
            "notes": ["Nested/concurrent wall intervals overlap; CPU seconds may exceed wall time.",
                      "Children CPU includes only reaped children. GPU lease time includes CPU/API work, not kernel utilization.",
                      "Missing provider API timing remains unknown; historical runs are not backfilled."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    print(json.dumps(report(parser.parse_args().root), indent=2))
