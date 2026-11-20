"""Dependency-aware orchestration for the complete reconstruction workflow."""

from __future__ import annotations

import json
import os
import time
import uuid
from collections.abc import Iterable
from typing import Any
from unittest.mock import patch

from litereality_agent import telemetry
from litereality_agent.pipeline.context import RunContext
from litereality_agent.pipeline.result import StageResult, StageStatus
from litereality_agent.pipeline.stage import Stage
from litereality_agent.pipeline.stages import STAGES
from litereality_agent.timing import Measurement

PIPELINE = tuple(STAGES)


class PipelineError(RuntimeError):
    pass


class PipelineRunner:
    def __init__(self, stages: Iterable[Stage] = PIPELINE):
        self.stages = tuple(stages)
        self.by_name = {stage.name: stage for stage in self.stages}
        if len(self.by_name) != len(self.stages):
            raise ValueError("pipeline stage names must be unique")

    def _read_state(self, context: RunContext) -> dict[str, Any]:
        try:
            return json.loads(context.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"version": 1, "scan": context.scan, "stages": {}}

    def _write_state(self, context: RunContext, state: dict[str, Any]) -> None:
        context.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = context.state_path.with_suffix(".tmp")
        with tmp.open("w", encoding="utf-8") as stream:
            stream.write(json.dumps(state, indent=2, sort_keys=True))
            stream.flush()
            os.fsync(stream.fileno())
        tmp.replace(context.state_path)

    def _selection(self, start: str | None, through: str | None) -> tuple[Stage, ...]:
        names = [stage.name for stage in self.stages]
        if start and start not in self.by_name:
            raise PipelineError(f"unknown stage {start!r}; choose from {', '.join(names)}")
        if through and through not in self.by_name:
            raise PipelineError(f"unknown stage {through!r}; choose from {', '.join(names)}")
        left = names.index(start) if start else 0
        right = names.index(through) + 1 if through else len(names)
        if left >= right:
            raise PipelineError("--from must occur before --through")
        return self.stages[left:right]

    def run(
        self,
        context: RunContext,
        *,
        start: str | None = None,
        through: str | None = None,
        force: set[str] | None = None,
        strict: bool = False,
        options: dict[str, dict[str, Any]] | None = None,
    ) -> list[StageResult]:
        selected = self._selection(start, through)
        state = self._read_state(context)
        run_id = os.environ.get("LITEREALITY_RUN_ID") or uuid.uuid4().hex
        trace_environment = {
            "LITEREALITY_RUN_ID": run_id,
            "LITEREALITY_JOB_ID": os.environ.get("LITEREALITY_JOB_ID") or str(context.scene_dir.resolve()),
            "LITEREALITY_ATTEMPT_ID": os.environ.get("LITEREALITY_ATTEMPT_ID") or run_id,
        }
        prior = state.setdefault("stages", {})
        def invalidate(name):
            # No longer reusable, but not forced: it starts over only if its own inputs have
            # changed by the time it runs; otherwise it resumes its saved work.
            if name in prior:
                prior[name] = {**prior[name], "status": StageStatus.INVALIDATED.value,
                               "artifact_validity": "invalid"}
        def changed(stage, record, fingerprint):
            # A record from before fingerprints existed proves nothing either way: accept it.
            recorded = (record or {}).get("input_fingerprint")
            return stage.fingerprint is not None and recorded is not None and recorded != fingerprint
        force = force or set()
        unknown_force = force - self.by_name.keys()
        if unknown_force:
            raise PipelineError(f"unknown forced stage(s): {', '.join(sorted(unknown_force))}")

        forced_indexes = [i for i, stage in enumerate(self.stages) if stage.name in force]
        invalidate_from = min(forced_indexes) if forced_indexes else len(self.stages)
        for stage in self.stages[invalidate_from:]:
            invalidate(stage.name)
        if force:
            self._write_state(context, state)

        results: list[StageResult] = []
        completed = {
            name
            for name, value in prior.items()
            if value.get("status") in {StageStatus.COMPLETED.value, StageStatus.REUSED.value}
            and name in self.by_name
            and (self.by_name[name].is_complete is None or self.by_name[name].is_complete(context))
            and (self.by_name[name].fingerprint is None or not changed(self.by_name[name], value,
                 self.by_name[name].fingerprint(context, value.get("input_options", {}))))
        }
        for stage in selected:
            for prerequisite in stage.prerequisites:
                dependency = self.by_name[prerequisite]
                if (
                    prerequisite not in completed
                    and prior.get(prerequisite, {}).get("status") not in {"failed", "running", "invalidated"}
                    and dependency.is_complete is not None
                    and dependency.is_complete(context)
                    and (dependency.fingerprint is None or prerequisite not in prior)
                ):
                    reused = StageResult(prerequisite, StageStatus.REUSED)
                    prior[prerequisite] = reused.to_dict()
                    dependency_options = dict((options or {}).get(prerequisite, {}))
                    prior[prerequisite]["input_options"] = dependency_options
                    if dependency.fingerprint:
                        prior[prerequisite]["input_fingerprint"] = dependency.fingerprint(context, dependency_options)
                    completed.add(prerequisite)
            missing = [name for name in stage.prerequisites if name not in completed]
            if missing:
                raise PipelineError(
                    f"stage {stage.name!r} requires {', '.join(missing)}; "
                    "run the prerequisites or start earlier"
                )

            old = prior.get(stage.name)
            stage_options = dict((options or {}).get(stage.name, {}))
            # `revise` asks for one more run of a stage that is complete, without the restart `force`
            # means (author: another session on the finished room, for the operator's follow-up
            # requests). Like `force` it belongs to this invocation, not to what the result is made from.
            cache_options = {key: value for key, value in stage_options.items() if key not in ("force", "revise")}
            fingerprint = stage.fingerprint(context, cache_options) if stage.fingerprint else None
            inputs_changed = changed(stage, old, fingerprint)
            # Enabling DINO on an existing run must rerun ingest and invalidate its consumers.
            same_options = (old is not None and old.get("input_options", {}) == cache_options
                            and not inputs_changed)
            complete_on_disk = stage.is_complete(context) if stage.is_complete else False
            if (stage.name not in force and not stage_options.get("revise") and old and same_options
                    and complete_on_disk
                    and StageResult.from_dict(old).ok):
                result = StageResult.from_dict(old)
                result.status = StageStatus.REUSED
            else:
                # Any rebuilt input invalidates its downstream results, even without --force.
                for dependent in self.stages[self.stages.index(stage) + 1:]:
                    invalidate(dependent.name)
                    completed.discard(dependent.name)
                started = time.monotonic()
                if stage.name in force or inputs_changed:
                    stage_options.setdefault("force", True)
                # Commit loss of validity before touching any stage files. A killed process
                # must never leave yesterday's completed marker certifying a partial rebuild.
                running = StageResult(stage.name, StageStatus.RUNNING, artifact_validity="invalid",
                                      details={"forced": bool(stage_options.get("force"))})
                prior[stage.name] = {**running.to_dict(), "input_options": cache_options,
                                     "input_fingerprint": fingerprint}
                self._write_state(context, state)
                timing_attempts = []
                for attempt in range(1, 3):
                    measurement = Measurement()
                    try:
                        # Restore the caller's environment after the compatibility bridge.
                        with patch.dict(os.environ, {**context.environment, **trace_environment,
                                                    "LITEREALITY_STAGE": stage.name}, clear=True):
                            result = stage.run(context, stage_options)
                    except Exception as exc:
                        result = StageResult.failure(stage.name, exc)
                    timing_attempts.append({"attempt": attempt, "outcome": result.status.value,
                                            **measurement.finish()})
                    result.details["execution_attempts"] = attempt
                    result.details["timing_attempts"] = timing_attempts.copy()
                    result.details["forced"] = bool(stage_options.get("force"))
                    if result.ok or not result.retryable or attempt == 2:
                        break
                    time.sleep(0.25)
                result.duration_seconds = time.monotonic() - started

            results.append(result)
            if result.artifact_validity == "unknown" and result.ok and result.artifacts_exist():
                result.artifact_validity = "valid"
            if not result.ok:
                result.details["fatal"] = bool(stage.required or strict)
            prior[stage.name] = result.to_dict()
            prior[stage.name]["input_options"] = cache_options
            if stage.fingerprint:
                prior[stage.name]["input_fingerprint"] = stage.fingerprint(context, cache_options)
            self._write_state(context, state)
            telemetry.record(context.object_root / "traces", "pipeline_stage", stage=stage.name,
                             outcome=result.status.value, error_category=result.error_category,
                             retryable=result.retryable, artifact_validity=result.artifact_validity,
                             duration_seconds=0. if result.status == StageStatus.REUSED else result.duration_seconds,
                             timing_attempts=[] if result.status == StageStatus.REUSED else result.details.get("timing_attempts", []),
                             run=run_id, job_id=trace_environment["LITEREALITY_JOB_ID"],
                             attempt_id=trace_environment["LITEREALITY_ATTEMPT_ID"])
            if result.ok:
                completed.add(stage.name)
                continue
            if stage.required or strict:
                break
        return results

    def run_stage(
        self,
        context: RunContext,
        name: str,
        *,
        force: bool = False,
        strict: bool = False,
        options: dict[str, Any] | None = None,
    ) -> StageResult:
        if name not in self.by_name:
            raise PipelineError(f"unknown stage {name!r}")
        results = self.run(
            context,
            start=name,
            through=name,
            force={name} if force else set(),
            strict=strict,
            options={name: options or {}},
        )
        return results[0]
