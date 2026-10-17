"""Frozen-model COVER scoring, preserving NBV-Gym 6e5e5ef's formula.

Gaussian inputs are float32 torch tensors on one CUDA device. Cameras may use
NumPy or torch arrays. No color, training images, optimizer, or Nerfstudio is
needed. The pristine upstream files and license live in vendor/cover.
"""
from __future__ import annotations

import ast
import importlib.metadata
import math
from pathlib import Path
from types import ModuleType
from typing import Any

import torch

UPSTREAM_COMMIT = "6e5e5ef48a59f369a821802842504668eac23325"
GSPLAT_VERSION = "1.5.3"
N_BINS = 128
VENDOR_DIR = Path(__file__).resolve().parent / "vendor" / "cover"


def _projection(*args: Any, **kwargs: Any):
    from gsplat.cuda._wrapper import fully_fused_projection
    return fully_fused_projection(*args, **kwargs)


def _load_upstream_coverage() -> ModuleType:
    """Execute the original function ASTs without unrelated package imports."""
    source_path = VENDOR_DIR / "coverage.py"
    wanted = {
        "fibonacci_sphere", "dir_to_bin", "compute_coverage_metric",
        "update_view_coverage_for_frustum", "compute_coverage_per_gaussian",
    }
    source = ast.parse(source_path.read_text(), filename=str(source_path))
    functions = [node for node in source.body
                 if isinstance(node, ast.FunctionDef) and node.name in wanted]
    if {node.name for node in functions} != wanted:
        raise RuntimeError("Pinned COVER source is missing required functions")
    module = ModuleType("viewforge_pinned_cover")
    module.__dict__.update(torch=torch, Tensor=torch.Tensor, math=math,
                           fully_fused_projection=_projection)
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(source_path), "exec"),
         module.__dict__)
    return module


_UPSTREAM = _load_upstream_coverage()
fibonacci_sphere = _UPSTREAM.fibonacci_sphere
dir_to_bin = _UPSTREAM.dir_to_bin
compute_coverage_per_gaussian = _UPSTREAM.compute_coverage_per_gaussian


def normalize_gaussians(gaussians: dict[str, torch.Tensor]) -> dict[str, torch.Tensor]:
    """Check activated parameters and normalize wxyz rotations exactly once."""
    names = ("means", "quats", "scales", "opacities")
    values = {name: gaussians[name] for name in names}
    if any(not isinstance(value, torch.Tensor) for value in values.values()):
        raise TypeError("Gaussian arrays must be torch.Tensor instances")
    means = values["means"]
    if means.ndim != 2 or means.shape[1] != 3 or means.shape[0] == 0:
        raise ValueError("means must have nonempty shape [N,3]")
    n = means.shape[0]
    shapes = {"means": (n, 3), "quats": (n, 4), "scales": (n, 3), "opacities": (n,)}
    for name, value in values.items():
        if tuple(value.shape) != shapes[name]:
            raise ValueError(f"{name} must have shape {shapes[name]}, got {tuple(value.shape)}")
        if value.device != means.device or value.dtype != torch.float32:
            raise ValueError("All Gaussian tensors must use one device and float32")
        if not bool(torch.isfinite(value).all()):
            raise ValueError(f"{name} contains non-finite values")
    if not bool((values["scales"] > 0).all()):
        raise ValueError("scales must be positive activated scales, not logarithms")
    opacity = values["opacities"]
    if not bool(((opacity >= 0) & (opacity <= 1)).all()):
        raise ValueError("opacities must be activated values in [0,1]")
    norms = torch.linalg.vector_norm(values["quats"], dim=-1, keepdim=True)
    if not bool((norms > 0).all()):
        raise ValueError("Quaternion norm must be nonzero")
    values["quats"] = values["quats"] / norms
    return {name: value.detach().contiguous() for name, value in values.items()}


def normalize_camera(camera: dict[str, Any], device: torch.device, index: int = 0) -> dict[str, Any]:
    result: dict[str, Any] = {"id": str(camera.get("id", index))}
    for key, shape in (("viewmat", (4, 4)), ("K", (3, 3))):
        value = torch.as_tensor(camera[key], dtype=torch.float32, device=device)
        if tuple(value.shape) == shape:
            value = value.unsqueeze(0)
        if tuple(value.shape) != (1,) + shape or not bool(torch.isfinite(value).all()):
            raise ValueError(f"Camera {result['id']}: {key} must be finite [1,{shape[0]},{shape[1]}]")
        result[key] = value.contiguous()
    for key in ("width", "height"):
        value = int(camera[key])
        if value <= 0 or value != camera[key]:
            raise ValueError(f"Camera {result['id']}: {key} must be a positive integer")
        result[key] = value
    if not bool((result["K"][0, (0, 1), (0, 1)] > 0).all()):
        raise ValueError(f"Camera {result['id']}: focal lengths must be positive")
    return result


