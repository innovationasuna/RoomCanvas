"""One check of the authored room (support, then an independent visual review: pass or not, no
score) and, when it does not pass, one bounded repair whose rebuilt room is the result.

What is checked is the complete room: the build of Room.py with the small objects and openable
parts the passes add to it (passes.py). A repair edits Room.py, so its build goes through the
passes again before it is the result.

No missing, failed or interrupted check is a pass. Sources and review candidates survive
failure; only an exact build that passed, or was repaired, can be reused as a completed stage.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from pathlib import Path

from litereality_agent.agent import providers
from litereality_agent.pipeline.room_qc.validate import validate
from litereality_agent.pipeline.support import run_module

SCHEMA = "support-first/2"


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fingerprint(room: Path, preview: Path) -> dict:
    files = sorted(
        p
        for p in room.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and not p.name.startswith(".")
    )
    return {
        "source": {str(p.relative_to(room)): digest(p) for p in files},
        "checks": {p.name: digest(p) for p in [
            Path(__file__), *(Path(__file__).parent.parent / "room_qc").glob("*.py")]},
        "build": {
            name: digest(preview / name) if (preview / name).is_file() else None
            for name in ("Room.glb", "room_layout.json", "manifest.json")
        },
    }


def done(report: dict) -> bool:
    """The room may go on: it passed the check, or failed it and was repaired once (then published)."""
    return report.get("accepted") is True or report.get("status") in ("repaired", "published")


def is_accepted(room: Path, preview: Path, name="author_acceptance.json") -> bool:
    try:
        report = json.loads((preview / name).read_text())
        return (
            report.get("schema") == SCHEMA
            and done(report)
            and report.get("fingerprint") == fingerprint(room, preview)
        )
    except (OSError, ValueError, TypeError):
        return False


def visual_accepted(review: dict) -> bool:
    return (
        review.get("pass") is True
        and review.get("issues") == []
        and review.get("all_objects_reviewed") is True
    )


def preserved_instances(seed: Path, room: Path) -> bool:
    """Manifest identities/membership cannot be edited away to satisfy the gate."""

    def identities(root):
        assets = json.loads((root / "manifest.json").read_text())["assets"]
        return {
            a["object"]: {k: a.get(k) for k in ("kind", "maps_to_prim", "represents_prims")}
            for a in assets
        }

    if identities(seed) != identities(room):
        return False
    # Editable procedural recipes may improve; bundled source mesh references may not vanish
    # or be replaced. Matching paths also prevents a repair from quietly swapping chair assets.
    for source in seed.rglob("*.glb"):
        target = room / source.relative_to(seed)
        if not target.is_file() or digest(source) != digest(target):
            return False
    return True


async def repair(room: Path, scan: Path, report: Path, *, steps: int, seconds: int, provider: str | None = None,
                 traces: Path | None = None):
    """One bounded repair session; its steps go to ``traces``/authoring_trace.repair.jsonl for the replay."""
    from litereality_agent.agent import evidence_pack
    from litereality_agent.agent.trace import AgentTrace

    # The operator's material reaches the repair as it reached the author (see evidence_pack).
    operator = evidence_pack.operator_material()
    harness = providers.resolve("author", provider)
    spec = providers.SessionSpec(
        cwd=room,
        read_roots=(scan, report.parent, *((operator,) if operator else ())),
        capability_scene=room,
        capability_tools=("render", "select_views", "check_collisions"),
        model="claude-opus-5",
        step_budget=steps,
        timeout_seconds=seconds,
        max_turns=steps + 10,
        prompt=f"""Repair this room's remaining support and visual defects.
