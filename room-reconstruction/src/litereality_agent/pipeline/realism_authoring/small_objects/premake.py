"""Small-object models made up front from the operator's photos, so the GPU work is done before the
author stage (hours) and the pass later needs no TRELLIS for them.

    python -m litereality_agent.pipeline.realism_authoring.small_objects.premake <photos> --out <dir>
        [--only Kind ...]

<photos>/<Kind>/*.jpg|*.jpeg are close-ups of one kind of thing (TissueBox, WaterBottle), with an
optional <photos>/<Kind>/description.txt (one line: what it is; without it "a tissue box" from the
name). A folder may instead (or also) hold reference.png, the thing alone and already cut out
(transparent around it, or on black): it is then the reference as it is and the image model is not
asked, for things whose one good view exists already. Each kind gets the steps the pass gives a
rebuilt item, minus what needs the room: the
reference sheet with the photos as tiles and the image model (rebuild.make_reference), TRELLIS
(rebuild.run_trellis, every kind in one process), pieces touching nothing dropped, and the hue turned
back to the reference and metal zeroed (rebuild.correct_material; it compares against the
generated reference, not the scan). Output:

    <out>/<Kind>.glb     the model; with LR_SMALL_OBJECTS_MODELS=<out> the pass uses it for the
                         items <Kind>, <Kind>0, <Kind>1 ... instead of asking Astra and TRELLIS
    <out>/<Kind>.json    its receipt: photo hashes, description and model settings
    <out>/work/<Kind>/   sheet, prompt, reference image, cleaned mesh
    <out>/logs/trellis.log

A kind whose receipt matches its inputs is skipped; one whose photos changed is made again. A kind
that fails leaves no <Kind>.glb behind, and the command exits 1.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from litereality_agent import artifact_cache as cache
from litereality_agent.pipeline.realism_authoring.small_objects import candidates, evidence, rebuild

SUPPLIED = "reference.png"  # in a kind's folder: the finished reference, used as it is


def photos(folder: Path) -> list[Path]:
    """The same photos the pass takes from LR_SMALL_OBJECTS_PHOTOS/<id>/."""
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg"))


def description(folder: Path, kind: str) -> str:
    note = folder / "description.txt"
    lines = note.read_text(encoding="utf-8").strip().splitlines() if note.is_file() else []
    return lines[0].strip() if lines else f"a {candidates.label(kind)}"


def settings() -> dict:
    """What the pass's own cache keys the image model by, and the TRELLIS launcher used."""
    loaded = rebuild.load_settings()
    return {"image_provider": loaded.image_provider, "image_model": loaded.image_model,
            "trellis_launcher": os.environ.get("LITEREALITY_TRELLIS_LAUNCHER") or str(rebuild.LAUNCHER)}


