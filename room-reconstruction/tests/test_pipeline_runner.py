from __future__ import annotations

import os
from pathlib import Path

import pytest

from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.result import StageResult, StageStatus
from litereality_agent.pipeline.runner import PipelineRunner
from litereality_agent.pipeline.stage import Stage
from litereality_agent.settings import LiteRealitySettings


def context(tmp_path: Path) -> RunContext:
    settings = LiteRealitySettings(repo_root=tmp_path, output_root=tmp_path / "run")
    return RunContext("scan", tmp_path / "capture", tmp_path / "run" / "scan", tmp_path / "run", settings=settings)


def result(name: str, status: StageStatus = StageStatus.COMPLETED) -> StageResult:
    return StageResult(name, status, artifacts={"marker": __file__})


@pytest.mark.parametrize("error,expected", [(TimeoutError("temporarily busy"), 2), (ValueError("bad capture"), 1),
                                            (FileNotFoundError("missing mesh"), 1)])
def test_only_transient_failures_retry_with_a_fixed_limit(tmp_path, monkeypatch, error, expected):
    calls = []
    monkeypatch.setattr("litereality_agent.pipeline.runner.time.sleep", lambda _: None)
    def fail(*_):
        calls.append(1)
        raise error
    value, = PipelineRunner((Stage("only", fail),)).run(context(tmp_path))
    assert len(calls) == expected
    assert value.status is StageStatus.FAILED and value.artifact_validity == "invalid"
    assert value.retryable == isinstance(error, TimeoutError)
    # Only a stage that knows its input is at fault marks it so; that alone makes the job unretryable.
    assert value.error_category == ("transient" if isinstance(error, TimeoutError) else "execution")
    attempts = value.details['timing_attempts']
    assert [a['attempt'] for a in attempts] == list(range(1, expected+1))
    assert all(a['outcome'] == 'failed' and a['wall_seconds'] >= 0 for a in attempts)
    assert value.duration_seconds >= sum(a['wall_seconds'] for a in attempts)


def test_content_change_forces_stage_and_consumers_even_with_same_size_and_time(tmp_path):
    source = tmp_path / "source"
    source.write_text("first")
    before = source.stat()
    calls = []
    stages = (
        Stage("first", lambda _, opts: calls.append(("first", opts.copy())) or result("first"),
              is_complete=lambda _: True, fingerprint=lambda *_: source.read_text()),
        Stage("next", lambda _, opts: calls.append(("next", opts.copy())) or result("next"),
              ("first",), is_complete=lambda _: True),
    )
    runner = PipelineRunner(stages)
    runner.run(context(tmp_path))
    source.write_text("other")
    os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
    runner.run(context(tmp_path))
    assert calls[-2:] == [("first", {"force": True}), ("next", {"force": True})]


def test_killed_force_rebuild_never_reuses_partial_files_or_downstream_success(tmp_path):
    import json
    target = tmp_path / "model"
    interrupt, calls = False, []
    def build(_, options):
        calls.append(dict(options))
        target.write_text("PARTIAL" if interrupt else "GOOD")
        if interrupt:
            raise KeyboardInterrupt()
        return StageResult("build", StageStatus.COMPLETED, artifacts={"model": str(target)})
    runner = PipelineRunner((
        Stage("build", build, is_complete=lambda _: target.exists()),
        Stage("publish", lambda *_: result("publish"), ("build",), is_complete=lambda _: True),
    ))
    ctx = context(tmp_path)
    runner.run(ctx)
    interrupt = True
    with pytest.raises(KeyboardInterrupt):
        runner.run(ctx, force={"build"})
    state = json.loads(ctx.state_path.read_text())["stages"]
    assert state["build"]["status"] == "running"
    assert state["publish"]["status"] == "invalidated"
    interrupt = False
    resumed = runner.run(ctx)
    assert resumed[0].status is StageStatus.COMPLETED and calls[-1]["force"]
    assert target.read_text() == "GOOD"


def test_optional_failure_does_not_stop_later_stages(tmp_path):
    called = []
    stages = (
        Stage("required", lambda *_: called.append("required") or result("required")),
        Stage(
            "optional",
            lambda *_: called.append("optional") or result("optional", StageStatus.FAILED),
            ("required",),
            required=False,
        ),
        Stage("publish", lambda *_: called.append("publish") or result("publish"), ("required",)),
    )
    results = PipelineRunner(stages).run(context(tmp_path))
    assert called == ["required", "optional", "publish"]
    assert results[1].details["fatal"] is False


