import argparse
import json
import sys
from pathlib import Path

import bpy


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--view", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--resolution-percent", type=int, default=50)
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise ValueError("Scene source hash does not match configuration")
    if args.view not in {view["id"] for view in config["camera"]["views"]}:
        raise ValueError("Unknown fixed view")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bake_room import configure_cycles
    from filament_display import display_metadata, save_scene_linear_preview

    configure_cycles(config)
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = args.resolution_percent
    scene.camera = bpy.data.objects[f"CAM_{args.view}"]
    output_dir = root / "output" / config["roomId"] / "diagnostics"
    save_scene_linear_preview(scene, output_dir / f"{args.label}.exr", output_dir / f"{args.label}.png", config)
    report = {"sourceSha256": scene["sourceSha256"], "view": args.view, "resolutionPercent": args.resolution_percent, "display": display_metadata(config), "lights": [{"name": obj.name, "type": obj.data.type, "energy": obj.data.energy, "positionBlender": list(obj.location)} for obj in bpy.data.collections["04_A0_LIGHTS"].objects]}
    (output_dir / f"{args.label}.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"PBR_PREVIEW_COMPLETE {output_dir / f'{args.label}.png'}", flush=True)


if __name__ == "__main__":
    main()
