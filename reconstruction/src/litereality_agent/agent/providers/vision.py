"""One-shot, read-only questions about images, routed to the role's harness.

Claude Code reads the listed paths with its Read tool; Codex receives them as
`--image` attachments. Callers stay provider-neutral and never import an SDK.
"""

from __future__ import annotations

from pathlib import Path

from litereality_agent.agent.providers.base import SessionResult, SessionSpec, resolve


async def ask_images(
    images,
    prompt: str,
    *,
    role: str,
    cwd: str | Path,
    model: str | None = None,
    labels: list[str] | None = None,
    timeout_seconds: float = 240,
    max_turns: int | None = None,
) -> str:
    """Return the model's final text answer; raise if the session did not complete."""
    paths = [Path(p).resolve() for p in images]
    lines = [
        f"- IMAGE {i + 1}{f' — {labels[i]}' if labels and labels[i] else ''}: {path}"
        for i, path in enumerate(paths)
    ]
    request = (
        "First look at every image, then answer.\n" + "\n".join(lines) + "\n\n" + prompt
        + "\nRead-only review: do not edit files or call another model."
    )
    spec = SessionSpec(
        prompt=request,
        cwd=Path(cwd),
        read_roots=tuple(dict.fromkeys(path.parent for path in paths)),
        images=tuple(paths),
        file_tools=("Read",),
        setting_sources=(),
        model=model,
        read_only=True,
        max_turns=max_turns or max(8, len(paths) + 4),
        step_budget=max(14, len(paths) + 4),
        timeout_seconds=timeout_seconds,
    )
    output, finished = "", False
    async for message in resolve(role).run(spec):
        if isinstance(message, SessionResult):
            if message.is_error or message.stopped:
                raise RuntimeError(f"image review incomplete: {message.stopped or message.result}")
            finished, output = True, message.result or ""
    if not finished or not output.strip():
        raise RuntimeError("image review returned no completed result")
    return output
