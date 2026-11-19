"""Models the operator hands the pipeline instead of having them generated.

``$LR_PROVIDED_MODELS`` names a directory prepared before the reconstruct stage (typically from an
earlier reconstruction of the same room):

    <dir>/<Name>.glb     a finished static model
    <dir>/<Name>/        a procedural object folder, as the procedural generator writes it
                         (one *.glb, object.py, object.md, previews/, maybe sim/)

``<Name>`` is an object, chair cluster or opening id of THIS scan. Routing sends such a name to
``provided`` without asking the classifier, and :func:`adopt` copies it into
``reconstructed_objs/`` at the start of the reconstruction phase, recording what came from where in
``reconstructed_objs/provided.json``. Every builder that could otherwise rebuild it (TRELLIS, the
procedural and openings passes, chair QC) reads that record and leaves the name alone.

``$LR_PROVIDED_TURN=Name=90,...`` turns a provided static GLB about the vertical axis on adoption,
for a model whose long side would otherwise land on the new box's short side.
"""

from __future__ import annotations

import json
import math
import os
import re
import shutil
import struct
from pathlib import Path

from litereality_agent import artifact_cache, telemetry
from litereality_agent.pipeline.scene_init import paths as config

RECORD = "provided.json"
# A model whose horizontal aspect is at least this far from square, mapped onto a box that is at
# least this far from square the other way round, is stretched past recognition by the placement.
_ASPECT = 1.3


def pairs(value: str | None, what: str) -> dict[str, str]:
    """``Name=value,Name=value`` -> {Name: value}; a malformed item is an error, not a no-op."""
    out: dict[str, str] = {}
    for item in (value or "").split(","):
        item = item.strip()
        if not item:
            continue
        name, sep, val = item.partition("=")
        if not sep or not name.strip() or not val.strip():
            raise ValueError(f"{what}: expected Name=value, got {item!r}")
        out[name.strip()] = val.strip()
    return out


def scan_names(scan: str) -> set[str]:
    """Every id a provided model may replace: objects, chair clusters and openings of `scan`."""
    names: set[str] = set()
    for root in (config.object_refs_root() / scan, config.opening_refs_root() / scan):
        if root.is_dir():
            names |= {p.name for p in root.iterdir() if p.is_dir()}
    chairs = config.chair_clusters_root() / scan
    data = artifact_cache.read_json(chairs / "chair_clusters.json")
    if isinstance(data, dict):
        names |= {c["cluster_id"] for c in data.get("clusters", []) if c.get("cluster_id")}
    for refs in ("references", "nano_banana_normalized_1024"):
        if (chairs / refs).is_dir():
            names |= {p.stem for p in (chairs / refs).glob("ChairCluster*.png")}
    return names


def find(scan: str) -> dict[str, Path]:
    """{Name: source} for ``$LR_PROVIDED_MODELS``; {} when it is unset.

    A name that is not an id of this scan is a mistyped id, and building the room without the model
    the operator meant to supply is worse than stopping, so it is an error.
    """
    value = os.environ.get("LR_PROVIDED_MODELS", "").strip()
    if not value:
        return {}
    root = Path(value).expanduser()
    if not root.is_absolute():  # the pipeline chdirs into its work tree; relative would move
        raise ValueError(f"LR_PROVIDED_MODELS must be an absolute path, got {value!r}")
    if not root.is_dir():
        raise ValueError(f"LR_PROVIDED_MODELS: {root} is not a directory")
    found: dict[str, Path] = {}
    for path in sorted(root.iterdir()):
        if path.name.startswith(".") or not (path.is_dir() or path.suffix == ".glb"):
            continue
        name = path.stem if path.is_file() else path.name
        if name in found:
            raise ValueError(f"LR_PROVIDED_MODELS: {name} is given both as {name}.glb and {name}/")
        found[name] = path
    valid = scan_names(scan)
    unknown = sorted(set(found) - valid)
    if unknown:
        raise ValueError(f"LR_PROVIDED_MODELS: {', '.join(unknown)} not in scan {scan}; "
                         f"valid names: {', '.join(sorted(valid)) or '(none)'}")
    return found


