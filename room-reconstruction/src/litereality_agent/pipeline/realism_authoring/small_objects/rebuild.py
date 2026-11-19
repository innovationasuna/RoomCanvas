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
# TRELLIS predicts PBR maps itself and gave a fabric bag metallic 0.4; only these keep its guess.
MAY_BE_METAL = {"fan", "lamp", "camera", "clock", "appliance", "tool", "monitor", "television"}
HUE_TOLERANCE = 8.0  # degrees between the reference's and the texture's dominant colour
# Turning every colour by one angle only fits a thing of one strong colour (a magenta bag); on a
# pile of books with yellow, green and teal spines it turned them pink and orange.
ONE_COLOUR_SHARE = 0.5  # saturated pixels must cover at least this much of the surface
ONE_COLOUR_SPREAD = 0.85  # and their hues must agree (mean resultant length, 1 = one hue)


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


def dominant_hue(rgb: np.ndarray, weight: np.ndarray | None = None):
    """Circular mean hue (degrees) of the saturated pixels, their share, and how much their hues
    agree (1 = all one hue); hue None if too few."""
    rgb = rgb.astype(np.float64) / 255
    high, low = rgb.max(1), rgb.min(1)
    sat = np.where(high > 0, (high - low) / np.maximum(high, 1e-9), 0)
    weight = np.ones(len(rgb)) if weight is None else weight
    keep = (sat > 0.35) & (high > 0.15)
    share = weight[keep].sum() / max(weight.sum(), 1e-12)
    if share < 0.1:
        return None, share, 0.0
    r, g, b = rgb[keep].T
    hue = np.arctan2(np.sqrt(3) * (g - b), 2 * r - g - b)  # the HSV hue angle, in radians
    w = weight[keep] * sat[keep]
    s, c = (w * np.sin(hue)).sum(), (w * np.cos(hue)).sum()
    return float(np.degrees(np.arctan2(s, c))) % 360, share, float(np.hypot(s, c) / w.sum())


def correct_material(source: Path, reference: Path, category: str, target: Path) -> dict:
    """Turn the texture's dominant hue back to the reference's when TRELLIS drifted (it made a
    magenta bag red, the same for every seed), and zero metallic for non-metal things."""
    import trimesh
    from PIL import Image

    scene = trimesh.load(source, process=False)
    ref = np.asarray(Image.open(reference).convert("RGB")).reshape(-1, 3)
    ref_hue, ref_share, ref_spread = dominant_hue(ref[ref.max(1) > 30])
    if ref_share < ONE_COLOUR_SHARE or ref_spread < ONE_COLOUR_SPREAD:
        ref_hue = None  # not a one-colour thing: leave its colours alone
    report = {"reference_hue": ref_hue, "reference_share": round(float(ref_share), 3),
              "reference_agreement": round(ref_spread, 3),
              "metallic_zeroed": category not in MAY_BE_METAL}
    for mesh in scene.geometry.values():
        material = mesh.visual.material
        texture = getattr(material, "baseColorTexture", None)
        if texture is not None and ref_hue is not None:
            pixels = np.asarray(texture.convert("RGB"))
            h, w = pixels.shape[:2]
            uv = mesh.visual.uv[mesh.faces].mean(1)  # the texels the surface uses, by face area
            rows = np.clip(((1 - uv[:, 1]) * (h - 1)).astype(int), 0, h - 1)
            cols = np.clip((uv[:, 0] * (w - 1)).astype(int), 0, w - 1)
            tex_hue, share, spread = dominant_hue(pixels[rows, cols], mesh.area_faces)
            report.update(texture_hue=tex_hue, saturated_share=round(float(share), 3),
                          hue_agreement=round(spread, 3))
            if tex_hue is not None and share >= ONE_COLOUR_SHARE and spread >= ONE_COLOUR_SPREAD:
                shift = (ref_hue - tex_hue + 180) % 360 - 180
                report["hue_shift"] = round(shift, 1)
                if abs(shift) > HUE_TOLERANCE:
                    hsv = np.asarray(texture.convert("RGB").convert("HSV")).copy()
                    hsv[..., 0] = ((hsv[..., 0].astype(int) + round(shift / 360 * 256)) % 256)
                    rgb = Image.fromarray(hsv, "HSV").convert("RGB")
                    if texture.mode == "RGBA":
                        rgb.putalpha(texture.getchannel("A"))
                    material.baseColorTexture = rgb
                    report["hue_corrected"] = True
        if report["metallic_zeroed"]:
            material.metallicFactor = 0.0
            mr = getattr(material, "metallicRoughnessTexture", None)
            if mr is not None:
                arr = np.asarray(mr.convert("RGB")).copy()
                arr[..., 2] = 0  # glTF keeps metallic in the blue channel
                material.metallicRoughnessTexture = Image.fromarray(arr)
    target.parent.mkdir(parents=True, exist_ok=True)
    scene.export(target)
    return report