Read {report} and its referenced validation/review evidence. Read Room.md and capture evidence
under {scan}. Edit only this room directory. Fix support FIRST: floor contacts, appropriate
table/shelf surfaces, wall attachments, every member of merged groups and chair stacks.
Use actual geometry, not bounding-box top heights. For articulated furniture declare
support_part on each supported group so it follows the correct moving link.
Preserve manifest identities, represents_prims, source neural meshes and articulated joints.
Do not delete difficult objects, add invisible supports, change checks or edit reports.
The checked room had its small objects rebuilt from the photographs and openable parts added
after Room.py was built (an object the layout marks `rebuilt` replaced the stand-in of that name
in Room.py): fix such an object through its stand-in, and the passes redo it on your result.
Inspect renders against photographs. Save valid Room.py frequently. Do not launch another
model. The supervisor will rebuild your result, add the small objects and openable parts again
and use it as the room. Budget: {steps} tool calls / {seconds} seconds. Return a concise summary
of fixes and unresolved problems."""
        + ("\n\n" + evidence_pack.OPERATOR.format(path=operator) if operator else ""),
    )
    tr = AgentTrace("repair", room=room, path=traces / "authoring_trace.repair.jsonl" if traces else None)
    extra = ({"operator": str(operator), "operator_digest": evidence_pack.operator_digest(operator)}
             if operator else {})
    tr.start(model=spec.model, provider=getattr(harness, "name", None), room=str(room), steps=steps,
             **extra)
    result = None
    async for event in harness.run(spec):
        tr.raw(getattr(event, "raw", None) if getattr(event, "raw", None) is not None else event)
        if isinstance(event, providers.SessionResult):
            result = event
        for block in getattr(event, "content", []) or []:
            kind = type(block).__name__
            if kind == "ToolUseBlock":
                tr.tool(getattr(block, "name", "?"), getattr(block, "input", {}) or {},
                        tool_id=getattr(block, "id", "") or "")
            elif kind == "TextBlock":
                tr.think(getattr(block, "text", ""))
            elif kind == "ToolResultBlock":
                tr.result(block)
    tr.end(summary=(getattr(result, "result", "") or "")[:2000])
    if result is None or result.is_error or result.stopped:
        raise RuntimeError(
            f"repair incomplete: {getattr(result, 'stopped', '') or getattr(result, 'result', 'no result')}"
        )


def assess(context, preview: Path, evidence: Path, room: Path | None = None) -> dict:
    """Check `room` (the passes' result; default the build itself) made from the build in `preview`."""
    from litereality_agent.agent.tools._vlm import vision

    room = room or preview
    evidence.mkdir(parents=True, exist_ok=True)
    report = {"schema": SCHEMA, "accepted": False, "status": "needs_repair"}
    try:
        report["fingerprint"] = fingerprint(context.authored_room, preview)
        report["instances_preserved"] = preserved_instances(
            context.seed_room, context.authored_room
        )
        geometry = validate(context.authored_room, room)
        (evidence / "validation.json").write_text(json.dumps(geometry, indent=2))
        report["validation"] = str(evidence / "validation.json")
        report["support_pass"] = geometry.get("pass") is True
        if not report["instances_preserved"] or not report["support_pass"]:
            return report
        rc, log = run_module(
            context,
            "litereality_agent.room_ops.rendering.room_render.render_vs_capture",
            [
                "--scan",
                context.capture_dir,
                "--room",
                context.authored_room,
                "--out",
                evidence / "compare",
                "--frames",
                "6",
                # The passes' room is rendered as they saved it; Room.py alone has neither.
                *(["--blend", room / "Room.blend"] if room != preview else []),
            ],
            log_name="acceptance_render",
        )
        pairs = sorted((evidence / "compare" / "pairs").glob("pair_*.png"))
        if rc or len(pairs) < 3:
            raise RuntimeError(
                f"independent review needs at least three successful capture pairs: {log}"
            )
        layout = json.loads((room / "room_layout.json").read_text())
        review = asyncio.run(
            vision(
                [str(p) for p in pairs],
                "Independently judge this reconstruction against the paired capture photographs. "
                "Check EVERY listed object, merged member, chair stack, support surface and opening. "
                "Check shape, scale, missing objects, materials and excessive lighting. "
                "Do not approve invisible/uncertain support or insufficient evidence. "
                "Return JSON: pass (boolean), all_objects_reviewed (boolean), "
                "issues (list of concrete unresolved defects with object IDs). "
                "A pass needs no issues and all objects reviewed. Layout: "
                + json.dumps(layout["objects"]),
                json_mode=True,
            )
        )
        (evidence / "visual_review.json").write_text(json.dumps(review, indent=2))
        report["review"] = str(evidence / "visual_review.json")
        report["visual_pass"] = visual_accepted(review)
        # Review/rendering must not change what was checked.
        unchanged = fingerprint(context.authored_room, preview) == report["fingerprint"]
        report["accepted"] = report["visual_pass"] and unchanged
        report["status"] = "accepted" if report["accepted"] else "needs_repair"
    except Exception as exc:
        report["error"] = f"{type(exc).__name__}: {exc}"
    return report


def _record_round(context, attempt: Path, number: int, evidence: Path, report: dict) -> None:
    """Trace this round's room model and verdict, so the replay does not rely on file times."""
    from litereality_agent import telemetry
    from litereality_agent.pipeline.scene_init.seed import saved

    rel = str(evidence.relative_to(context.scene_dir))
    saved(context, "round", evidence / "Room.glb", attempt=attempt.name, round=number)
    review = {}
    if report.get("review"):
        try:
            review = json.loads(Path(report["review"]).read_text())
        except (OSError, ValueError):
            review = {}
    telemetry.record(
        context.object_root / "traces", "review_done", attempt=attempt.name, round=number,
        folder=rel, passed=bool(review.get("pass")),
        accepted=bool(report.get("accepted")), reviewed=bool(review),
    )


def _build(context, preview: Path):
    return run_module(
        context,
        "litereality_agent.room_ops.compile.build_from_room",
        ["--room", context.authored_room, "--out", preview, "--regenerate"],
        log_name="acceptance_build",
    )


def _complete(context, preview: Path, options: dict) -> tuple[dict, Path]:
    """The passes on the build just made (passes.py), and the room they leave."""
    from litereality_agent.pipeline.realism_authoring import passes

    report = passes.run(context, options)
    for warning in report.pop("warnings"):
        print(f"[acceptance] {warning}", flush=True)
    return report, context.scene_dir / report["room"]


def finish(context, options: dict) -> dict:
    """Check the room once. If it does not pass, repair it once (a repair that runs out of its budget
    keeps what it saved) and rebuild: that room is the result, not checked again."""
    preview = context.authoring_root / "room_preview"
    fix = int(options.get("repair_rounds", 1))
    steps = int(options.get("repair_steps", 40))
    seconds = int(options.get("repair_seconds", 600))
    if fix not in (0, 1) or not 1 <= steps <= 150 or not 1 <= seconds <= 1800:
        raise ValueError("repair caps: repair_rounds 0 (check only) or 1, steps 1..150, seconds 1..1800")
    root = context.authoring_root / "acceptance"
    root.mkdir(parents=True, exist_ok=True)
    # Never overwrite an earlier attempt's evidence.
    import tempfile

    from litereality_agent import telemetry

    attempt = Path(tempfile.mkdtemp(prefix="attempt-", dir=root))
    rc, log = _build(context, preview)
    evidence = attempt / "round_00"
    evidence.mkdir()
    shutil.copytree(context.authored_room, evidence / "room", symlinks=True)
    passes, room = _complete(context, preview, options) if not rc else (None, preview)
    if not rc:
        for name in ("Room.glb", "room_layout.json", "manifest.json"):
            if (room / name).is_file():
                shutil.copy2(room / name, evidence / name)
    report = (
        assess(context, preview, evidence, room)
        if not rc
        else {"schema": SCHEMA, "accepted": False, "status": "needs_repair", "error": f"build failed: {log}"}
    )
    report["round"] = 0
    if passes:
        report["passes"] = passes
    path = evidence / "assessment.json"
    path.write_text(json.dumps(report, indent=2))
    _record_round(context, attempt, 0, evidence, report)
    preview.mkdir(parents=True, exist_ok=True)
    (preview / "author_acceptance.json").write_text(json.dumps(report, indent=2))
    if report["accepted"] or not fix or rc:
        return report
    note = None
    traces = context.object_root / "traces"
    telemetry.record(traces, "repair_start", attempt=attempt.name)
    try:
        asyncio.run(
            repair(
                context.authored_room, context.capture_dir, path, steps=steps, seconds=seconds,
                provider=options.get("provider"), traces=traces
            )
        )
    except Exception as exc:  # out of budget or interrupted: what it saved is still the room
        note = str(exc)
    rc, log = _build(context, preview)
    if rc:
        # The repair left a room that does not build: put the checked one back.
        shutil.rmtree(context.authored_room)
        shutil.copytree(evidence / "room", context.authored_room, symlinks=True)
        if not _build(context, preview)[0]:
            report["passes"] = _complete(context, preview, options)[0]
        report.update(status="needs_repair", error=f"repaired room does not build: {log}")
    else:
        # The repaired build gets its small objects and openable parts again, mostly from cache.
        report["passes"] = _complete(context, preview, options)[0]
        report.update(status="repaired", fingerprint=fingerprint(context.authored_room, preview))
    if note:
        report["repair_note"] = note
    telemetry.record(context.object_root / "traces", "repair_done", attempt=attempt.name,
                     status=report["status"], note=note)
    (preview / "author_acceptance.json").write_text(json.dumps(report, indent=2))
    return report
