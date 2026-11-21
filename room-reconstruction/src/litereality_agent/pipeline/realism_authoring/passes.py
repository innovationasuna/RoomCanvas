"""The two passes that complete the authored room before it is checked: small objects, then openable
parts (small_objects/, articulate/). `acceptance.finish` runs them on each build it checks or makes
by repair, so the room that is checked, repaired and published has them.

Each pass works on the room before it and writes its own folder beside the room, as when it runs on
its own: realism_authoring/small_objects/ takes the build in room_preview/, and
realism_authoring/articulate/ the small objects' room. The last room made is the result. A pass
that fails is recorded and left out (the room goes on without what it would have added), as the
openable parts after publishing used to leave the published room as it was. Both resume from what
they left on disk, and on a rebuilt room keep the work of every item that did not change
(pass_cache.carry), so running them again after a repair costs only what the repair changed.
"""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path

from litereality_agent import telemetry
from litereality_agent.pipeline.support import run_module

SMALL, PARTS = "small_objects", "articulate"


def _set(values: dict) -> None:
    for name, value in values.items():
        if value is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = str(value)


@contextmanager
def environment(**values):
    """The passes' environment for a while: each name set to its value, or unset for None."""
    before = {name: os.environ.get(name) for name in values}
    _set(values)
    try:
        yield
    finally:
        _set(before)


def run(context, options: dict) -> dict:
    """Both passes on the build in room_preview/; returns {"room": the room to check, relative to
    the scene, "small_objects": "ok"|"partial"|"failed", "articulate": "ok"|"partial"|"failed"|"skipped",
    "left": {pass: ids it could not do} when partial, "warnings"}.
    Their records say stage "author" also when publish runs them on a new build: the replay tells
    them from the passes an older flow ran over the published room on their own."""
    with environment(LITEREALITY_STAGE="author"):
        return _run(context, options)


def _left(out, key: str) -> list:
    """What a pass that finished could not do, from its summary.json (`undone` items, `failed_objects`)."""
    try:
        left = json.loads((out / "summary.json").read_text()).get(key) or []
    except (OSError, ValueError, AttributeError):
        return []
    return left if isinstance(left, list) else []


def _run(context, options: dict) -> dict:
    from litereality_agent.pipeline.realism_authoring import pass_cache
    from litereality_agent.pipeline.scene_init.seed import saved

    build = context.preview_dir
    traces = context.object_root / "traces"
    report = {"warnings": []}
    room = build
    out = context.authoring_root / SMALL
    rc, log = run_module(context, f"litereality_agent.pipeline.realism_authoring.{SMALL}",
                         [context.scene_dir, "--out", out], log_name=SMALL)
    try:
        # Its whole result, made from this build (not one left from an earlier build).
        made = pass_cache.published_room(out / "room_preview", build) if not rc else None
    except ValueError as exc:
        made, rc = None, str(exc)
    if made is not None:
        room = made
        left = _left(out, "undone")
        report[SMALL] = "partial" if left else "ok"
        if left:
            report["left"] = {SMALL: left}
            report["warnings"].append(f"small objects left {len(left)} item(s) as the author made them: "
                                      f"{', '.join(left)}; see {out / 'summary.md'}")
        saved(context, SMALL, made / "Room.glb", stage="author")
    else:
        report[SMALL] = "failed"
        report["warnings"].append(f"small objects did not finish ({rc}); see {log}")
    if options.get("articulate", True):
        out = context.authoring_root / PARTS
        start = {"source": str(room)} if room != build else {}
        telemetry.record(traces, "articulate_start", stage="author", **start)
        with environment(LR_ARTICULATE_SOURCE=room if room != build else None):
            rc, log = run_module(context, f"litereality_agent.pipeline.realism_authoring.{PARTS}",
                                 [context.scene_dir, "--out", out], log_name=PARTS)
        parts = out / "room_preview"
        ok = not rc and (parts / "Room.glb").is_file()
        left = _left(out, "failed_objects") if ok else []
        telemetry.record(traces, "articulate_done", stage="author", status="ok" if ok else "failed",
                         exit=rc, **({"failed": len(left)} if left else {}))
        if ok:
            room = parts
            saved(context, "articulated", parts / "Room.glb", stage="author")
            report[PARTS] = "partial" if left else "ok"
            if left:
                report.setdefault("left", {})[PARTS] = left
                report["warnings"].append(f"openable parts were not worked out for {len(left)} object(s): "
                                          f"{', '.join(left)}; see {out / 'summary.md'}")
        else:
            report[PARTS] = "failed"
            report["warnings"].append(f"openable parts did not finish (exit {rc}); see {log}")
    else:
        report[PARTS] = "skipped"
    if room != build:
        manifest(build, room)
    report["room"] = str(room.relative_to(context.scene_dir))
    return report


def manifest(build: Path, room: Path) -> None:
    """What the check reads beside a pass's layout (validate): the build's asset manifest, each
    asset's mesh named where the build has it. The pass's own Object/ holds only what it added,
    and the check compares each object's motion with its source there."""
    doc = json.loads((build / "manifest.json").read_text())
    for asset in doc.get("assets", []):
        if asset.get("glb"):
            asset["glb"] = os.path.relpath(build / asset["glb"], room)
    (room / "manifest.json").write_text(json.dumps(doc, indent=2))


def main(argv=None) -> int:
    """The check of a pass's room as author makes it (validate, with `manifest`), for any room_preview/,
    e.g. one an older flow's pass wrote on its own; nothing is written beside that room.

        python -m litereality_agent.pipeline.realism_authoring.passes <scene>/realism_authoring \\
            <a pass's room_preview> [--json report.json]
    """
    import argparse
    import sys
    import tempfile

    from litereality_agent.pipeline.room_qc.validate import summary, validate

    parser = argparse.ArgumentParser(description=main.__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("authoring", type=Path, help="realism_authoring/ (room/ and the build in room_preview/)")
    parser.add_argument("room", type=Path, help="the pass's room_preview/ (Room.glb, room_layout.json)")
    parser.add_argument("--json", type=Path, help="write the full report here")
    args = parser.parse_args(argv)
    authoring, room = args.authoring.resolve(), args.room.resolve()
    with tempfile.TemporaryDirectory(prefix="pass-check-") as folder:
        folder = Path(folder).resolve()  # relative paths from here to the build
        for name in ("Room.glb", "room_layout.json", "Object"):
            if (room / name).exists():
                (folder / name).symlink_to(room / name)
        manifest(authoring / "room_preview", folder)
        report = validate(authoring / "room", folder)
    if args.json:
        args.json.write_text(json.dumps(report, indent=1))
    print(summary(report))
    sys.stdout.flush()
    return 0 if report.get("pass") else (2 if report.get("ok") else 1)


if __name__ == "__main__":
    raise SystemExit(main())
