"""Publish the final room, plus the review artifacts that go with it.

The final room is the one author checked: the build of `room/` with the small objects and openable
parts the passes added (realism_authoring/passes.py), published into `room_preview/` and baked.
Publishing rebuilds only when that build is no longer the current one (the room or the check code
changed since), and then runs the passes on the new build as author did. It checks the geometry of
the published layout; quality warnings travel with the published model.

Everything publishable lands in `room_preview/` next to the build it describes. `room/` stays the
one editable source; the preview tree is the one place to LOOK. Publishing used to also copy
`Room.py` and `Room.glb` up to the authoring root, which left the same room in three places with
nothing marking which was canonical.

One thing is made here that the room itself is not: the real-vs-render comparison, the room
rendered from the capture's own ARKit poses beside the photo taken there, which is the only
artifact that answers "is this actually the room?" rather than "does this look like a room?". It
costs minutes, so it is last and it is optional.

`Room.web.glb` — the Draco copy a browser is handed — is NOT made here. It is derived from
`Room.glb` and nothing but a viewer ever reads it, so building it at publish time spent a Blender
launch on every run whether or not anyone ever looked at the room. `viewable_room` makes it on the
first `view` of a given build instead, and `compress.compressed` keeps it for every later one.
"""

from __future__ import annotations

import json
import os
import shutil

from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.result import StageResult, StageStatus
from litereality_agent.pipeline.support import run_module

# The room as a browser wants it: same geometry and clips, roughly a quarter the bytes. Named
# beside `Room.glb` rather than hidden, because it is the one to upload if a room is ever served
# from somewhere other than this repo — a cache by lifecycle, an artifact by usefulness.
WEB_GLB_NAME = "Room.web.glb"
# Enough frames to see whether the room matches the capture, few enough not to dominate a publish.
DEFAULT_COMPARE_FRAMES = 6


def compare_frames(options: dict) -> int:
    """How many real-vs-render pairs to build. `0` (or `COMPARE_FRAMES=0`) skips the pass."""
    raw = options.get("compare_frames")
    if raw is None:
        raw = os.environ.get("COMPARE_FRAMES", DEFAULT_COMPARE_FRAMES)
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return DEFAULT_COMPARE_FRAMES


def complete(context: RunContext) -> bool:
    from litereality_agent.pipeline.realism_authoring.acceptance import is_accepted
    return is_accepted(context.authored_room, context.preview_dir, "acceptance.json")


def published_room(context: RunContext):
    """The room to hand a viewer, smallest first, or None if this run has not published one.

    Publishing names both files, so choosing between them belongs here rather than in whatever is
    doing the looking. The web copy wins only while it is at least as new as the build it came
    from — otherwise a rebuilt room would be shown inside last publish's geometry.
    """
    built = context.preview_dir / "Room.glb"
    web = context.preview_dir / WEB_GLB_NAME
    try:
        if web.is_file() and built.is_file() and web.stat().st_mtime >= built.stat().st_mtime:
            return web
    except OSError:
        pass
    return built if built.is_file() else None


def require_published(context: RunContext):
    room = published_room(context)
    if room is None:
        raise SystemExit(
            f"no published room for {context.scan} — expected {context.preview_dir / 'Room.glb'}\n"
            f"  build it with:  litereality stage publish {context.scene_dir}"
        )
    return room


def viewable_room(context: RunContext):
    """The body to hand a browser, compressing one if this build has not been viewed yet.

    `require_published` answers "which of the two files is current"; this answers "and make the
    small one if it isn't there", which is the whole difference between a viewer that needs a
    publish flag set and one that just works. Costs a Blender launch on the first view of a given
    build and nothing on every later one, because `compressed` caches beside the room.

    No Blender is a slower page, not a failure: `compress` hands back the full-size room and the
    viewer serves that.
    """
    from litereality_agent.room_ops import compress

    room = require_published(context)
    if room.name == WEB_GLB_NAME:
        return room
    print("compressing the room for the browser — once per build, then cached")
    made = compress.compressed(room, context.preview_dir / WEB_GLB_NAME)
    if made == room:
        print("  no Blender for the web copy; serving the full-size room")
    return made


