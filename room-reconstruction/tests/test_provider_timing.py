"""Session timing is an observation, never a reason to change a paid run's result."""

import asyncio
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from litereality_agent.agent.providers import timing
from litereality_agent.agent.providers.base import (
    AgentMessage,
    SessionResult,
    SessionSpec,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)


class Clock:
    now = 0

    def advance(self, seconds):
        self.now += seconds


def records(folder):
    return [json.loads(line) for line in (folder / ".litereality/agent-timing.jsonl").read_text().splitlines()]


def fake_harness(run, provider="codex"):
    return type("FakeHarness", (), {"name": provider, "run": timing.record_session_timing(run)})()


def test_waits_are_disjoint_with_parallel_tools_and_exclude_consumer_work(tmp_path, monkeypatch):
    clock = Clock()
    monkeypatch.setattr(timing.time, "perf_counter", lambda: clock.now)
    messages = [
        AgentMessage([ToolUseBlock("a", "render", {"secret": "private prompt"})]),
        AgentMessage([ToolUseBlock("b", "render", {})]),
        AgentMessage([ToolResultBlock("a", "private result")]),
        AgentMessage([TextBlock("model text while a tool is still pending")]),
        AgentMessage([ToolResultBlock("b", "private result")]),
        SessionResult(result="private answer", raw=SimpleNamespace(duration_api_ms=2400)),
    ]

    async def stream(self, spec):
        for seconds, message in zip([2, 3, 5, 7, 11, 13], messages):
            clock.advance(seconds)
            yield message

    async def consume():
        out = []
        async for message in fake_harness(stream, "claude").run(SessionSpec("secret", tmp_path)):
            out.append(message)
            clock.advance(100)  # e.g. checkpoint compilation in the caller
        return out

    assert asyncio.run(consume()) == messages
    row, = records(tmp_path)
    assert row["wall_seconds"] == 541
    assert row["observed_wait_seconds"] == 41
    assert row["tool_wait_seconds"] == 26
    assert row["model_harness_wait_seconds"] == 15
    assert row["consumer_and_overhead_seconds"] == 500
    assert row["tool_calls_observed"] == 2
    assert row["open_tools_at_end"] == 0
    assert row["api_seconds"] == 2.4
    assert row["api_seconds_source"] == "claude.duration_api_ms"
    assert "private" not in json.dumps(row) and "secret" not in json.dumps(row)


@pytest.mark.parametrize("provider,native", [("codex", 1000), ("claude", None),
                                            ("claude", -1), ("claude", float("nan")),
                                            ("claude", True)])
def test_missing_or_invalid_native_duration_remains_unknown(tmp_path, provider, native):
    async def stream(self, spec):
        yield SessionResult(raw=SimpleNamespace(duration_api_ms=native))

    async def consume():
        return [message async for message in fake_harness(stream, provider).run(SessionSpec("p", tmp_path))]

    asyncio.run(consume())
    row, = records(tmp_path)
    assert row["api_seconds"] is None and row["api_seconds_source"] == "unknown"


def test_failure_keeps_exception_identity_and_closes_stream(tmp_path):
    error = RuntimeError("private failure details")
    closed = []

    async def stream(self, spec):
        try:
            yield AgentMessage([TextBlock("private prompt")])
            raise error
        finally:
            closed.append(True)

    async def consume():
        return [message async for message in fake_harness(stream).run(SessionSpec("secret", tmp_path))]

    with pytest.raises(RuntimeError) as caught:
        asyncio.run(consume())
    assert caught.value is error and closed == [True]
    row, = records(tmp_path)
    assert row["outcome"] == "failed" and row["error_type"] == "RuntimeError"
    assert "private" not in json.dumps(row)


def test_cancelled_wait_is_recorded_and_underlying_stream_is_closed(tmp_path, monkeypatch):
    clock, closed = Clock(), []
    monkeypatch.setattr(timing.time, "perf_counter", lambda: clock.now)

    async def consume():
        waiting = asyncio.Event()

        async def stream(self, spec):
            try:
                clock.advance(2)
                yield AgentMessage([ToolUseBlock("a", "render", {})])
                waiting.set()
                await asyncio.Event().wait()
            finally:
                closed.append(True)

        source = fake_harness(stream).run(SessionSpec("p", tmp_path))
        await anext(source)
        task = asyncio.create_task(anext(source))
        await waiting.wait()
        clock.advance(7)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(consume())
    row, = records(tmp_path)
    assert row["outcome"] == "cancelled" and row["error_type"] == "CancelledError"
    assert row["model_harness_wait_seconds"] == 2 and row["tool_wait_seconds"] == 7
    assert row["open_tools_at_end"] == 1 and closed == [True]


