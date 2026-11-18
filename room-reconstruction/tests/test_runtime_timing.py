import json

from litereality_agent import timing


def test_provider_observations_do_not_invalidate_room_content(tmp_path):
    from litereality_agent.agent.providers.timing import SessionTiming
    from litereality_agent.pipeline.fingerprint import _files
    (tmp_path / 'Room.py').write_text('pass\n')
    before = _files(tmp_path)
    SessionTiming('codex', tmp_path).finish('completed')
    assert (tmp_path / '.litereality/agent-timing.jsonl').is_file()
    assert _files(tmp_path) == before


def test_cpu_and_wall_are_distinct_observations(monkeypatch):
    clocks = iter([10., 13.])
    cpus = iter([(5., 20.), (5.5, 24.)])
    monkeypatch.setattr(timing.time, "monotonic", lambda: next(clocks))
    monkeypatch.setattr(timing, "cpu_seconds", lambda: next(cpus))
    assert timing.Measurement().finish() == {
        "wall_seconds": 3., "process_cpu_seconds": .5, "finished_children_cpu_seconds": 4.,
    }


def test_report_preserves_unknowns_and_does_not_charge_cached_stage_history(tmp_path):
    (tmp_path / 'job.json').write_text(json.dumps({'timing': {'queue_seconds': 2}}))
    attempt = tmp_path / 'run/attempt-02'
    attempt.mkdir(parents=True)
    (attempt / 'runtime-timing.json').write_text(json.dumps({
        'gpu_wait_seconds': 3., 'gpu_lease_seconds': 10., 'gpu_kernel_seconds': None, 'phases': [],
    }))
    state = tmp_path / 'run/pipeline/scan/.litereality'
    state.mkdir(parents=True)
    (state / 'pipeline.json').write_text(json.dumps({'stages': {'cached': {
        'status': 'reused', 'duration_seconds': 100., 'details': {'timing_attempts': [{'wall_seconds': 100.}]},
    }}}))
    (state / 'agent-timing.jsonl').write_text('{"api_seconds": null}\n{"interrupted')
    result = timing.report(tmp_path)
    assert result['queue']['queue_seconds'] == 2
    assert result['stages'][0]['duration_seconds'] == 0 and result['stages'][0]['attempts'] == []
    assert result['attempts'][0]['gpu_kernel_seconds'] is None
    assert len(result['providers']) == 1 and result['providers'][0]['api_seconds'] is None
