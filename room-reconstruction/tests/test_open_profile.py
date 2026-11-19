"""The `open` profile: a brief with the evidence pack, its own budgets, and the codex harness by default."""

from __future__ import annotations

from litereality_agent.agent import author


def test_open_is_a_registered_profile_with_larger_budgets():
    assert "open" in author.PROFILES
    assert author.OPEN_STEP_BUDGET > 100 and author.OPEN_MAX_TURNS > 140


def test_the_open_brief_points_at_the_pack_and_the_gate():
    text = author.OPEN_PROMPT.format(
        stitch_lines="", scan="/s", surface_list="Wall0", rhythm="", evidence="/a/evidence",
        n_frames=59, python="/py", blender="/bl", scratch="/sc")
    assert "/a/evidence/helpers" in text and "measure.probe_depth" in text
    assert "litereality_agent.pipeline.room_qc.validate" in text and "/py -m" in text
    assert "rests_on=" in text and "fetch_material" in text
    # freedom, stated: the process is the model's, the result is gated
    assert "HOW YOU WORK IS YOURS" in text
    assert "EDIT `Room.py` AT LEAST ONCE EVERY" not in text


def test_the_scripted_profiles_still_format_with_the_extra_fields():
    for name in ("base", "detail", "simulation"):
        author.PROFILES[name].format(stitch_lines="", scan="/s", surface_list="Wall0", rhythm=author.RHYTHM,
                                     evidence="", n_frames=0, python="", blender="", scratch="")


def test_entrypoint_defaults_budgets_per_profile(monkeypatch):
    import sys

    from litereality_agent.pipeline.realism_authoring.author import entrypoint

    seen = {}

    async def fake_run(room, surface_ref, scan, model, max_turns, profile, **kw):
        seen.update(max_turns=max_turns, profile=profile, **kw)
        return 0

    monkeypatch.setattr(entrypoint, "run", fake_run)
    monkeypatch.delenv("AUTHOR_STEPS", raising=False)
    for profile, turns, steps in (("open", author.OPEN_MAX_TURNS, author.OPEN_STEP_BUDGET), ("simulation", 140, 100)):
        monkeypatch.setattr(sys, "argv", ["x", "--room", "/r", "--surface-ref", "/s", "--scan", "/c", "--profile", profile])
        try:
            entrypoint.main()
        except SystemExit:
            pass
        assert (seen["max_turns"], seen["step_budget"]) == (turns, steps), profile


# ── operator material (LR_AUTHOR_EXTRA) ──────────────────────────────────────


def _author(tmp_path, monkeypatch, profile="open"):
    """One author session against a stand-in harness; returns (exit, room, spec, trace start)."""
    import asyncio
    from pathlib import Path

    from litereality_agent.agent import evidence_pack, providers
    from litereality_agent.agent.trace import AgentTrace

    room = tmp_path / "scene" / "realism_authoring" / "room"
    refs, scan = tmp_path / "refs", tmp_path / "scan"
    for folder in (room, refs, scan):
        folder.mkdir(parents=True, exist_ok=True)
    if not (room / "Room.py").exists():
        (room / "Room.py").write_text("x = 1\n")
    seen = {}

    class Harness:
        name = "test"
        supports = frozenset()

        def effective_model(self, spec):
            return spec.model

        async def run(self, spec):
            seen["spec"] = spec
            yield providers.SessionResult(result="done")

    def build(root, *_args, **_kwargs):  # the pack itself is covered in test_evidence_kit
        pack = Path(root) / "evidence"
        pack.mkdir(exist_ok=True)
        return pack

    monkeypatch.setattr(evidence_pack, "build", build)
    monkeypatch.setattr(providers, "resolve", lambda *_args: Harness())
    monkeypatch.setattr(AgentTrace, "start", lambda self, **fields: seen.update(start=fields))
    monkeypatch.setattr(author, "surfaces_for", lambda _room: [])
    monkeypatch.setattr("litereality_agent.agent.scratch.bind", lambda **_kwargs: None)
    monkeypatch.setattr("litereality_agent.agent.scratch.prompt_line", lambda: "")
    rc = asyncio.run(author.run(room, refs, scan, "test", 1, profile))
    return rc, room, seen.get("spec"), seen.get("start")


def _material(tmp_path):
    material = tmp_path / "operator-material"
    (material / "previous" / "materials").mkdir(parents=True)
    (material / "README.md").write_text("Make the rules board a flat panel from photos/board.jpg.\n")
    (material / "previous" / "Room.py").write_text("SHELL = {}\n")
    linked = tmp_path / "material-link"  # an operator may name it through a link
    linked.symlink_to(material)
    return material, linked


