"""Rebuild items with TRELLIS, the way scene_init rebuilds furniture.

Evidence sheet (`make_weighted_input_sheet`) and prompt (`build_prompt`) -> a clean reference
from the configured OpenAI image model (`generate_reference`, gpt-image-2 by default) -> TRELLIS
through the configured launcher, all items in one process so the model loads once -> drop
floating fragments (pieces under 1% of the surface), which TRELLIS leaves around thin parts.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import numpy as np

from litereality_agent.pipeline.scene_init.ingest.references import image_gen
from litereality_agent.pipeline.scene_init.ingest.references.object_references import (
    build_prompt,
    make_weighted_input_sheet,
)
from litereality_agent.pipeline.scene_init.reconstruct.flow import LAUNCHER, resolve_python
from litereality_agent.settings import load_settings

FRAGMENT_SHARE = 0.01


def make_reference(item: dict, tiles: list[dict], description: str, out: Path) -> dict:
    """Sheet, prompt and generated reference for one item; returns the image call's metadata."""
    out.mkdir(parents=True, exist_ok=True)
    sheet, raw, reference = out / "sheet.jpg", out / "reference_raw.png", out / "reference.png"
    make_weighted_input_sheet(tiles, sheet)
    prompt = build_prompt(item["label"], item["category"], {"size": item["size"]}, len(tiles))
    if description:
        prompt += f" The real object is {description.rstrip('.')}."
    if len(item["members"]) > 1:
        prompt += (" Render the whole stack as one object, as it stands in the photos; keep every"
                   " item of the stack.")
    (out / "prompt.txt").write_text(prompt, encoding="utf-8")
    model = os.environ.get("LR_OPENAI_IMAGE_MODEL") or "gpt-image-2"
    meta = image_gen.generate_reference(sheet, prompt, raw, model=model,
                                        response_dir=out / "responses") or {"status": "exists"}
    image_gen.normalize_reference(raw, reference)
    return meta


def run_trellis(references: dict[str, Path], work: Path, log: Path) -> dict[str, dict]:
    """TRELLIS over every reference, the model loaded once per process; returns
    {id: {"glb": path, "pipeline": type}} for the meshes that were written.

    One item can need more GPU memory than a 24 GB card has (a tall book pile asked for 7.9 GB
    more while remeshing); the failure leaves the process's CUDA state broken, so every later
    item fails too. When a process makes no progress, the first missing item is set aside and
    the rest go on in a fresh process. Set-aside items get one more try at 512 resolution."""
    outputs = work / "glb"
    launcher = os.environ.get("LITEREALITY_TRELLIS_LAUNCHER") or str(LAUNCHER)
    python = resolve_python(load_settings().trellis_python)  # either env name, as settings read it
    env = {**os.environ, "PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"}
    result: dict[str, dict] = {}

    def collect(pipeline):
        for oid in references:
            if oid not in result and (outputs / f"{oid}.glb").exists():
                result[oid] = {"glb": outputs / f"{oid}.glb", "pipeline": pipeline}

    def run(ids, pipeline):
        inputs = work / f"inputs-{pipeline}"
        shutil.rmtree(inputs, ignore_errors=True)
        inputs.mkdir(parents=True)
        for oid in ids:
            (inputs / f"{oid}.png").symlink_to(references[oid].resolve())
        cmd = [python, launcher, "-i", str(inputs), "-o", str(outputs), "--skip-existing"]
        if pipeline != "default":
            cmd += ["--pipeline-type", pipeline]
        with log.open("a") as handle:
            handle.write(f"\n[small-objects] TRELLIS {pipeline} on {', '.join(ids)}\n")
            handle.flush()
            subprocess.run(cmd, env=env, stdout=handle, stderr=subprocess.STDOUT)
        collect(pipeline)

    collect("default")
    set_aside: list[str] = []
    while todo := sorted(oid for oid in references if oid not in result and oid not in set_aside):
        run(todo, "default")
        if all(oid not in result for oid in todo):  # no progress: the first one is the problem
            set_aside.append(todo[0])
    for oid in set_aside:
        run([oid], "512")
    return result


def drop_fragments(source: Path, target: Path) -> dict:
    """Keep connected pieces holding at least 1% of the surface; texture and UVs untouched."""
    import trimesh

    scene = trimesh.load(source, process=False)
    counts = {"pieces_before": 0, "pieces_after": 0}
    for mesh in scene.geometry.values():
        # Weld by position so texture seams do not split one surface into many pieces.
        key = np.round(mesh.vertices / 1e-5).astype(np.int64)
        _, weld = np.unique(key, axis=0, return_inverse=True)
        weld = weld.reshape(-1)
        labels = trimesh.graph.connected_component_labels(
            trimesh.geometry.faces_to_edges(weld[mesh.faces]), node_count=int(weld.max()) + 1)
        face_label = labels[weld[mesh.faces[:, 0]]]
        surface = np.bincount(face_label, weights=mesh.area_faces)
        keep = surface >= FRAGMENT_SHARE * surface.sum()
        counts["pieces_before"] += int((surface > 0).sum())
        counts["pieces_after"] += int(keep.sum())
        mesh.update_faces(keep[face_label])
        mesh.remove_unreferenced_vertices()
    target.parent.mkdir(parents=True, exist_ok=True)
    scene.export(target)
    return counts
