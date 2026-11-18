"""Lightweight, always-on process event log.

Pipeline boundaries and model calls are appended as one JSON line to

    <repo>/run/<scan>/traces/trace.jsonl

so a downstream viewer can reconstruct the whole timeline. Per-call payloads
(prompts, agent thoughts) can also be dropped under ``traces/images/`` and
``traces/agent/``.

The tracer is a process-global keyed to the *current scan*. Call :func:`start`
(the scene-initialization flow does this per scan) to point it at that scan's ``traces/`` dir; if it
was never started, every hook is a cheap no-op, so instrumented code never has to care whether
telemetry is active.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path

from litereality_agent import REPO_ROOT, console

_lock = threading.Lock()
_state: dict = {"scan": None, "dir": None, "t0": None}


def start(scan: str, directory: str | Path | None = None) -> Path:
    """Begin (or resume) a trace for ``scan``; returns the traces directory."""
    if directory is None:
        root = Path(
            os.environ.get("LITEREALITY_FINAL")
            or os.environ.get("LITEREALITY_OUTPUT")
            or (REPO_ROOT / "run")
        )
        d = root / scan / "scene_init" / "obj_stage" / "traces"
    else:
        d = Path(directory)
    (d / "images").mkdir(parents=True, exist_ok=True)
    (d / "agent").mkdir(parents=True, exist_ok=True)
    _state.update(scan=scan, dir=d, t0=time.time())
    # One id per top-level run, inherited by the stage subprocesses, so a resumed run (a new id)
    # can be told apart from the one before it.
    run = os.environ.setdefault("LITEREALITY_RUN_ID", f"{int(time.time())}-{os.getpid()}")
    event("trace_start", scan=scan, run=run, pid=os.getpid())
    return d


def active_dir() -> Path | None:
    return _state["dir"]


def event(kind: str, **data) -> None:
    """Append one event to ``trace.jsonl`` (no-op if telemetry was never started)."""
    d = _state["dir"]
    if d is None:
        return
    t0 = _state["t0"] or time.time()
    rec = {"t": round(time.time(), 3), "dt": round(time.time() - t0, 3), "kind": kind, **data}
    _append(d, rec)


def record(directory: str | Path, kind: str, *, at: float | None = None, **data) -> None:
    """Append one event to ``<directory>/trace.jsonl`` whether or not this process started a trace.

    For records the reconstruction replay times itself by (objects finished, rooms saved, reviews):
    the stages that write them may run in their own process or in a resumed run. ``at`` is when it
    happened (e.g. a file's mtime) if not now. Skipped when the traces directory does not exist.
    """
    d = Path(directory)
    if not d.is_dir():
        return
    rec = {"t": round(time.time() if at is None else at, 3), "kind": kind, **data}
    run = os.environ.get("LITEREALITY_RUN_ID")
    if run:
        rec.setdefault("run", run)
    _append(d, rec)


def _append(d: Path, rec: dict) -> None:
    explicit_id = rec.get("event_id")
    rec.setdefault("schema_version", 2)
    rec.setdefault("event_id", uuid.uuid4().hex)
    rec.setdefault("run_id", rec.get("run") or os.environ.get("LITEREALITY_RUN_ID"))
    rec.setdefault("job_id", os.environ.get("LITEREALITY_JOB_ID"))
    rec.setdefault("attempt_id", os.environ.get("LITEREALITY_ATTEMPT_ID") or rec["run_id"])
    rec.setdefault("stage", os.environ.get("LITEREALITY_STAGE"))
    rec.setdefault("outcome", rec.get("status", "recorded"))
    rec.setdefault("artifact_digest", None)
    try:
        with _lock:
            with (d / "trace.jsonl").open("a+b") as f:
                fcntl.flock(f, fcntl.LOCK_EX)
                # Recover an interrupted writer before appending. Read backwards so ordinary events
                # remain O(last line), even after a long agent session.
                f.seek(0, os.SEEK_END)
                end = f.tell()
                tail = b""
                position = end
                while position and tail.count(b"\n") < 2:
                    size = min(position, 8192)
                    position -= size
                    f.seek(position)
                    tail = f.read(size) + tail
                if tail and not tail.endswith(b"\n"):
                    end -= len(tail) - tail.rfind(b"\n") - 1
                    f.truncate(end)
                    tail = tail[:tail.rfind(b"\n") + 1]
                previous = {}
                for line in reversed(tail.splitlines()):
                    try:
                        value = json.loads(line)
                        if isinstance(value, dict):
                            previous = value
                            break
                    except (ValueError, UnicodeError):
                        continue
                # Callers may retry a terminal publication with the same ID. Generated IDs need no
                # full scan. Keep this exceptional path on the same lock as sequence allocation.
                sequence = _sequence(previous)
                if explicit_id or (end and sequence is None):
                    f.seek(0)
                    for line in f:
                        try:
                            existing = json.loads(line)
                            if not isinstance(existing, dict):
                                continue
                            sequence = max(sequence or 0, _sequence(existing) or 0)
                            if explicit_id and existing.get("event_id") == explicit_id:
                                return
                        except (ValueError, UnicodeError):
                            continue
                rec["sequence"] = (sequence or 0) + 1
                f.seek(0, os.SEEK_END)
                f.write((json.dumps(rec, default=str) + "\n").encode())
                f.flush()
                if rec["outcome"] in {"done", "completed", "failed", "reused"} or rec["kind"] in {
                    "model_saved", "room_built", "review_done", "artifact_published"
                }:
                    os.fsync(f.fileno())
    except Exception as exc:  # noqa: BLE001 — an event log never fails the work it describes
        print(f"warning: {rec['kind']} event not written: {exc}", file=sys.stderr)


def _sequence(row: dict) -> int | None:
    value = row.get("sequence")
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def artifact_digest(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def record_artifact(directory: str | Path, kind: str, artifact_path: str | Path, **data) -> None:
    """Record content identity at publication, independently of later copies or mtime changes."""
    path = Path(artifact_path)
    record(directory, kind, artifact_digest=artifact_digest(path),
           artifact_size=path.stat().st_size, outcome="completed", **data)


# ── convenience hooks ────────────────────────────────────────────────────────
def on_image_generation(
    prompt: str,
    sheet,
    out,
    status: str,
    *,
    model: str | None = None,
    elapsed_sec: float | None = None,
    attempt: int | None = None,
    usage: dict | None = None,
    error: str | None = None,
) -> None:
    """Record one hosted reference-image generation call."""
    out = Path(out)
    event(
        "image_generation",
        name=out.parent.name,
        status=status,
        model=model,
        sheet=str(sheet),
        out=str(out),
        prompt_chars=len(prompt or ""),
        prompt_preview=(prompt or "").strip().replace("\n", " ")[:240],
        elapsed_sec=elapsed_sec,
        attempt=attempt,
        usage=usage,
        error=error,
    )


def stage(name: str, scan: str, status: str = "start", **data) -> None:
    """Mark a pipeline stage boundary (extract / crop / object_refs / ...).

    Writes the trace line AND renders the terminal's stage row. Every stage in the pipeline
    already calls this, so it is the one place a progress display can hook without touching a
    single stage's control flow. The trace is the record; the display is presentation and is
    allowed to be absent ($LR_QUIET=1, or a non-tty losing its colour).
    """
    event("stage", stage=name, scan=scan, status=status, **data)
    console.stage_event(name, scan, status, data)


def agent_step(agent: str, step: str, *, payload: dict | None = None, **data) -> None:
    """Record an agent action (reserved for articulated-object generation tracing).

    A larger ``payload`` (the agent's reasoning, tool args) is written as a
    sidecar JSON under ``traces/agent/`` and referenced from the timeline line.
    """
    ref = None
    d = _state["dir"]
    if payload is not None and d is not None:
        ref = f"agent/{uuid.uuid4().hex}_{agent}_{step}.json"
        (d / ref).write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    event("agent_step", agent=agent, step=step, payload_ref=ref, **data)
