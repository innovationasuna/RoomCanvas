"""Where a rebuilt mesh goes: the old model's footprint, height and facing. numpy only.

Also imported by `blender_ops.py` inside Blender, so it must not import this package.

The footprint is the minimum-area rectangle around the old model's vertices seen from above,
so a slipper turned 30 degrees on the floor keeps its long narrow shape instead of the square
its axis-aligned box would give. The new mesh's long side goes along the rectangle's long side;
of the two (or four, for a square) ways that fit, the one whose front (TRELLIS meshes face -Y,
the reference image's viewing side) turns toward the camera that saw the object best wins. The
new mesh keeps most of its own proportions: the old model was a rough primitive.
"""

from __future__ import annotations

import math

import numpy as np

MAX_STRETCH = 1.15  # per-axis scale stays within this factor of the overall scale


def keeps_shape(world, tolerance: float = 1e-5) -> bool:
    """Whether a turned object can hang under one with this world matrix and stay as it is: the
    three axes are at right angles and equally long. Under a part stretched unevenly a turned child
    is sheared, which neither Blender's location/rotation/scale nor the exported GLB's can hold."""
    axes = np.asarray(world, float)[:3, :3]
    gram = axes.T @ axes
    size = gram.trace() / 3
    return bool(size > 0 and np.abs(gram - size * np.eye(3)).max() <= tolerance * size)


def stretch(world, tolerance: float = 1e-5):
    """The lengths of a world matrix's three axes when they are at right angles (a part stretched
    along its own axes, as a tabletop is): an empty under it scaled by their inverse stands level
    again, so a turned child under that empty is not sheared. None when the axes are skewed."""
    axes = np.asarray(world, float)[:3, :3]
    gram = axes.T @ axes
    lengths = np.sqrt(np.clip(np.diag(gram), 0, None))
    if lengths.min() <= 0:
        return None
    off = gram - np.diag(np.diag(gram))
    return [float(v) for v in lengths] if np.abs(off).max() <= tolerance * gram.trace() / 3 else None


def hull(points: np.ndarray) -> np.ndarray:
    """Convex hull of 2D points, counter-clockwise (monotone chain)."""
    pts = np.unique(np.round(points, 6), axis=0)
    if len(pts) < 3:
        return pts

    def turn(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    def half(seq):
        out = []
        for p in seq:
            while len(out) >= 2 and turn(out[-2], out[-1], p) <= 0:
                out.pop()
            out.append(p)
        return out

    lower, upper = half(pts), half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def footprint(points: np.ndarray) -> dict:
    """Minimum-area rectangle around world vertices (N x 3): centre, angle of the long side,
    long and short lengths, and the z range."""
    ring = hull(points[:, :2])
    best = None
    edges = np.roll(ring, -1, axis=0) - ring if len(ring) >= 3 else [np.array([1.0, 0.0])]
    for edge in edges:
        if np.linalg.norm(edge) < 1e-9:
            continue
        u = edge / np.linalg.norm(edge)
        v = np.array([-u[1], u[0]])
        a, b = ring @ u, ring @ v
        size = (a.max() - a.min()) * (b.max() - b.min())
        if best is None or size < best[0]:
            centre = u * (a.max() + a.min()) / 2 + v * (b.max() + b.min()) / 2
            best = (size, u, a.max() - a.min(), b.max() - b.min(), centre)
    _, u, du, dv, centre = best
    if dv > du:  # report the long side first
        u, du, dv = np.array([-u[1], u[0]]), dv, du
    return {"centre": [float(centre[0]), float(centre[1])],
            "angle": math.atan2(u[1], u[0]), "long": float(du), "short": float(dv),
            "z": [float(points[:, 2].min()), float(points[:, 2].max())]}


def placement(target: dict, asset_size, camera_xy=None) -> dict:
    """Yaw and per-axis scale that put an asset of `asset_size` (x, y, z) into `target`."""
    ax, ay, az = (max(float(v), 1e-6) for v in asset_size)
    if "yaw_deg" in target:
        return {"yaw": math.radians(target["yaw_deg"]),
                "scale": [v / axis for v, axis in zip(target["size"], (ax, ay, az))]}
    long, short = max(target["long"], 1e-4), max(target["short"], 1e-4)
    height = max(target["z"][1] - target["z"][0], 1e-4)
    toward = None
    if camera_xy is not None:
        d = np.array(camera_xy, float) - np.array(target["centre"])
        toward = d / (np.linalg.norm(d) or 1.0)
    options = []
    for k in range(4):
        yaw = target["angle"] + k * math.pi / 2
        along_long, along_short = (ax, ay) if k % 2 == 0 else (ay, ax)
        mismatch = abs(math.log((along_long / along_short) / (long / short)))
        front = np.array([math.sin(yaw), -math.cos(yaw)])  # asset -Y after turning by yaw
        facing = float(front @ toward) if toward is not None else 0.0
        options.append((mismatch, facing, k, yaw))
    best_fit = min(option[0] for option in options)
    mismatch, facing, k, yaw = max((o for o in options if o[0] <= best_fit + 0.2),
                                   key=lambda o: o[1])
    sx, sy = (long / ax, short / ay) if k % 2 == 0 else (short / ax, long / ay)
    scale = np.array([sx, sy, height / az])
    # The overall size comes from the old model's long side and height; its short side is the
    # least trustworthy number (a bag modelled as a slab), so it only nudges within the stretch.
    along_long = 0 if k % 2 == 0 else 1
    overall = math.sqrt(scale[along_long] * scale[2])
    scale = np.clip(scale, overall / MAX_STRETCH, overall * MAX_STRETCH)
    return {"yaw": yaw % (2 * math.pi), "scale": [float(v) for v in scale],
            "mismatch": round(mismatch, 3), "facing": round(facing, 3)}
