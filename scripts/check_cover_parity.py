#!/usr/bin/env python3
"""Compare the lightweight scorer with pristine NBV-Gym's attribute renderer.

Run on a CUDA host with gsplat 1.5.3; no training or Nerfstudio installation.
Use --synthetic, or --input with canonical Gaussian and camera NPZ arrays.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
from functools import partial
import io
import json
from pathlib import Path
import time
from types import ModuleType

import numpy as np
import torch

import cover_core as core


def load_reference_renderer():
    path = core.VENDOR_DIR / "more_rendering.py"
    source = ast.parse(path.read_text(), filename=str(path))
    nodes = []
    for node in source.body:
        if isinstance(node, ast.Import):
            nodes.append(node)
        elif isinstance(node, ast.ImportFrom):
            if not (node.module or "").startswith(("nerfstudio", "nbv_gym")):
                nodes.append(node)
        elif isinstance(node, ast.FunctionDef) and node.name == "rasterization_with_view_attributes":
            nodes.append(node)
    module = ModuleType("viewforge_cover_reference_renderer")
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), module.__dict__)
    return module.rasterization_with_view_attributes


def look_at(eye, target=(0.0, 0.0, 0.0)) -> np.ndarray:
    eye = np.asarray(eye, dtype=np.float64)
    forward = np.asarray(target, dtype=np.float64) - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    down = np.cross(forward, right)
    rotation = np.stack((right, down, forward))
    viewmat = np.eye(4, dtype=np.float32)
    viewmat[:3, :3] = rotation
    viewmat[:3, 3] = -rotation @ eye
    return viewmat


def synthetic_inputs(device: str):
    means = np.asarray([
        [-0.35, -0.20, -0.12], [0.00, 0.00, -0.18], [0.00, 0.00, 0.18],
        [0.30, 0.20, 0.04], [-0.15, 0.28, 0.15], [0.25, -0.30, -0.08],
        [0.05, 0.15, -0.25], [0.05, 0.15, 0.25], [-0.28, 0.04, 0.08],
        [0.38, -0.05, 0.15], [-0.10, -0.30, 0.18], [0.18, 0.02, -0.05],
    ], dtype=np.float32)
    # Small projected footprints straddle the upstream 3-pixel observed cutoff.
    sizes = np.asarray([0.005, 0.06, 0.10, 0.012, 0.026, 0.040,
                        0.07, 0.09, 0.025, 0.018, 0.06, 0.08], dtype=np.float32)
    scales = sizes[:, None] * np.asarray([[1.0, 0.7, 1.3]], dtype=np.float32)
    quats = np.tile(np.asarray([[1., 0., 0., 0.]], dtype=np.float32), (len(means), 1))
    opacities = np.asarray([0.9, 0.8, 0.9, 0.3, 0.15, 0.65,
                            0.88, 0.95, 0.04, 0.5, 0.25, 0.75], dtype=np.float32)
    gs = {key: torch.as_tensor(value, device=device) for key, value in
          dict(means=means, quats=quats, scales=scales, opacities=opacities).items()}
    K = np.asarray([[160., 0., 64.], [0., 160., 64.], [0., 0., 1.]], dtype=np.float32)
    def cam(name, eye, target=(0., 0., 0.)):
        return {"id": name, "viewmat": look_at(eye, target), "K": K,
                "width": 128, "height": 128}
    observed = [cam("observed-front", (0., 0., -3.)),
                cam("observed-near-front", (0.45, 0.2, -3.))]
    candidates = [cam("front", (0., 0., -3.)), cam("side", (3., 0., 0.)),
                  cam("back", (0., 0., 3.)), cam("diagonal", (2., 0.6, -2.)),
                  cam("empty", (0., 0., -3.), (0., 0., -6.))]
    return gs, observed, candidates


def load_inputs(path: Path, device: str):
    with np.load(path, allow_pickle=False) as data:
        gs = {name: torch.as_tensor(data[name], dtype=torch.float32, device=device)
              for name in ("means", "quats", "scales", "opacities")}
        def cameras(prefix):
            matrices = data[f"{prefix}_viewmats"]
            n = len(matrices)
            ids = data[f"{prefix}_ids"] if f"{prefix}_ids" in data else [f"{prefix}-{i}" for i in range(n)]
            return [{"id": str(ids[i]), "viewmat": matrices[i],
                     "K": data[f"{prefix}_Ks"][i], "width": int(data[f"{prefix}_widths"][i]),
                     "height": int(data[f"{prefix}_heights"][i])} for i in range(n)]
        return gs, cameras("observed"), cameras("candidate")


@torch.no_grad()
def check_parity(gaussians, observed, candidates, atol=1e-5, rtol=1e-4):
    if len(gaussians["means"]) < 2:
        raise ValueError("Original reference wrapper requires at least two Gaussians because of its squeeze()")
    gs = core.normalize_gaussians(gaussians)
    device = gs["means"].device
    observed = [core.normalize_camera(c, device, i) for i, c in enumerate(observed)]
    candidates = [core.normalize_camera(c, device, i) for i, c in enumerate(candidates)]
    adapter = core.score_cameras(gs, observed, candidates, return_maps=True)
    reference = core._load_upstream_coverage()
    renderer = load_reference_renderer()
    bins = reference.fibonacci_sphere(128, device=device, dtype=torch.float32)
    counts = torch.zeros((len(gs["means"]), 128), device=device, dtype=torch.float32)
    for camera in observed:
        reference.update_view_coverage_for_frustum(
            means=gs["means"], quats=gs["quats"], scales=gs["scales"],
            viewmats=camera["viewmat"], Ks=camera["K"], width=camera["width"], height=camera["height"],
            coverage_counts=counts, bin_dirs=bins, camera_model="pinhole",
            near_plane=0.01, far_plane=1e10, radius_clip=3.0,
        )
    torch.testing.assert_close(counts, adapter["coverage_counts"], atol=0, rtol=0)
    callback = partial(reference.compute_coverage_metric, view_attributes=counts, bin_dirs=bins)
    dummy_sh = torch.zeros((len(gs["means"]), 1, 3), device=device)
    rows = []
    raw_reference = []
    for i, camera in enumerate(candidates):
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            rendered, alpha, _ = renderer(
                **gs, colors=dummy_sh, render_view_attributes_fn=callback,
                viewmats=camera["viewmat"], Ks=camera["K"],
                width=camera["width"], height=camera["height"],
                packed=False, near_plane=0.01, far_plane=1e10,
                render_mode="RGB+ED", sh_degree=0, sparse_grad=False,
                absgrad=False, rasterize_mode="classic", camera_model="pinhole",
            )
        if "Error computing view attributes" in capture.getvalue():
            raise RuntimeError("Upstream silently replaced coverage with zeros: " + capture.getvalue())
        ref_map, ref_alpha = rendered[0, ..., 3], alpha[0, ..., 0]
        new_map, new_alpha = adapter["maps"][i]["coverage"], adapter["maps"][i]["alpha"]
        torch.testing.assert_close(new_map, ref_map, atol=atol, rtol=rtol)
        torch.testing.assert_close(new_alpha, ref_alpha, atol=atol, rtol=rtol)
        if not torch.equal(new_alpha > 0, ref_alpha > 0):
            raise AssertionError(f"Valid pixel masks differ for {camera['id']}")
        # Independent reduction from model.py, rather than the adapter helper.
        valid = ref_alpha > 0
        count = int(valid.sum().item())
        ref_score = float(((ref_map * valid).sum() / valid.sum()).item()) if count else None
        new_score = adapter["scores"][i]["raw_score"]
        if ref_score is None:
            if new_score is not None:
                raise AssertionError("Empty reference candidate was ranked as valid")
        elif new_score is None or abs(ref_score - new_score) > atol + rtol * abs(ref_score):
            raise AssertionError(f"Scalar scores differ for {camera['id']}: {ref_score} vs {new_score}")
        raw_reference.append((i, ref_score))
        rows.append({"id": camera["id"], "reference_score": ref_score, "adapter_score": new_score,
                     "valid_pixels": count, "max_coverage_abs_error": float((new_map - ref_map).abs().max().item()),
                     "max_alpha_abs_error": float((new_alpha - ref_alpha).abs().max().item()),
                     "valid_mask_equal": True})
    reference_order = [i for i, s in sorted(((i, s) for i, s in raw_reference if s is not None), key=lambda row: row[1])]
    adapter_order = [row["candidate_index"] for row in sorted((row for row in adapter["scores"] if row["valid"]), key=lambda row: row["rank"])]
    if reference_order != adapter_order:
        raise AssertionError(f"Candidate ranking differs: {reference_order} vs {adapter_order}")
    return {"passed": True, "scope": "COVER formula and renderer parity; not reconstruction benefit",
            "upstream_commit": core.UPSTREAM_COMMIT, "gsplat_version": core.GSPLAT_VERSION,
            "gaussian_count": len(gs["means"]), "observed_camera_count": len(observed),
            "count_tensors_equal": True, "covered_gaussians": int((counts.sum(-1) > 0).sum().item()),
            "uncovered_gaussians": int((counts.sum(-1) == 0).sum().item()),
            "candidate_order": [candidates[i]["id"] for i in reference_order],
            "atol": atol, "rtol": rtol, "candidates": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--synthetic", action="store_true")
    source.add_argument("--input", type=Path, help="Canonical activated Gaussian/camera NPZ")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--candidate-indices", type=int, nargs="+")
    args = parser.parse_args()
    started = time.monotonic()
    try:
        gs, observed, candidates = synthetic_inputs(args.device) if args.synthetic else load_inputs(args.input, args.device)
        if args.candidate_indices is not None:
            candidates = [candidates[i] for i in args.candidate_indices]
        report = check_parity(gs, observed, candidates)
        if args.synthetic:
            scores = [row["adapter_score"] for row in report["candidates"] if row["adapter_score"] is not None]
            if not scores or max(scores) - min(scores) <= 0.01:
                raise AssertionError("Synthetic scene did not exercise nontrivial directional coverage")
            if not (report["covered_gaussians"] and report["uncovered_gaussians"]):
                raise AssertionError("Synthetic scene did not straddle the observed radius cutoff")
        report["input"] = "synthetic" if args.synthetic else str(args.input)
    except Exception as error:
        report = {"passed": False, "error": f"{type(error).__name__}: {error}",
                  "upstream_commit": core.UPSTREAM_COMMIT}
    report["elapsed_seconds"] = time.monotonic() - started
    payload = json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload)
    print(payload, end="")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
