"""TRELLIS service for an isolated local process runtime.

Symmetric with ModalTrellisService (same Generation3DService interface), so `reconstructor`
calls it the same way.

Needs the TRELLIS.2 GPU environment selected by `$LITEREALITY_TRELLIS_PYTHON`. The canonical
inference module is used by default and can be overridden with `$LITEREALITY_TRELLIS_LAUNCHER`.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from litereality_agent import PACKAGE_ROOT  # the launcher is CODE, shipped in the wheel
from litereality_agent import artifact_cache as cache

DEFAULT_LAUNCHER = PACKAGE_ROOT / "models" / "trellis" / "inference.py"


def _resolve_python(explicit: str | None) -> str:
    for c in (
        explicit,
        os.environ.get("LITEREALITY_TRELLIS_PYTHON"),
    ):
        if c and Path(c).exists():
            return str(c)
    raise RuntimeError(
        "Local TRELLIS requires an explicit TRELLIS_PYTHON/LITEREALITY_TRELLIS_PYTHON."
    )


class LocalTrellisService:
    name = "trellis-local"

    def __init__(
        self, *, python: str | None = None, launcher: str | None = None, parallel: int = 1
    ) -> None:
        self.python = _resolve_python(python)
        self.launcher = Path(
            launcher or os.environ.get("LITEREALITY_TRELLIS_LAUNCHER") or DEFAULT_LAUNCHER
        )
        self.parallel = parallel
        self.last_report: dict | None = None

    # -- Generation3DService -----------------------------------------------------
    def reconstruct(
        self, images: list[Any], *, out_dir: str, asset_id: str = "asset", **opts: Any
    ) -> str:
        image = images[0] if isinstance(images, (list, tuple)) else images
        return self.reconstruct_many({asset_id: image}, out_dir=out_dir, **opts)[asset_id]

    def reconstruct_many(
        self,
        items: dict[str, Any],
        *,
        out_dir: str,
        seed: int = 42,
        simplify: float = 0.95,  # simplify accepted (hosted parity), unused locally
        decimation: int = 50000,
        texture_size: int = 4096,
        pipeline_type: str | None = None,
        skip_existing: bool = True,
    ) -> dict[str, str]:
        """{asset_id: image(path|PIL)} → {asset_id: glb_path} via the local launcher (batch)."""
        if not self.launcher.is_file():
            raise FileNotFoundError(f"TRELLIS launcher not found: {self.launcher}")
        if decimation is None:
            decimation = max(10_000, round(1_000_000 * (1.0 - min(max(simplify, 0.0), 1.0))))
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        refs = Path(tempfile.mkdtemp(prefix=".trellis-", dir=out))
        generated = refs / "generated"
        home = Path(os.environ.get("ROOMCANVAS_HOME") or PACKAGE_ROOT.parents[2])
        weights = home / "backends" / "weights"
        model_identity = {name: {"config": cache.file_hash(weights / name / "pipeline.json"),
                                 "resolved": str((weights / name / "ckpts").resolve())}
                          for name in ("trellis2", "trellis2-local", "trellis2_4b_local")}
        results = {aid: "" for aid in items}
        keys = {}
        try:
            for aid, img in items.items():
                dst = refs / f"{aid}.png"
                if isinstance(img, (str, os.PathLike)):
                    shutil.copy(img, dst)
                else:  # PIL
                    img.convert("RGB").save(dst)
            for aid in items:
                keys[aid] = cache.fingerprint({
                    "version": 1, "image": cache.file_hash(refs / f"{aid}.png"),
                    "seed": seed, "decimation": decimation, "texture_size": texture_size,
                    "pipeline_type": pipeline_type, "model": model_identity,
                    "launcher": cache.file_hash(self.launcher),
                    "inference": cache.file_hash(DEFAULT_LAUNCHER),
                    "model_revision": os.environ.get("LITEREALITY_TRELLIS_REVISION", "default"),
                })
                target = out / f"{aid}.glb"
                if skip_existing and cache.matches(target, keys[aid]):
                    results[aid] = str(target)
                    (refs / f"{aid}.png").unlink()
                else:
                    cache.invalidate(target)
            pending = [aid for aid in items if not results[aid]]
            if not pending:
                self.last_report = {"rc": 0, "n": len(items), "reused": len(items)}
                return results
            cmd = [
                self.python,
                str(self.launcher),
                "-i",
                str(refs),
                "-o",
                str(generated),
                "--seed",
                str(seed),
                "--decimation",
                str(decimation),
                "--texture-size",
                str(texture_size),
                "--parallel",
                str(self.parallel),
            ]
            if pipeline_type:
                cmd += ["--pipeline-type", pipeline_type]
            if skip_existing:
                cmd.append("--skip-existing")
            print(f"  [trellis-local] {len(items)} asset(s) via {self.launcher.name}", flush=True)
            t0 = time.time()
            rc = subprocess.run(cmd).returncode
            for aid in pending:
                made = generated / f"{aid}.glb"
                receipt = cache.read_json(cache.receipt_path(made))
                certified = isinstance(receipt, dict) and receipt.get("output") == cache.file_hash(made)
                if made.is_file() and made.stat().st_size and (rc == 0 or certified):
                    target = out / made.name
                    made.replace(target)
                    cache.record(target, keys[aid])
                    results[aid] = str(target)
            self.last_report = {"rc": rc, "seconds": round(time.time() - t0, 1), "n": len(items),
                                "failed": [aid for aid, result in results.items() if not result]}
        finally:
            shutil.rmtree(refs, ignore_errors=True)
        return results
