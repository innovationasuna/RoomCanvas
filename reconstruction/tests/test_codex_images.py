"""Image questions on Codex: attachments, routing, and failure reporting. No model calls."""

import asyncio
import sys

from litereality_agent.agent.providers.base import SessionResult, SessionSpec
from litereality_agent.agent.providers.codex import CodexHarness

COMPLETED = "import json; print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'{\"ok\": true}'}})); print(json.dumps({'type':'turn.completed','usage':{}}))"


def run_codex(monkeypatch, spec):
    seen = []
    real_spawn = asyncio.create_subprocess_exec

    async def fake_spawn(*args, **kwargs):
        seen.append(list(args))
        return await real_spawn(sys.executable, "-u", "-c", COMPLETED, **kwargs)

    monkeypatch.setattr("shutil.which", lambda _: "/fake/codex")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)

    async def collect():
        return [event async for event in CodexHarness().run(spec)]

    events = asyncio.run(collect())
    return seen[0], next(e for e in events if isinstance(e, SessionResult))


def test_codex_attaches_images_and_ends_the_list_before_the_prompt(monkeypatch, tmp_path):
    a, b = tmp_path / "a.jpg", tmp_path / "b.jpg"
    command, _ = run_codex(
        monkeypatch, SessionSpec(prompt="look", cwd=tmp_path, images=(a, b), read_only=True)
    )
    assert command[command.index(str(a)) - 1] == "--image"
    assert command[command.index(str(b)) - 1] == "--image"
    assert command[-2] == "--" and command[-1].endswith("look")


def test_codex_without_images_is_unchanged(monkeypatch, tmp_path):
    command, _ = run_codex(monkeypatch, SessionSpec(prompt="look", cwd=tmp_path))
    assert "--image" not in command and "--" not in command


def test_ask_images_returns_the_codex_answer(monkeypatch, tmp_path):
    from litereality_agent.agent.providers.vision import ask_images

    monkeypatch.delenv("LR_AGENT_PROVIDER", raising=False)
    seen = []
    real_spawn = asyncio.create_subprocess_exec

    async def fake_spawn(*args, **kwargs):
        seen.append(list(args))
        return await real_spawn(sys.executable, "-u", "-c", COMPLETED, **kwargs)

    monkeypatch.setattr("shutil.which", lambda _: "/fake/codex")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
    image = tmp_path / "frame.jpg"
    answer = asyncio.run(ask_images([image], "classify", role="agent", cwd=tmp_path))
    assert answer == '{"ok": true}'
    assert str(image.resolve()) in seen[0] and "--sandbox" in seen[0]


def test_layout_proposal_reports_failures_instead_of_a_timeout(monkeypatch, tmp_path):
    from litereality_agent.pipeline.scene_init.layout import agent

    monkeypatch.delenv("LR_AGENT_PROVIDER", raising=False)
    monkeypatch.setattr(agent, "_context", lambda *a: {"reference_images": [str(tmp_path / "r.jpg")]})
    monkeypatch.setattr("shutil.which", lambda _: None)  # codex missing
    proposal = agent.propose({}, None, tmp_path)
    assert proposal["action"] == "none"
    assert proposal["why"].startswith("agent failed: RuntimeError: codex CLI not on PATH")
