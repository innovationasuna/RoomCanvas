"""TRELLIS hosted on Modal, using the canonical image-to-3D request contract."""

from __future__ import annotations

import base64
import io
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from litereality_agent import artifact_cache as cache
from litereality_agent.runtimes.modal import ModalClient


@dataclass(slots=True)
class AssetReport:
    asset_id: str
    ok: bool
    wall_s: float
    glb_path: str = ""
    error: str = ""


@dataclass(slots=True)
class BatchReport:
    assets: list[AssetReport] = field(default_factory=list)
    wall_s: float = 0.0

    @property
    def ok_count(self) -> int:
        return sum(asset.ok for asset in self.assets)

    def render(self) -> str:
        lines = [
            f"  TRELLIS/Modal batch: {self.ok_count}/{len(self.assets)} ok  wall={self.wall_s:.1f}s"
        ]
        for asset in self.assets:
            status = "ok " if asset.ok else "ERR"
            suffix = "" if asset.ok else f"  {asset.error}"
            lines.append(f"    [{status}] {asset.asset_id:16s} wall={asset.wall_s:5.1f}s{suffix}")
        return "\n".join(lines)


class ModalTrellisService:
    """Generation3DService adapter for a deployed Modal TRELLIS function."""

    name = "trellis-modal"

    def __init__(
        self,
        *,
        app_name: str,
        function_name: str = "trellis",
        environment_name: str = "main",
        profile: str | None = None,
        credentials: tuple[str, str] | None = None,
        client: Any = None,
    ) -> None:
        self.identity = {"app": app_name, "function": function_name, "environment": environment_name}
        self.client = client or ModalClient(
            app_name,
            function_name,
            environment_name=environment_name,
            profile=profile,
            credentials=credentials,
        )
        self.last_report: BatchReport | None = None

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
        simplify: float = 0.95,
        texture_size: int = 1024,
        pipeline_type: str | None = None,
        decimation: int | None = None,
        skip_existing: bool = True,
    ) -> dict[str, str]:
        out = Path(out_dir)
        out.mkdir(parents=True, exist_ok=True)
        asset_ids = list(items)
        payloads = [
            {
                "image_b64": _image_b64(items[asset_id]),
                "seed": seed,
                "simplify": simplify,
                "texture_size": texture_size,
                "pipeline_type": pipeline_type,
            }
            for asset_id in asset_ids
        ]

        if decimation is not None:
            for payload in payloads:
                payload["decimation"] = decimation
        keys = {aid: cache.fingerprint({"version": 1, "request": payload,
                    "service": self.identity, "code": cache.file_hash(Path(__file__)),
                    "model_revision": os.environ.get("LITEREALITY_TRELLIS_REVISION", "default")})
                for aid, payload in zip(asset_ids, payloads, strict=True)}
        results = {}
        pending_ids, pending_payloads = [], []
        for aid, payload in zip(asset_ids, payloads, strict=True):
            path = out / f"{aid}.glb"
            if skip_existing and cache.matches(path, keys[aid]):
                results[aid] = str(path)
            else:
                cache.invalidate(path)
                pending_ids.append(aid)
                pending_payloads.append(payload)
        reused = [AssetReport(aid, True, 0, glb_path=path) for aid, path in results.items()]
        asset_ids, payloads = pending_ids, pending_payloads
        if not asset_ids:
            self.last_report = BatchReport(assets=reused)
            return results
        started = time.monotonic()
        outputs = self.client.map(payloads)
        elapsed = time.monotonic() - started
        if len(outputs) != len(asset_ids):
            raise RuntimeError(
                f"Modal TRELLIS returned {len(outputs)} results for {len(asset_ids)} inputs"
            )

        report = BatchReport(assets=reused, wall_s=elapsed)
        for asset_id, output in zip(asset_ids, outputs, strict=True):
            path = out / f"{asset_id}.glb"
            if isinstance(output, BaseException):
                results[asset_id] = ""
                report.assets.append(
                    AssetReport(
                        asset_id,
                        False,
                        elapsed,
                        error=f"{type(output).__name__}: {output}",
                    )
                )
                continue
            error = output.get("error")
            if error:
                results[asset_id] = ""
                report.assets.append(AssetReport(asset_id, False, elapsed, error=str(error)))
                continue
            try:
                data = base64.b64decode(output["glb_b64"], validate=True)
                if not data:
                    raise ValueError("empty GLB")
                temporary = path.with_suffix(".glb.partial")
                try:
                    temporary.write_bytes(data)
                    temporary.replace(path)
                    cache.record(path, keys[asset_id])
                finally:
                    temporary.unlink(missing_ok=True)
            except (KeyError, ValueError) as exc:
                results[asset_id] = ""
                report.assets.append(
                    AssetReport(asset_id, False, elapsed, error=f"invalid response: {exc}")
                )
                continue
            results[asset_id] = str(path)
            report.assets.append(AssetReport(asset_id, True, elapsed, glb_path=str(path)))

        self.last_report = report
        print(report.render(), flush=True)
        return results


def _image_b64(image: Any) -> str:
    if isinstance(image, (bytes, bytearray)):
        data = bytes(image)
    elif isinstance(image, (str, os.PathLike)):
        data = Path(image).read_bytes()
    else:
        buffer = io.BytesIO()
        image.convert("RGBA").save(buffer, format="PNG")
        data = buffer.getvalue()
    return base64.b64encode(data).decode("ascii")
