"""Low-cost session observations, without prompts, arguments, output or exception text.

One row is appended to spec.cwd/.litereality/agent-timing.jsonl. Keeping runtime
metadata in the hidden directory prevents input/cache fingerprints changing.
Only time spent awaiting the next harness message is partitioned. An outstanding
ToolUseBlock assigns that interval to tool_wait; otherwise it is model/harness
wait (including startup, transport and SDK work). Parallel tools count once.
These are observable stream intervals, not exact API, tool CPU or GPU timings.
Consumer processing between messages is separate. Native API duration, when the
SDK provides it, is independent of these intervals and must not be added to them.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import math
import os
import time
import uuid
from functools import wraps
from pathlib import Path

from litereality_agent.agent.providers.base import (
    AgentMessage,
    SessionResult,
    ToolResultBlock,
    ToolUseBlock,
)


def _append(cwd, record):
    # A short, locked append supports concurrent per-object agents sharing a room.
    # Observability is best effort: a read-only/full disk must not fail a paid run.
    try:
        directory = Path(cwd) / ".litereality"
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "agent-timing.jsonl").open("a", encoding="utf-8") as output:
            fcntl.flock(output, fcntl.LOCK_EX)
            output.write(json.dumps(record, allow_nan=False) + "\n")
            output.flush()
    except (OSError, TypeError, ValueError):
        pass


class SessionTiming:
    def __init__(self, provider, cwd):
        self.provider = provider
        self.cwd = cwd
        self.context = {key: os.environ.get(variable) or None for key, variable in (
            ("run_id", "LITEREALITY_RUN_ID"),
            ("attempt_id", "LITEREALITY_ATTEMPT_ID"),
            ("stage", "LITEREALITY_STAGE"),
        )}
        self.started = time.perf_counter()
        self.active = set()
        self.tool_calls = 0
        self.unmatched_results = 0
        self.tool_wait = 0.0
        self.model_wait = 0.0
        self.recorded = False

    async def next(self, stream):
        started = time.perf_counter()
        try:
            return await anext(stream)
        finally:
            elapsed = max(0.0, time.perf_counter() - started)
            if self.active:
                self.tool_wait += elapsed
            else:
                self.model_wait += elapsed

    def observe(self, message):
        if isinstance(message, AgentMessage):
            for block in message.content:
                if isinstance(block, ToolUseBlock) and block.id:
                    if block.id not in self.active:
                        self.tool_calls += 1
                    self.active.add(block.id)
                elif isinstance(block, ToolResultBlock):
                    if block.tool_use_id not in self.active:
                        self.unmatched_results += 1
                    self.active.discard(block.tool_use_id)

    def finish(self, outcome, *, result=None, error=None):
        if self.recorded:
            return
        self.recorded = True
        wall = max(0.0, time.perf_counter() - self.started)
        native = getattr(result.raw, "duration_api_ms", None) if result else None
        if self.provider != "claude" or isinstance(native, bool) or not isinstance(native, (int, float)) or not math.isfinite(native) or native < 0:
            native = None
        _append(self.cwd, {
            "schema": 1,
            "kind": "agent_session_timing",
            "session_id": uuid.uuid4().hex,
            "provider": self.provider,
            **self.context,
            "pid": os.getpid(),
            "ended_at": time.time(),
            "outcome": outcome,
            "error_type": type(error).__name__ if error is not None else None,
            "wall_seconds": wall,
            "observed_wait_seconds": self.tool_wait + self.model_wait,
            "tool_wait_seconds": self.tool_wait,
            "model_harness_wait_seconds": self.model_wait,
            "consumer_and_overhead_seconds": max(0.0, wall - self.tool_wait - self.model_wait),
            "api_seconds": native / 1000 if native is not None else None,
            "api_seconds_source": "claude.duration_api_ms" if native is not None else "unknown",
            "tool_calls_observed": self.tool_calls,
            "open_tools_at_end": len(self.active),
            "unmatched_tool_results": self.unmatched_results,
            "wait_source": "await_next_message_partitioned_by_outstanding_tool_ids",
        })


def record_session_timing(run):
    """Preserve the public messages and propagate failures/cancellation unchanged."""
    @wraps(run)
    async def timed(self, spec):
        timing = SessionTiming(self.name, spec.cwd)
        stream = run(self, spec)
        outcome, error = "completed", None
        try:
            while True:
                try:
                    message = await timing.next(stream)
                except StopAsyncIteration:
                    break
                timing.observe(message)
                if isinstance(message, SessionResult):
                    outcome = "failed" if message.is_error else "stopped" if message.stopped else "completed"
                    # Persist before yielding the terminal value: callers may break
                    # here and never request another item from the generator.
                    timing.finish(outcome, result=message)
                yield message
        except BaseException as exc:
            error = exc
            outcome = "cancelled" if isinstance(exc, asyncio.CancelledError) else "closed" if isinstance(exc, GeneratorExit) else "failed"
            raise
        finally:
            try:
                await stream.aclose()
            finally:
                timing.finish(outcome, error=error)

    return timed