def test_strict_promotes_optional_failure_and_stops(tmp_path):
    called = []
    stages = (
        Stage("required", lambda *_: result("required")),
        Stage(
            "optional",
            lambda *_: result("optional", StageStatus.FAILED),
            ("required",),
            required=False,
        ),
        Stage("publish", lambda *_: called.append("publish") or result("publish"), ("required",)),
    )
    results = PipelineRunner(stages).run(context(tmp_path), strict=True)
    assert [item.stage for item in results] == ["required", "optional"]
    assert results[-1].details["fatal"] is True
    assert called == []


def test_completed_stage_is_reused_when_artifacts_remain(tmp_path):
    calls = []
    stage = Stage(
        "only",
        lambda *_: calls.append(1) or result("only"),
        is_complete=lambda _: True,
    )
    runner = PipelineRunner((stage,))
    first = runner.run(context(tmp_path))[0]
    second = runner.run(context(tmp_path))[0]
    assert first.status is StageStatus.COMPLETED
    assert second.status is StageStatus.REUSED
    assert calls == [1]


def test_force_is_forwarded_to_stage_and_invalidates_dependents(tmp_path):
    received = []
    stages = (
        Stage("first", lambda _, options: received.append(options) or result("first")),
        Stage("second", lambda *_: result("second"), ("first",)),
    )
    runner = PipelineRunner(stages)
    runner.run(context(tmp_path))
    runner.run(context(tmp_path), force={"first"})
    assert received == [{}, {"force": True}]


def test_stage_receives_context_settings_without_leaking_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("LITEREALITY_OUTPUT", "callers-value")
    observed = []
    stage = Stage(
        "only",
        lambda *_: observed.append(os.environ["LITEREALITY_OUTPUT"]) or result("only"),
    )
    PipelineRunner((stage,)).run(context(tmp_path))
    assert observed == [str(tmp_path / "run")]
    assert os.environ["LITEREALITY_OUTPUT"] == "callers-value"


def test_single_stage_discovers_existing_prerequisite_artifacts(tmp_path):
    called = []
    stages = (
        Stage("seed", lambda *_: result("seed"), is_complete=lambda _: True),
        Stage("publish", lambda *_: called.append("publish") or result("publish"), ("seed",)),
    )
    output = PipelineRunner(stages).run_stage(context(tmp_path), "publish")
    assert output.status is StageStatus.COMPLETED
    assert called == ["publish"]


def test_enabling_dino_invalidates_cached_ingest_and_consumers(tmp_path):
    calls = []
    stages = (
        Stage("ingest", lambda _, options: calls.append(("ingest", dict(options))) or result("ingest"),
              is_complete=lambda _: True),
        Stage("reconstruct", lambda *_: calls.append(("reconstruct", {})) or result("reconstruct"),
              ("ingest",), is_complete=lambda _: True),
    )
    runner = PipelineRunner(stages)
    runner.run(context(tmp_path))
    runner.run(context(tmp_path), options={"ingest": {"use_dino": True}})
    reused = runner.run(context(tmp_path), options={"ingest": {"use_dino": True}})
    assert calls == [("ingest", {}), ("reconstruct", {}),
                     ("ingest", {"use_dino": True, "force": True}), ("reconstruct", {})]
    assert all(r.status is StageStatus.REUSED for r in reused)


def test_failed_prerequisite_is_not_resurrected_by_leftover_files(tmp_path):
    import pytest

    from litereality_agent.pipeline.runner import PipelineError
    runner = PipelineRunner((
        Stage('author', lambda *_: result('author', StageStatus.FAILED), is_complete=lambda _: True),
        Stage('publish', lambda *_: result('publish'), ('author',)),
    ))
    ctx = context(tmp_path)
    runner.run(ctx)
    with pytest.raises(PipelineError, match='requires author'):
        runner.run_stage(ctx, 'publish')


def test_rebuilt_stale_input_invalidates_downstream_cache(tmp_path):
    calls, current = [], {'first': True}
    runner = PipelineRunner((
        Stage('first', lambda *_: calls.append('first') or result('first'),
              is_complete=lambda _: current['first']),
        Stage('last', lambda *_: calls.append('last') or result('last'), ('first',),
              is_complete=lambda _: True),
    ))
    ctx = context(tmp_path)
    runner.run(ctx)
    current['first'] = False
    runner.run(ctx)
    assert calls == ['first', 'last', 'first', 'last']