def test_early_close_and_terminal_error_are_not_reported_as_success(tmp_path):
    closed = []

    async def stream(self, spec):
        try:
            yield AgentMessage([TextBlock("one")])
            yield SessionResult(is_error=True)
        finally:
            closed.append(True)

    async def consume():
        source = fake_harness(stream).run(SessionSpec("p", tmp_path))
        await anext(source)
        await source.aclose()
        source = fake_harness(stream).run(SessionSpec("p", tmp_path))
        await anext(source)
        result = await anext(source)
        assert result.is_error
        assert records(tmp_path)[-1]["outcome"] == "failed"  # written before terminal yield
        await source.aclose()

    asyncio.run(consume())
    assert [row["outcome"] for row in records(tmp_path)] == ["closed", "failed"]
    assert closed == [True, True]


def test_unwritable_observation_file_does_not_hide_result_or_failure(tmp_path, monkeypatch):
    def denied(*args, **kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "open", denied)
    result, failure = SessionResult(stopped="budget"), ValueError("original")

    async def stream(self, spec):
        yield result

    async def broken(self, spec):
        if False:
            yield
        raise failure

    async def consume():
        assert [message async for message in fake_harness(stream).run(SessionSpec("p", tmp_path))] == [result]
        with pytest.raises(ValueError) as caught:
            _ = [message async for message in fake_harness(broken).run(SessionSpec("p", tmp_path))]
        assert caught.value is failure

    asyncio.run(consume())


def test_concurrent_sessions_append_complete_rows(tmp_path):
    def write(index):
        subprocess.run([sys.executable, "-c", (
            "import sys\n"
            "from litereality_agent.agent.providers.timing import SessionTiming\n"
            "for _ in range(5): SessionTiming('codex', sys.argv[1]).finish('completed')\n"
        ), str(tmp_path)], check=True, capture_output=True, timeout=15)

    with ThreadPoolExecutor(max_workers=8) as workers:
        list(workers.map(write, range(8)))
    rows = records(tmp_path)
    assert len(rows) == len({row["session_id"] for row in rows}) == 40


def test_timing_does_not_change_stage_input_fingerprint(tmp_path):
    from litereality_agent.pipeline.fingerprint import _files

    (tmp_path / "Room.py").write_text("room = 'unchanged'\n")
    before = _files(tmp_path)
    timing.SessionTiming("codex", tmp_path).finish("completed")
    timing.SessionTiming("claude", tmp_path).finish("failed")
    assert _files(tmp_path) == before
    assert len(records(tmp_path)) == 2


def test_actual_claude_harness_uses_native_api_duration(tmp_path, monkeypatch):
    class ResultMessage:
        result = "done"
        duration_api_ms = 1250

    async def query(**kwargs):
        yield ResultMessage()

    monkeypatch.setitem(sys.modules, "claude_agent_sdk", SimpleNamespace(
        ClaudeAgentOptions=lambda **kwargs: kwargs, HookMatcher=lambda **kwargs: kwargs,
        ResultMessage=ResultMessage, query=query))
    from litereality_agent.agent.providers.claude import ClaudeHarness

    async def consume():
        return [message async for message in ClaudeHarness().run(SessionSpec("secret", tmp_path))]

    result, = asyncio.run(consume())
    assert result.result == "done"
    row, = records(tmp_path)
    assert row["provider"] == "claude" and row["api_seconds"] == 1.25


def test_run_attempt_and_stage_belong_to_the_session_start(tmp_path, monkeypatch):
    for key in ("LITEREALITY_RUN_ID", "LITEREALITY_ATTEMPT_ID", "LITEREALITY_STAGE"):
        monkeypatch.delenv(key, raising=False)
    unknown = timing.SessionTiming("claude", tmp_path)
    monkeypatch.setenv("LITEREALITY_RUN_ID", "run-a")
    monkeypatch.setenv("LITEREALITY_ATTEMPT_ID", "attempt-02")
    monkeypatch.setenv("LITEREALITY_STAGE", "author")
    captured = timing.SessionTiming("claude", tmp_path)
    monkeypatch.setenv("LITEREALITY_STAGE", "publish")
    unknown.finish("completed")
    captured.finish("stopped")
    first, second = records(tmp_path)
    assert all(first[key] is None for key in ("run_id", "attempt_id", "stage"))
    assert (second["run_id"], second["attempt_id"], second["stage"]) == ("run-a", "attempt-02", "author")
    assert second["outcome"] == "stopped"


def test_actual_codex_harness_logs_start_failure_without_swallowing_it(tmp_path, monkeypatch):
    from litereality_agent.agent.providers.codex import CodexHarness

    monkeypatch.setattr("shutil.which", lambda _: None)

    async def consume():
        return [message async for message in CodexHarness().run(SessionSpec("secret", tmp_path))]

    with pytest.raises(RuntimeError, match="codex CLI not on PATH"):
        asyncio.run(consume())
    row, = records(tmp_path)
    assert row["provider"] == "codex" and row["outcome"] == "failed"
    assert row["api_seconds"] is None