def test_operator_material_is_linked_readable_briefed_and_traced(tmp_path, monkeypatch):
    from litereality_agent.agent import evidence_pack

    material, linked = _material(tmp_path)
    monkeypatch.setenv("LR_AUTHOR_EXTRA", str(linked))
    rc, room, spec, start = _author(tmp_path, monkeypatch)
    assert rc == 0
    pack = room.parent / "evidence"
    assert (pack / "operator").is_symlink() and (pack / "operator").resolve() == material.resolve()
    assert str(material.resolve()) in spec.roots()
    assert "OPERATOR MATERIAL" in spec.prompt and f"`{pack / 'operator'}/`" in spec.prompt
    assert "README.md before anything else" in spec.prompt and "never its coordinates" in spec.prompt
    assert "rectify_image" in (pack / "helpers" / "rectify.py").read_text()  # what the paragraph names
    assert start["operator"] == str(material.resolve())
    assert start["operator_digest"] == evidence_pack.operator_digest(material.resolve())

    # Another profile has no pack: the paragraph names the folder itself.
    _, _, spec, _ = _author(tmp_path, monkeypatch, profile="simulation")
    assert f"`{material.resolve()}/`" in spec.prompt


def test_without_operator_material_the_brief_and_roots_are_as_before(tmp_path, monkeypatch):
    material, linked = _material(tmp_path)
    monkeypatch.setenv("LR_AUTHOR_EXTRA", str(linked))
    _author(tmp_path, monkeypatch)
    monkeypatch.delenv("LR_AUTHOR_EXTRA")
    rc, room, spec, start = _author(tmp_path, monkeypatch)
    assert rc == 0
    assert "OPERATOR MATERIAL" not in spec.prompt
    assert str(material.resolve()) not in spec.roots()
    assert not (room.parent / "evidence" / "operator").exists()  # the old link goes too
    assert "operator" not in start and "operator_digest" not in start


def test_operator_material_without_a_readme_stops_the_author(tmp_path, monkeypatch):
    (tmp_path / "empty").mkdir()
    monkeypatch.setenv("LR_AUTHOR_EXTRA", str(tmp_path / "empty"))
    rc, _, spec, _ = _author(tmp_path, monkeypatch)
    assert rc == 1 and spec is None


def test_operator_material_is_no_input_identity(tmp_path, monkeypatch):
    """Editing the README must neither restart the author nor retire its checkpoint."""
    from litereality_agent import artifact_cache as cache
    from litereality_agent.pipeline.context import RunContext
    from litereality_agent.pipeline.fingerprint import input_fingerprint
    from litereality_agent.settings import LiteRealitySettings

    material, linked = _material(tmp_path)
    _author(tmp_path, monkeypatch)
    room = tmp_path / "scene" / "realism_authoring" / "room"
    key = cache.read_json(room.parent / ".author_resume.json")["input_fingerprint"]
    monkeypatch.setenv("LR_AUTHOR_EXTRA", str(linked))
    _, _, spec, start = _author(tmp_path, monkeypatch)
    (material / "README.md").write_text("Changed my mind about the board.\n")
    _, _, spec, changed = _author(tmp_path, monkeypatch)
    assert cache.read_json(room.parent / ".author_resume.json")["input_fingerprint"] == key
    assert "inputs and configuration match" in spec.prompt
    assert not (room.parent / ".stale").exists(), "no checkpoint was retired"
    assert changed["operator_digest"] != start["operator_digest"]  # the trace still tells them apart

    settings = LiteRealitySettings(_env_file=None, repo_root=tmp_path)
    context = RunContext("scan", tmp_path / "scan", tmp_path / "scene", tmp_path, settings=settings)
    with_material = input_fingerprint(context, "author", {})
    monkeypatch.delenv("LR_AUTHOR_EXTRA")
    assert input_fingerprint(context, "author", {}) == with_material


def test_the_repair_session_gets_the_same_paragraph(tmp_path, monkeypatch):
    import asyncio

    from litereality_agent.agent import providers
    from litereality_agent.pipeline.realism_authoring import acceptance

    material, linked = _material(tmp_path)
    room, scan = tmp_path / "room", tmp_path / "scan"
    room.mkdir()
    scan.mkdir()
    report = tmp_path / "round_00" / "assessment.json"
    report.parent.mkdir()
    report.write_text("{}")
    specs = []

    class Harness:
        name = "test"

        async def run(self, spec):
            specs.append(spec)
            yield providers.SessionResult(result="fixed")

    monkeypatch.setattr(providers, "resolve", lambda *_args: Harness())
    for value in (str(linked), None):
        if value:
            monkeypatch.setenv("LR_AUTHOR_EXTRA", value)
        else:
            monkeypatch.delenv("LR_AUTHOR_EXTRA")
        asyncio.run(acceptance.repair(room, scan, report, steps=5, seconds=60))
    briefed, plain = specs
    assert "OPERATOR MATERIAL" in briefed.prompt and str(material.resolve()) in briefed.roots()
    assert "OPERATOR MATERIAL" not in plain.prompt
    assert plain.roots() == sorted({str(scan), str(report.parent)})
