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

import os
import shutil
from contextlib import contextmanager

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
    the scene, "small_objects": "ok"|"failed", "articulate": "ok"|"failed"|"skipped", "warnings"}.
    Their records say stage "author" also when publish runs them on a new build: the replay tells
    them from the passes an older flow ran over the published room on their own."""
    with environment(LITEREALITY_STAGE="author"):
        return _run(context, options)


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
        report[SMALL] = "ok"
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
        telemetry.record(traces, "articulate_done", stage="author", status="ok" if ok else "failed",
                         exit=rc)
        if ok:
            room = parts
            saved(context, "articulated", parts / "Room.glb", stage="author")
            report[PARTS] = "ok"
        else:
            report[PARTS] = "failed"
            report["warnings"].append(f"openable parts did not finish (exit {rc}); see {log}")
    else:
        report[PARTS] = "skipped"
    if room != build:
        # What the check reads beside the layout (validate): the asset manifest of the build.
        shutil.copyfile(build / "manifest.json", room / "manifest.json")
    report["room"] = str(room.relative_to(context.scene_dir))
    return report
