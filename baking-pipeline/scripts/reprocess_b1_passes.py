import argparse
import json
import sys
from pathlib import Path

import bpy
import numpy as np


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--label", default="remaining-visual-review")
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / args.label / "lighting"
    pass_report = json.loads((target_dir / "pass-report.json").read_text(encoding="utf-8"))
    material_report = json.loads((target_dir / "material-report.json").read_text(encoding="utf-8"))
    scene = bpy.context.scene
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import apply_display_transform, save_display_rgb

    def load(relative):
        path = target_dir / relative
        image = bpy.data.images.load(str(path), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(image.size[1], image.size[0], 4).copy()
        bpy.data.images.remove(image)
        return pixels

    report = {
        "formula": "Combined includes (DiffDir + DiffInd) * DiffCol + (GlossDir + GlossInd) * GlossCol, plus transmission and emission terms. Raw light passes must not be added without their color passes.",
        "sceneLinearRerendered": False,
        "lightmapsRebaked": False,
        "sourcePassReport": "pass-report.json",
        "views": {},
    }
    for view_id, view_passes in pass_report["views"].items():
        paths = view_passes["passes"]
        raw = {name: load(paths[name]["linear"]) for name in ("DiffDir", "DiffInd", "GlossDir", "GlossInd", "DiffCol", "GlossCol")}
        combined = load(view_passes["combined"])
        direct_diffuse = raw["DiffDir"].copy()
        direct_diffuse[..., :3] *= raw["DiffCol"][..., :3]
        indirect_diffuse = raw["DiffInd"].copy()
        indirect_diffuse[..., :3] *= raw["DiffCol"][..., :3]
        direct_glossy = raw["GlossDir"].copy()
        direct_glossy[..., :3] *= raw["GlossCol"][..., :3]
        indirect_glossy = raw["GlossInd"].copy()
        indirect_glossy[..., :3] *= raw["GlossCol"][..., :3]
        direct = direct_diffuse + direct_glossy
        indirect = indirect_diffuse + indirect_glossy
        reconstructed = direct + indirect
        outputs = {
            "DiffDirWeighted": direct_diffuse,
            "GlossDirWeighted": direct_glossy,
            "DirectWeighted": direct,
            "IndirectWeighted": indirect,
            "DiffuseAndGlossyWeighted": reconstructed,
        }
        output_rows = {}
        for name, pixels in outputs.items():
            pixels = pixels.copy()
            mean_linear = pixels[..., :3].mean(axis=(0, 1)).tolist()
            pixels[..., :3] = apply_display_transform(pixels[..., :3], config)
            path = target_dir / Path(paths["DiffDir"]["png"]).parent / f"{view_id}-{name}.png"
            save_display_rgb(pixels, path, scene)
            output_rows[name] = {"png": str(path.relative_to(target_dir)), "meanLinearRgb": mean_linear}
        residual = reconstructed[..., :3] - combined[..., :3]
        samples = []
        for index, sample in enumerate(material_report["views"][view_id]["samples"]):
            dd = np.array(paths["DiffDir"]["raySamples"][index]) * np.array(paths["DiffCol"]["raySamples"][index])
            di = np.array(paths["DiffInd"]["raySamples"][index]) * np.array(paths["DiffCol"]["raySamples"][index])
            gd = np.array(paths["GlossDir"]["raySamples"][index]) * np.array(paths["GlossCol"]["raySamples"][index])
            gi = np.array(paths["GlossInd"]["raySamples"][index]) * np.array(paths["GlossCol"]["raySamples"][index])
            total = dd + di + gd + gi
            samples.append({
                "pixel": sample["pixel"],
                "object": sample["object"],
                "material": sample["material"],
                "directDiffuseRgb": dd.tolist(),
                "directGlossyRgb": gd.tolist(),
                "indirectDiffuseRgb": di.tolist(),
                "indirectGlossyRgb": gi.tolist(),
                "directGlossyShareOfDiffuseAndGlossy": float(np.sum(gd) / max(np.sum(total), 1e-12)),
                "indirectGlossyShareOfDiffuseAndGlossy": float(np.sum(gi) / max(np.sum(total), 1e-12)),
                "existingFullResolutionCombinedRgb": sample["combinedLinearRgb"],
                "sampleResolutionNote": "Pass products use the 25% diagnostic render; the separately listed combined value is the existing full-resolution EXR at the same normalized coordinate. Do not treat single-pixel equality as an acceptance test.",
            })
        report["views"][view_id] = {
            "outputs": output_rows,
            "diffuseAndGlossyResidualVsSmallCombinedMaeLinear": float(np.mean(np.abs(residual))),
            "residualBoundary": "Transmission, emission and any remaining terms are intentionally absent from this diffuse/glossy reconstruction; the residual is not an acceptance metric.",
            "samples": samples,
        }
        print(f"PASS_DECOMPOSITION {view_id}", flush=True)
    path = target_dir / "decomposition-report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"PASS_DECOMPOSITION_COMPLETE {path}", flush=True)


if __name__ == "__main__":
    main()