def adopted(recon: Path) -> set[str]:
    """Names adopted into `recon` by the current run, read from its record."""
    data = artifact_cache.read_json(Path(recon) / RECORD)
    return set(data.get("models", {})) if isinstance(data, dict) else set()


def _files(folder: Path) -> list[Path]:
    # The old object's sim/ is named after the old id; the physics compile writes a new one.
    return [p for p in sorted(folder.rglob("*")) if p.is_file()
            and not any(part.startswith(".") for part in p.relative_to(folder).parts)
            and p.relative_to(folder).parts[0] != "sim"]


def _source_digest(src: Path) -> str | None:
    if src.is_file():
        return artifact_cache.file_hash(src)
    return artifact_cache.fingerprint({str(p.relative_to(src)): artifact_cache.file_hash(p)
                                       for p in _files(src)})


def _split(data: bytes) -> tuple[dict, bytes, int]:
    """(JSON chunk, the bytes after it, version) of a binary glTF."""
    magic, version, _ = struct.unpack_from("<III", data, 0)
    length, kind = struct.unpack_from("<II", data, 12)
    if magic != 0x46546C67 or kind != 0x4E4F534A:
        raise ValueError("not a binary glTF")
    return json.loads(data[20:20 + length]), data[20 + length:], version


def _turn_glb(src: Path, dst: Path, degrees: float) -> None:
    """Write `src` turned `degrees` about the vertical axis (glTF +Y) to `dst`.

    Parents the scene's roots under one rotated node, so only the JSON chunk changes: meshes,
    materials and animations keep their indices.
    """
    gltf, rest, version = _split(src.read_bytes())
    if len(gltf.get("scenes", [])) != 1:
        raise ValueError(f"{src}: can only turn a GLB with exactly one scene")
    half = math.radians(degrees) / 2.0
    nodes = gltf.setdefault("nodes", [])
    for node in nodes:
        # trimesh (which exports TRELLIS models and loads them for the physics compile) takes a
        # node named "world" as its base frame and drops everything above it — the turn included.
        if node.get("name") == "world":
            node["name"] = "model"
    scene = gltf["scenes"][0]
    nodes.append({"name": "provided_turn", "rotation": [0.0, math.sin(half), 0.0, math.cos(half)],
                  "children": scene.get("nodes", [])})
    scene["nodes"] = [len(nodes) - 1]
    body = json.dumps(gltf, separators=(",", ":")).encode()
    body += b" " * (-len(body) % 4)
    dst.write_bytes(struct.pack("<III", 0x46546C67, version, 20 + len(body) + len(rest))
                    + struct.pack("<II", len(body), 0x4E4F534A) + body + rest)