def premake(root: Path, out: Path, only: list[str] | None = None, concurrency: int = 4) -> dict:
    """{kind: {"photos", "glb", "error", "reused", "seconds"}} for every kind made or skipped."""
    started = time.monotonic()
    kinds = only or sorted(d.name for d in root.iterdir() if d.is_dir() and not d.name.startswith("."))
    work = out / "work"
    (out / "logs").mkdir(parents=True, exist_ok=True)
    model_settings = settings()
    rows, todo = {}, {}
    for kind in kinds:
        folder = root / kind
        shots, supplied = photos(folder), folder / SUPPLIED
        rows[kind] = {"photos": len(shots), "glb": None, "error": None, "reused": False}
        if not shots and not supplied.is_file():
            rows[kind]["error"] = f"no .jpg/.jpeg or {SUPPLIED} in {folder}"
            continue
        inputs = {"version": 1, "photos": {p.name: cache.file_hash(p) for p in shots},
                  "description": description(folder, kind), "settings": model_settings,
                  **({"reference": cache.file_hash(supplied)} if supplied.is_file() else {})}
        key = cache.fingerprint(inputs)
        glb, receipt = out / f"{kind}.glb", out / f"{kind}.json"
        made = cache.read_json(receipt)
        if isinstance(made, dict) and made.get("key") == key and made.get("output") == cache.file_hash(glb):
            rows[kind].update(glb=str(glb), reused=True)
            continue
        # Never leave an older model where the pass would adopt it while this one is being made.
        cache.retire([glb, receipt], out)
        if (cache.read_json(work / kind / "inputs.json") or {}).get("key") != key:
            cache.retire([work / kind, work / "_trellis" / "glb" / f"{kind}.glb"], out)
            cache.atomic_json(work / kind / "inputs.json", {"key": key, "inputs": inputs})
        todo[kind] = (shots, inputs, key)

    def reference(kind):
        shots, inputs, _ = todo[kind]
        label = candidates.label(kind)
        # The pass's own item fields; no scan, so no size, and the category is the last word.
        item = {"id": kind, "label": label, "category": label.split()[-1], "size": None,
                "members": [kind]}
        folder = work / kind
        if "reference" in inputs:  # the operator's own cut-out: no sheet, no image model
            rebuild.adopt_reference(root / kind / SUPPLIED, folder)
            return item, 0
        tiles = evidence.photo_inputs(shots, folder / "tiles")
        meta = rebuild.make_reference(item, tiles, inputs["description"], folder)
        return item, (meta or {}).get("cost_usd") or 0

    references, items = {}, {}
    with ThreadPoolExecutor(concurrency) as pool:
        futures = {pool.submit(reference, kind): kind for kind in todo}
        for future in as_completed(futures):
            kind = futures[future]
            try:
                items[kind], rows[kind]["image_cost_usd"] = future.result()
                references[kind] = work / kind / "reference.png"
            except Exception as exc:  # noqa: BLE001 — reported; the other kinds go on
                rows[kind]["error"] = f"reference: {type(exc).__name__}: {exc}"
                rows[kind]["seconds"] = time.monotonic() - started
    meshes = {}
    if references:
        print(f"[premake] TRELLIS on {len(references)} kinds", flush=True)
        (work / "_trellis").mkdir(parents=True, exist_ok=True)
        meshes = rebuild.run_trellis(references, work / "_trellis", out / "logs" / "trellis.log")
    for kind in references:
        _, inputs, key = todo[kind]
        glb, part = out / f"{kind}.glb", out / f".{kind}.glb.part"
        try:
            if kind not in meshes:
                raise RuntimeError(f"TRELLIS wrote no mesh (see {out / 'logs' / 'trellis.log'})")
            clean, model = work / kind / "mesh.glb", work / kind / "model.glb"
            fragments = rebuild.drop_fragments(meshes[kind]["glb"], clean)
            material = rebuild.correct_material(clean, references[kind], items[kind]["category"], model)
            shutil.copyfile(model, part)
            part.replace(glb)
            cache.atomic_json(out / f"{kind}.json", {
                "key": key, "output": cache.file_hash(glb), "inputs": inputs,
                "trellis_pipeline": meshes[kind]["pipeline"], "fragments": fragments,
                "material": material, "image_cost_usd": rows[kind].get("image_cost_usd")})
            rows[kind]["glb"] = str(glb)
        except Exception as exc:  # noqa: BLE001 — reported; nothing of it is left to adopt
            cache.retire([glb, out / f"{kind}.json"], out)
            rows[kind]["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            part.unlink(missing_ok=True)
        rows[kind]["seconds"] = time.monotonic() - started
    for row in rows.values():
        row.setdefault("seconds", 0.0)
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("photos", type=Path, help="<photos>/<Kind>/*.jpg")
    parser.add_argument("--out", type=Path, required=True, help="where <Kind>.glb are written")
    parser.add_argument("--only", nargs="*", help="make only these kinds")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args(argv)
    root = args.photos.resolve()
    if not root.is_dir():
        parser.error(f"{args.photos} is not a directory")
    rows = premake(root, args.out.resolve(), args.only, args.concurrency)
    if not rows:
        print(f"[premake] no kinds under {root}", flush=True)
        return 1
    for kind, row in rows.items():
        result = ("reused " if row["reused"] else "") + (row["glb"] or f"FAILED: {row['error']}")
        print(f"[premake] {kind}: {row['photos']} photos, {result}, {row['seconds']:.0f} s", flush=True)
    return 1 if any(row["error"] for row in rows.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
