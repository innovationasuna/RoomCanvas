import json
import multiprocessing
import os

from litereality_agent import telemetry


def writer(path, worker):
    for index in range(12):
        telemetry.record(path, "stage", stage="publish", outcome="completed",
                         event_id=f"{worker}-{index}", run=f"run-{worker}")


def test_process_writers_deduplicate_and_recover_tail(tmp_path):
    ctx = multiprocessing.get_context("spawn")
    workers = [ctx.Process(target=writer, args=(tmp_path, i)) for i in range(3)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(20)
        assert worker.exitcode == 0
    with (tmp_path / "trace.jsonl").open("ab") as stream:
        stream.write(b'{"t":')
    telemetry.record(tmp_path, "stage", event_id="0-0")
    telemetry.record(tmp_path, "stage", event_id="last", outcome="failed")
    rows = [json.loads(line) for line in (tmp_path / "trace.jsonl").read_text().splitlines()]
    assert len(rows) == 37
    assert [row["sequence"] for row in rows] == list(range(1, 38))
    assert len({row["event_id"] for row in rows}) == 37
    assert rows[-1]["outcome"] == "failed"


def test_publication_digest_survives_copy_time(tmp_path):
    model = tmp_path / "Room.glb"
    model.write_bytes(b"model")
    telemetry.record_artifact(tmp_path, "model_saved", model, at=42, model="final")
    os.utime(model, (99, 99))
    row = json.loads((tmp_path / "trace.jsonl").read_text())
    assert row["t"] == 42 and row["artifact_digest"] == telemetry.artifact_digest(model)


def test_legacy_writer_between_versioned_events_does_not_reset_sequence(tmp_path):
    telemetry.record(tmp_path, "stage")
    with (tmp_path / "trace.jsonl").open("a") as stream:
        for index in range(4):
            stream.write(json.dumps({"t": index, "kind": "legacy"}) + "\n")
    telemetry.record(tmp_path, "stage")
    rows = [json.loads(line) for line in (tmp_path / "trace.jsonl").read_text().splitlines()]
    assert rows[-1]["sequence"] == 2


def test_an_unwritable_or_malformed_trace_never_fails_the_caller(tmp_path, capsys):
    trace = tmp_path / "trace.jsonl"
    trace.write_text(json.dumps({"kind": "x", "sequence": 3}) + "\n" + json.dumps({"kind": "x", "sequence": None}) + "\n")
    telemetry.record(tmp_path, "stage")
    assert json.loads(trace.read_text().splitlines()[-1])["sequence"] == 4
    trace.chmod(0o444)
    telemetry.record(tmp_path, "stage")
    assert "stage event not written" in capsys.readouterr().err


def test_an_unwritable_agent_payload_still_records_the_step(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(telemetry, "_state", {"scan": None, "dir": None, "t0": None})
    traces = telemetry.start("scan", tmp_path / "traces")
    (traces / "agent").chmod(0o555)
    try:
        telemetry.agent_step("procedural", "plan", payload={"thought": "x"})
    finally:
        (traces / "agent").chmod(0o755)
    row = json.loads((traces / "trace.jsonl").read_text().splitlines()[-1])
    assert row["kind"] == "agent_step" and row["payload_ref"] is None
    assert "payload not written" in capsys.readouterr().err
