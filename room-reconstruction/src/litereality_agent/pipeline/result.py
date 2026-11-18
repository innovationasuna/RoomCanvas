"""Stable result types shared by all pipeline stages."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class StageStatus(str, Enum):
    RUNNING = "running"
    INVALIDATED = "invalidated"
    COMPLETED = "completed"
    REUSED = "reused"
    SKIPPED = "skipped"
    FAILED = "failed"


class StageFailure(RuntimeError):
    """A failure whose retry policy is known at the boundary that detects it.

    ``category="input"`` is only for a failure that the same scan and settings can never get past; the
    job then refuses a retry. ``retryable`` asks the runner to run the stage again at once.
    """

    def __init__(self, message: str, category: str = "execution", *, retryable: bool = False):
        super().__init__(message)
        self.category, self.retryable = category, retryable


@dataclass(slots=True)
class StageResult:
    stage: str
    status: StageStatus
    duration_seconds: float = 0.0
    artifacts: dict[str, str] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    error: str | None = None
    details: dict[str, Any] = field(default_factory=dict)
    error_category: str | None = None
    retryable: bool = False
    artifact_validity: str = "unknown"

    @property
    def ok(self) -> bool:
        return self.status in {StageStatus.COMPLETED, StageStatus.REUSED, StageStatus.SKIPPED}

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = self.status.value
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "StageResult":
        return cls(
            stage=str(data["stage"]),
            status=StageStatus(data["status"]),
            duration_seconds=float(data.get("duration_seconds", 0.0)),
            artifacts={str(k): str(v) for k, v in data.get("artifacts", {}).items()},
            warnings=[str(item) for item in data.get("warnings", [])],
            error=data.get("error"),
            details=dict(data.get("details", {})),
            error_category=data.get("error_category"),
            retryable=bool(data.get("retryable", False)),
            artifact_validity=str(data.get("artifact_validity", "unknown")),
        )

    @classmethod
    def failure(cls, stage: str, error: Exception) -> "StageResult":
        if isinstance(error, StageFailure):
            category, retryable = error.category, error.retryable
        elif isinstance(error, (TimeoutError, ConnectionError)):
            category, retryable = "transient", True
        else:
            # A ValueError or missing file deep inside a stage does not prove the input is bad:
            # it is not retried at once, but the job can still be retried.
            category, retryable = "execution", False
        return cls(stage, StageStatus.FAILED, error=str(error), error_category=category,
                   retryable=retryable, artifact_validity="invalid")

    def artifacts_exist(self) -> bool:
        return bool(self.artifacts) and all(Path(value).exists() for value in self.artifacts.values())