@torch.no_grad()
def build_coverage_counts(gaussians: dict[str, torch.Tensor], observed_cameras: list[dict[str, Any]]):
    """Recompute all observed-direction counts on the current Gaussian model."""
    means = gaussians["means"]
    bins = fibonacci_sphere(N_BINS, device=means.device, dtype=means.dtype)
    counts = torch.zeros((len(means), N_BINS), dtype=means.dtype, device=means.device)
    for camera in observed_cameras:
        # Preserve model.py's asymmetric observed/candidate projection settings.
        _UPSTREAM.update_view_coverage_for_frustum(
            means=means, quats=gaussians["quats"], scales=gaussians["scales"],
            viewmats=camera["viewmat"], Ks=camera["K"],
            width=camera["width"], height=camera["height"],
            coverage_counts=counts, bin_dirs=bins, camera_model="pinhole",
            eps2d=0.3, near_plane=0.01, far_plane=1e10, radius_clip=3.0,
        )
    return counts, bins


@torch.no_grad()
def coverage_for_camera(means: torch.Tensor, counts: torch.Tensor, bins: torch.Tensor,
                        camera: dict[str, Any]) -> torch.Tensor:
    center = torch.linalg.inv(camera["viewmat"])[0, :3, 3]
    directions = means - center
    # Upstream accepts masks but does not use them in the coverage formula.
    masks = torch.ones(len(means), dtype=torch.bool, device=means.device)
    return compute_coverage_per_gaussian(counts, bins, masks, directions)


@torch.no_grad()
def render_coverage(gaussians: dict[str, torch.Tensor], values: torch.Tensor,
                    camera: dict[str, Any]):
    from gsplat.rendering import rasterization
    rendered, alpha, _ = rasterization(
        **gaussians, colors=values[:, None], viewmats=camera["viewmat"], Ks=camera["K"],
        width=camera["width"], height=camera["height"],
        packed=False, near_plane=0.01, far_plane=1e10, radius_clip=0.0,
        eps2d=0.3, sh_degree=None, render_mode="RGB", backgrounds=None,
        sparse_grad=False, absgrad=False, rasterize_mode="classic", tile_size=16,
        camera_model="pinhole",
    )
    return rendered[0, ..., 0], alpha[0, ..., 0]


def summarize_map(coverage: torch.Tensor, alpha: torch.Tensor) -> tuple[float | None, int]:
    if not bool(torch.isfinite(coverage).all() & torch.isfinite(alpha).all()):
        raise RuntimeError("COVER renderer produced non-finite coverage or alpha")
    valid = alpha > 0
    pixels = int(valid.sum().item())
    if pixels == 0:
        return None, 0
    # Match upstream sum(mask * coverage)/sum(mask), without alpha division.
    score = float(((coverage * valid).sum() / valid.sum()).item())
    return score, pixels


@torch.no_grad()
def score_cameras(gaussians: dict[str, torch.Tensor], observed_cameras: list[dict[str, Any]],
                  candidate_cameras: list[dict[str, Any]], return_maps: bool = False) -> dict[str, Any]:
    """Rank candidate cameras by ascending original COVER score.

    Empty views have raw_score=None, valid=False, rank=None. Inference-only
    tensors remain on the caller's CUDA device; score records are JSON friendly.
    """
    gs = normalize_gaussians(gaussians)
    if gs["means"].device.type != "cuda":
        raise ValueError("Full COVER scoring requires CUDA gsplat; pure coverage functions support CPU")
    version = importlib.metadata.version("gsplat")
    if version != GSPLAT_VERSION:
        raise RuntimeError(f"Pinned COVER requires gsplat=={GSPLAT_VERSION}; found {version}")
    if not observed_cameras:
        raise ValueError("At least one observed camera is required")
    device = gs["means"].device
    observed = [normalize_camera(cam, device, i) for i, cam in enumerate(observed_cameras)]
    candidates = [normalize_camera(cam, device, i) for i, cam in enumerate(candidate_cameras)]
    counts, bins = build_coverage_counts(gs, observed)
    scores = []
    maps = []
    for index, camera in enumerate(candidates):
        values = coverage_for_camera(gs["means"], counts, bins, camera)
        coverage, alpha = render_coverage(gs, values, camera)
        score, pixels = summarize_map(coverage, alpha)
        scores.append({"id": camera["id"], "candidate_index": index, "raw_score": score,
                       "valid": pixels > 0, "valid_pixels": pixels, "rank": None})
        if return_maps:
            maps.append({"id": camera["id"], "coverage": coverage, "alpha": alpha})
    valid_scores = sorted((row for row in scores if row["valid"]), key=lambda row: row["raw_score"])
    for rank, row in enumerate(valid_scores, 1):
        row["rank"] = rank
    result = {
        "metadata": {"upstream_commit": UPSTREAM_COMMIT, "gsplat_version": version,
                     "n_bins": N_BINS, "lower_is_better": True,
                     "observed_radius_clip": 3.0, "candidate_radius_clip": 0.0,
                     "rasterize_mode": "classic", "score_reduction": "mean_coverage_where_alpha_gt_zero"},
        "scores": scores, "coverage_counts": counts,
        "best_id": valid_scores[0]["id"] if valid_scores else None,
    }
    if return_maps:
        result["maps"] = maps
    return result
