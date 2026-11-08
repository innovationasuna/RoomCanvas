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
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    preview_dir = args.output_dir.resolve() if args.output_dir else output_dir / "previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import apply_display_transform, display_metadata, save_display_rgb

    scene = bpy.context.scene
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    rows = []
    for view in config["camera"]["views"]:
        for suffix in ("baked-static-diagnostic", "offline-full-pbr"):
            stem = f"{view['id']}-{suffix}"
            linear_path = output_dir / "previews" / "scene-linear" / f"{stem}.exr"
            png_path = preview_dir / f"{stem}.png"
            image = bpy.data.images.load(str(linear_path), check_existing=False)
            image.colorspace_settings.name = "Non-Color"
            rgb = np.asarray(image.pixels[:], dtype=np.float64).reshape(image.size[1], image.size[0], 4)
            rgb[..., :3] = apply_display_transform(rgb[..., :3], config)
            if not np.isfinite(rgb).all():
                raise ValueError(f"Non-finite display pixels in {stem}")
            save_display_rgb(rgb, png_path, scene)
            bpy.data.images.remove(image)
            rows.append({"linear": str(linear_path.relative_to(output_dir)), "png": str(png_path.relative_to(output_dir)), "allPixelsFinite": True})
            print(f"REPROCESSED {stem}", flush=True)
    metadata = display_metadata(config)
    report = {"sceneLinearRerendered": False, "lightmapsRebaked": False, "display": metadata, "previews": rows}
    (preview_dir / "reprocess-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if not args.output_dir:
        bake_report_path = output_dir / "bake-report.json"
        bake_report = json.loads(bake_report_path.read_text(encoding="utf-8"))
        bake_report["previewDisplay"] = metadata
        bake_report["displayReprocess"] = {"sceneLinearRerendered": False, "lightmapsRebaked": False, "report": "previews/reprocess-report.json"}
        bake_report_path.write_text(json.dumps(bake_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("DISPLAY_REPROCESS_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