def run(context: RunContext, options: dict) -> StageResult:
    warnings: list[str] = []
    collision_rc, collision_log = run_module(
        context,
        "litereality_agent.pipeline.room_qc.correct",
        ["--room", context.authored_room],
        log_name="publish_collision",
    )
    if collision_rc:
        warnings.append(f"collision correction exited {collision_rc}; see {collision_log}")
    from litereality_agent.pipeline.realism_authoring import passes as finishing
    from litereality_agent.pipeline.realism_authoring.acceptance import SCHEMA, fingerprint
    from litereality_agent.room_ops import api

    # The room was checked once by author (and repaired if it failed); publishing does not check again.
    checked = {}
    try:
        checked = json.loads((context.authoring_root / "room_preview" / "author_acceptance.json").read_text())
    except (OSError, ValueError):
        pass
    completed = checked.get("passes")
    blend = context.preview_dir / "Room.blend"
    glb = context.preview_dir / "Room.glb"
    # The checked build is still the room's (author's last build, nothing changed since): publish it
    # as it was checked, with what the passes made of it, instead of building it again.
    current = (completed is not None and blend.is_file()
               and checked.get("fingerprint") == fingerprint(context.authored_room, context.preview_dir)
               and (context.scene_dir / completed["room"] / "Room.blend").is_file())
    acceptance = context.preview_dir / "acceptance.json"
    acceptance.unlink(missing_ok=True)
    if not current:
        (context.authored_room / ".compile_stamp").unlink(missing_ok=True)
        rc, log = run_module(
            context, "litereality_agent.room_ops.compile.build_from_room",
            ["--room", context.authored_room, "--out", context.preview_dir, "--regenerate", "--require-blend"],
            log_name="publish_compile",
        )
        if rc or not glb.is_file() or not glb.stat().st_size:
            return StageResult("publish", StageStatus.FAILED, error=f"final compile failed; see {log}")
        if completed is not None:  # author completed its build with the passes: so is this one
            completed = finishing.run(context, {"articulate": completed.get("articulate") != "skipped"})
            warnings += completed.pop("warnings")
    room = context.scene_dir / completed["room"] if completed else context.preview_dir
    if room != context.preview_dir:
        # The passes' room becomes the published one; the build it was made from is replaced.
        if api.save_blend_as(room / "Room.blend", blend):
            return StageResult("publish", StageStatus.FAILED,
                               error=f"could not publish {room}; see {context.preview_dir / 'save_as.log'}")
        shutil.copyfile(room / "room_layout.json", context.preview_dir / "room_layout.json")
        if (room / "Object").is_dir():  # the small objects' meshes their layout names
            shutil.copytree(room / "Object", context.preview_dir / "Object", dirs_exist_ok=True)
    # Flatten node-graph SHELL materials into the glb. `build_from_room` only EXPORTS; the bake is
    # the step `compile_room` adds on top, and the agent's own compile/render tool goes through
    # `compile_room` — so every render the author sees is baked. Publishing without it silently
    # shipped a different room: a procedural wall/floor/ceiling material (`two_tone_mat`,
    # `carpet_mat`, `ceiling_tile_mat`) has no glTF representation, so it exports with neither a
    # texture nor a baseColorFactor and renders WHITE. Flat-RGB and fetched-image materials
    # survive either way, which is why this stayed invisible until a room used procedural ones.
    bake_rc = api.bake_room(blend, glb, required=True)
    if bake_rc:
        return StageResult("publish", StageStatus.FAILED,
                           error=f"material bake failed; see {context.preview_dir / 'bake.log'}; candidate retained at {glb}")
    layout = context.preview_dir / "room_layout.json"
    if layout.is_file():
        quality_rc, quality_log = run_module(
            context, "litereality_agent.pipeline.room_qc.checks",
            ["--layout", layout, "--shell", context.authored_room / "Room.py"],
            log_name="publish_quality",
        )
        if quality_rc:
            warnings.append(f"scene quality check did not pass; see {quality_log}")
    else:
        warnings.append("scene quality check skipped: this build produced no room_layout.json")
    from litereality_agent.pipeline.scene_init.seed import saved
    saved(context, "final", glb)

    report = {"schema": SCHEMA, "status": "published", "accepted": checked.get("accepted") is True,
              "checked": checked.get("status"), "fingerprint": fingerprint(context.authored_room, context.preview_dir)}
    if completed is not None:
        report["passes"] = completed
    acceptance.write_text(json.dumps(report, indent=2))

    frames = compare_frames(options)
    if frames and context.capture_dir.is_dir():
        compare = context.authoring_root / "compare"
        print(f"rendering {frames} real-vs-render comparisons")
        compare_rc, compare_log = run_module(
            context, "litereality_agent.room_ops.rendering.room_render.render_vs_capture",
            ["--scan", context.capture_dir, "--room", context.authored_room,
             "--out", compare, "--frames", frames,
             *(["--blend", blend] if room != context.preview_dir else [])],
            log_name="publish_compare",
        )
        if compare_rc:
            warnings.append(f"comparison renders exited {compare_rc}; see {compare_log}")

    print(f"\nwalk it:  uv run litereality view {context.scene_dir}")
    return StageResult(
        "publish", StageStatus.COMPLETED,
        artifacts={
            "room_source": str(context.authored_room / "Room.py"),
            "room_glb": str(glb),
            "acceptance": str(acceptance),
        },
        warnings=warnings,
    )