def _local(node: dict):
    import numpy as np

    if "matrix" in node:
        return np.array(node["matrix"], dtype=float).reshape(4, 4).T  # glTF is column-major
    x, y, z, w = node.get("rotation", (0.0, 0.0, 0.0, 1.0))
    m = np.eye(4)
    m[:3, :3] = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                          [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                          [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    m[:3, :3] *= np.asarray(node.get("scale", (1.0, 1.0, 1.0)), dtype=float)
    m[:3, 3] = node.get("translation", (0.0, 0.0, 0.0))
    return m


def extents(glb: Path) -> tuple[float, float, float]:
    """(x, y, z) size of a GLB's meshes in its own frame, from the position bounds glTF requires
    of every mesh, so no geometry is loaded. Node transforms count, a turn included."""
    import itertools

    import numpy as np

    gltf = _split(Path(glb).read_bytes())[0]
    nodes, points = gltf.get("nodes", []), []

    def visit(index: int, parent) -> None:
        node = nodes[index]
        world = parent @ _local(node)
        if "mesh" in node:
            for prim in gltf["meshes"][node["mesh"]]["primitives"]:
                acc = gltf["accessors"][prim["attributes"]["POSITION"]]
                corners = np.array(list(itertools.product(*zip(acc["min"], acc["max"]))), dtype=float)
                points.append(corners @ world[:3, :3].T + world[:3, 3])
        for child in node.get("children", []):
            visit(child, world)

    for root in gltf["scenes"][gltf.get("scene", 0)].get("nodes", []):
        visit(root, np.eye(4))
    every = np.concatenate(points)
    x, y, z = every.max(axis=0) - every.min(axis=0)
    return float(x), float(y), float(z)


def _copy_folder(src: Path, dst: Path, name: str) -> None:
    """Copy a procedural object folder under its new id.

    Only what has to match the id changes: the GLB is renamed (pack and export look for
    ``<Name>/<Name>.glb``), ``object.py``'s default output name follows it, and ``object.md`` names
    the new object. Textures keep their names because ``object.py`` loads them by those names.
    """
    glbs = list(src.glob("*.glb"))
    missing = [f for f in ("object.py", "object.md") if not (src / f).is_file()]
    if len(glbs) != 1 or missing:
        raise ValueError(f"LR_PROVIDED_MODELS: {src} is not a procedural object folder "
                         f"(needs one *.glb, object.py and object.md)")
    old = glbs[0].stem
    token = re.compile(rf"(?<![A-Za-z0-9]){re.escape(old)}(?![0-9])")
    for path in _files(src):
        rel = path.relative_to(src)
        out = dst / (f"{name}.glb" if path == glbs[0] else rel)
        out.parent.mkdir(parents=True, exist_ok=True)
        if rel == Path("object.py") and old != name:
            out.write_text(path.read_text(encoding="utf-8").replace(f"{old}.glb", f"{name}.glb"),
                           encoding="utf-8")
        elif rel == Path("object.md") and old != name:
            out.write_text(token.sub(name, path.read_text(encoding="utf-8")), encoding="utf-8")
        else:
            shutil.copy(path, out)  # not copy2: the replay times objects by file mtime


def _box(scan: str, name: str) -> list[float] | None:
    """[width, height, depth] of the scan's box for `name` (a chair cluster uses its
    representative's); None for openings and anything without one."""
    from litereality_agent.pipeline.scene_init.reconstruct.classify import classify_complexity

    objects = classify_complexity.load_scene_objects(scan)
    if name.startswith("ChairCluster"):
        data = artifact_cache.read_json(config.chair_clusters_root() / scan / "chair_clusters.json")
        reps = {c.get("cluster_id"): c.get("representative")
                for c in (data or {}).get("clusters", [])} if isinstance(data, dict) else {}
        name = reps.get(name) or ""
    bbox = (objects.get(name) or {}).get("bbox")
    try:
        return [float(v) for v in list(bbox)[:3]] if bbox is not None else None
    except (TypeError, ValueError):
        return None


def check_proportions(scan: str, name: str, glb: Path) -> str | None:
    """Warn when the model's horizontal proportions run against its new box's.

    The room build maps the model's own axes onto the box non-uniformly (X to width, Y to depth),
    so a model whose long side would land on the box's short side comes out squashed one way and
    stretched the other. Returns the warning (also printed), or None.
    """
    box = _box(scan, name)
    if not box:
        return None
    try:
        x, y, z = extents(glb)
    except Exception as exc:  # noqa: BLE001 — a check that cannot read the model only says so
        print(f"[provided] {name}: proportions not checked ({exc})", flush=True)
        return None
    # glTF is Y-up: the model's width is X, its depth Z, its height Y. The box is RoomPlan's w,h,d.
    model, (bw, bh, bd) = (x, z, y), box
    long_model, long_box = x >= z, bw >= bd
    if (long_model == long_box or max(x, z) < _ASPECT * min(x, z)
            or max(bw, bd) < _ASPECT * min(bw, bd)):
        return None
    warning = (f"{name}: provided model is {model[0]:.2f} wide x {model[1]:.2f} deep x "
               f"{model[2]:.2f} high, its new box {bw:.2f} wide x {bd:.2f} deep x {bh:.2f} high — "
               f"its long side would be fitted to the box's short side. If the model is turned, "
               f"set LR_PROVIDED_TURN={name}=90 to turn it 90° about the vertical axis.")
    print(f"[provided] WARNING {warning}", flush=True)
    return warning


def adopt(scan: str) -> dict[str, dict]:
    """Copy every provided model into ``reconstructed_objs/`` and return {Name: record}.

    Idempotent: a model whose source, turn and adopted copy are unchanged is left as it is, so a
    rerun does not refresh its mtime or trace it again; a changed one replaces the old copy (which
    is retired to ``.stale`` like any invalidated result). Runs whether or not the stage is forced:
    a provided model is never something to regenerate.
    """
    recon = config.reconstruct_dir(scan)
    record_path = recon / RECORD
    found = find(scan)
    if not found and not record_path.exists():
        return {}
    turns = {}
    for name, deg in pairs(os.environ.get("LR_PROVIDED_TURN"), "LR_PROVIDED_TURN").items():
        if name not in found:
            raise ValueError(f"LR_PROVIDED_TURN: {name} is not a provided model "
                             f"(provided: {', '.join(sorted(found)) or '(none)'})")
        if found[name].is_dir():
            raise ValueError(f"LR_PROVIDED_TURN: {name} is a procedural folder; the room is rebuilt "
                             f"from its object.py, which a turned GLB would not change")
        try:
            turns[name] = float(deg)
        except ValueError:
            raise ValueError(f"LR_PROVIDED_TURN: {name}={deg} is not a number of degrees") from None
    before = (artifact_cache.read_json(record_path) or {}).get("models", {})
    recon.mkdir(parents=True, exist_ok=True)
    models: dict[str, dict] = {}
    for name, src in found.items():
        turn = turns.get(name, 0.0)
        digest = _source_digest(src)
        glb = recon / f"{name}.glb" if src.is_file() else recon / name / f"{name}.glb"
        old = before.get(name) or {}
        if (old.get("source_digest") == digest and old.get("turn", 0.0) == turn
                and old.get("glb_digest") == artifact_cache.file_hash(glb)):
            models[name] = old
            continue
        # Either shape left by an earlier run (a TRELLIS glb and its receipt, a procedural folder).
        flat = recon / f"{name}.glb"
        artifact_cache.retire([flat, artifact_cache.receipt_path(flat), recon / name], recon)
        if src.is_dir():
            _copy_folder(src, recon / name, name)
        elif turn:
            _turn_glb(src, glb, turn)
        else:
            shutil.copy(src, glb)  # not copy2: an old mtime would put the event before the scan
        at = glb.stat().st_mtime
        models[name] = {"source": str(src), "source_digest": digest, "turn": turn,
                        "glb": str(glb.relative_to(recon)),
                        "glb_digest": artifact_cache.file_hash(glb), "adopted_at": at}
        warning = check_proportions(scan, name, glb)
        if warning:
            models[name]["warning"] = warning
        # The id makes the record idempotent across reruns and resumed runs alike.
        telemetry.record(config.traces_dir(scan), "object_done", at=at, name=name,
                         method="provided", status="ok", reused=True, source=str(src),
                         event_id=artifact_cache.fingerprint(
                             {"provided": name, "glb": models[name]["glb_digest"]}))
        print(f"[provided] {name} <- {src}" + (f" (turned {turn:g}°)" if turn else ""), flush=True)
    if models != before or not record_path.exists():
        artifact_cache.atomic_json(record_path, {"source": os.environ.get("LR_PROVIDED_MODELS", ""),
                                                 "models": models})
    if models:
        print(f"[provided] {len(models)} model(s) adopted: {', '.join(sorted(models))}", flush=True)
    return models
