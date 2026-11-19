"""Run Room.py authoring and its optional polish passes."""

import json
import shutil
import uuid

from litereality_agent import artifact_cache as cache
from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.fingerprint import input_fingerprint
from litereality_agent.pipeline.result import StageResult, StageStatus
from litereality_agent.pipeline.support import command_result, run_module


def complete(context: RunContext) -> bool:
    from litereality_agent.pipeline.realism_authoring.acceptance import is_accepted
    preview = context.authoring_root / "room_preview"
    return (is_accepted(context.authored_room, preview)
            or is_accepted(context.authored_room, preview, "acceptance.json"))


def run(context: RunContext, options: dict) -> StageResult:
    if not (context.seed_room / "Room.py").is_file():
        return StageResult("author", StageStatus.FAILED, error=f"missing seed room at {context.seed_room}")
    # The room records the inputs it was copied for. Starting over is committed to disk first
    # (`.author_pending`) and lasts until the new room is in place, so a failure or kill at any
    # step makes the next run start over again, whatever its options, instead of resuming.
    inputs = context.authoring_root / ".author_inputs"
    pending = context.authoring_root / ".author_pending"
    current = input_fingerprint(context, "author", options)
    restart = (cache.read_json(pending) or {}) if pending.exists() else None  # unreadable: still pending
    if (options.get("force") or (restart is not None and restart.get("inputs") != current)
            or (restart is None and context.authored_room.exists() and inputs.is_file()
                and inputs.read_text() != current)):
        restart = {"inputs": current}
        cache.atomic_json(pending, restart)
    evidence = context.authoring_root / "surface_ref" / "surface_ref_manifest.json"
    if not evidence.is_file() or (restart is not None and not restart.get("evidence")):
        evidence_rc, evidence_log = run_module(
            context,
            "litereality_agent.pipeline.realism_authoring.author.evidence",
            ["--scene", context.scene_dir],
            log_name="evidence",
        )
        if evidence_rc:
            return StageResult(
                "author",
                StageStatus.FAILED,
                error=f"scene evidence failed; see {evidence_log}",
            )
        if restart is not None:
            cache.atomic_json(pending, restart := {**restart, "evidence": True})
    if restart is not None and not restart.get("set_aside"):
        # The old room and its session files go to one backup, named before anything moves, so an
        # interrupted set-aside continues into the same folder instead of splitting or stacking.
        saved = [path for path in (context.authored_room, *(context.authoring_root / name for name in (
            ".room_checkpoint.py", ".room_checkpoint.d", ".author_resume.json", ".author_result.json",
            ".author_restore_pending.json", ".author_inputs"))) if path.exists()]
        if saved and not restart.get("backup"):
            name = f"before-author-{uuid.uuid4().hex[:8]}"
            cache.atomic_json(pending, restart := {**restart, "backup": name})
        for path in saved:
            backup = context.authoring_root / restart["backup"]
            backup.mkdir(exist_ok=True)
            shutil.move(str(path), str(backup / path.name))
        cache.atomic_json(pending, restart := {**restart, "set_aside": True})
    context.authored_room.parent.mkdir(parents=True, exist_ok=True)
    if not context.authored_room.exists():
        # Copy aside and rename into place: a half-copied seed is never taken for the room.
        copying = context.authored_room.with_name(".room-copying")
        shutil.rmtree(copying, ignore_errors=True)
        shutil.copytree(context.seed_room, copying)
        copying.rename(context.authored_room)
        inputs.write_text(current)
    elif restart is not None:
        inputs.write_text(current)  # renamed into place by the run that was then interrupted
    pending.unlink(missing_ok=True)
    args: list[object] = [
        "--scene", context.scene_dir,
        "--room", context.authored_room,
        "--surface-ref", context.authoring_root / "surface_ref",
        "--scan", context.capture_dir,
        "--profile", options.get("profile", "open"),
    ]
    if options.get("provider"):
        args += ["--provider", options["provider"]]
    # Budgets only when asked for: the entrypoint knows each profile's own defaults.
    for key, flag in (("max_turns", "--max-turns"), ("step_budget", "--step-budget")):
        if options.get(key) is not None:
            args += [flag, options[key]]
    (context.authoring_root / ".author_result.json").unlink(missing_ok=True)
    rc, log = run_module(
        context,
        "litereality_agent.pipeline.realism_authoring.author.entrypoint",
        args,
        log_name="author",
    )
    result = command_result(
        "author", rc, artifacts={"room": context.authored_room}, log=log,
    )
    if rc:
        return result

    # A ROOM THAT RAN OUT OF STEPS IS NOT A FINISHED ROOM. The step budget lands the session
    # gracefully and exits 0, which is right — hitting it means "time's up", not "this is broken",
    # and the work so far is kept. But it exits 0 through the same path as a room the model
    # considered done, so without this the two are indistinguishable from outside and a truncated
    # room is reported as a completed stage.
    try:
        summary = json.loads(
            (context.authored_room.parent / ".author_result.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        summary = {}
    result.details["session"] = summary
    if summary.get("session_ok") is not True:
        result.status = StageStatus.FAILED
        result.error = "needs_repair: authoring session incomplete; saved room retained"
        return result

    # THE GATE. Whatever the brief asked for, the question at the end is the same: could a physics
    # engine take this room? Answered from the build and written down beside it. It cannot run
    # before a compile has produced room_preview/, and the polish passes below rebuild, so it runs
    # last (see the end of this function).
    passes: list[tuple[str, str, list[object]]] = []
    if options.get("refine_objects"):
        refine_args: list[object] = [
            "--scene", context.scene_dir,
            "--room", context.authored_room,
            "--refroot", context.object_root / "object_init",
            "--scan", context.capture_dir,
            "--results", context.authoring_root / "obj_refine",
            "--concurrency", options.get("refine_concurrency", 2),
            "--budget", options.get("refine_budget", 8),
        ]
        if options.get("objects"):
            refine_args.extend(("--objects", options["objects"]))
        passes.append(
            (
                "object refinement",
                "litereality_agent.pipeline.realism_authoring.author.refine_objects",
                refine_args,
            )
        )
    if options.get("materials"):
        passes.append(
            (
                "materials",
                "litereality_agent.pipeline.realism_authoring.author.materials",
                [
                    "--scene", context.scene_dir,
                    "--room", context.authored_room,
                    "--surface-ref", context.authoring_root / "surface_ref",
                    "--scan", context.capture_dir,
                    "--refroot", context.object_root / "object_init",
                ],
            )
        )
    if options.get("quality_pass"):
        passes.append(
            (
                "model quality",
                "litereality_agent.pipeline.realism_authoring.author.quality",
                [
                    "--scene", context.scene_dir,
                    "--room", context.authored_room,
                    "--surface-ref", context.authoring_root / "surface_ref",
                    "--scan", context.capture_dir,
                    "--refroot", context.object_root / "object_init",
                ],
            )
        )

    for name, module, pass_args in passes:
        pass_rc, pass_log = run_module(
            context, module, pass_args, log_name=name.replace(" ", "_")
        )
        if pass_rc:
            result.warnings.append(f"{name} exited {pass_rc}; see {pass_log}")
            result.status = StageStatus.FAILED
            result.error = f"needs_repair: {name} did not finish; saved room retained"
            return result
    refinement = context.authoring_root / "obj_refine"
    if refinement.is_dir():
        result.artifacts["object_refinement"] = str(refinement)

    preview = context.authoring_root / "room_preview"
    # The gate reads the BUILD. A session that rendered has one; a session that stopped early
    # or only edited may not, and an unbuilt room is exactly the one whose claims nobody checked.
    # `Room.py` is valid Python here (author.run guarantees it), so build it once (~1-2 min).
    from litereality_agent.pipeline.realism_authoring.acceptance import done, finish
    report = finish(context, options)
    result.artifacts["acceptance"] = str(preview / "author_acceptance.json")
    result.details["acceptance"] = report
    if not done(report):
        result.status = StageStatus.FAILED
        result.error = "needs_repair: the check failed and no repaired room was built; source and evidence retained"
    return result
