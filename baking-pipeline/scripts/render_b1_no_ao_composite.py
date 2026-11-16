#!/usr/bin/env python3
"""E4: quantify the AO term in the diagnostic composite.

Opens the baked blend read-only, builds the existing diagnostic material twice:
once unchanged (base x (direct + indirect) x AO) and once with the AO multiply
bypassed (base x (direct + indirect)). Renders the entry and right views at
25% / 32 spp and reports ROI brightness and tint in linear and display space.

Invoke:
    blender.exe --background example_room_2.baked.blend \
        --python scripts/render_b1_no_ao_composite.py -- \
        --config configs/example_room_2.json
"""

import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

PHONE_RAW_SIZE = (2640, 1200)
PHONE_VIEWPORT_WIDTH = 2486
PHONE_LEFT_STRIP = 154
ROIS = {
    "01-entry": {"ceiling": (820, 8, 1440, 215), "full": (154, 0, 2640, 1200)},
    "04-right": {"ceiling": (1460, 8, 2250, 140), "full": (154, 0, 2640, 1200)},
}


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="E4 no-AO recomposite")
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--views", nargs="+", default=["01-entry", "04-right"])
    parser.add_argument("--resolution-percent", type=int, default=25)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--tag", default="e4-no-ao")
    return parser.parse_args(argv)


def roi_box(width, height, view_id, roi_id):
    x0, y0, x1, y1 = ROIS[view_id][roi_id]
    return (
        round((x0 - PHONE_LEFT_STRIP) / PHONE_VIEWPORT_WIDTH * width),
        round(y0 / PHONE_RAW_SIZE[1] * height),
        round((x1 - PHONE_LEFT_STRIP) / PHONE_VIEWPORT_WIDTH * width),
        round(y1 / PHONE_RAW_SIZE[1] * height),
    )


def load_pixels(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    image.colorspace_settings.name = "Non-Color"
    pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(
        image.size[1], image.size[0], 4).copy()
    bpy.data.images.remove(image)
    return np.flipud(pixels)


def stats(linear, png, view_id, roi_id):
    x0, y0, x1, y1 = roi_box(linear.shape[1], linear.shape[0], view_id, roi_id)
    crop_linear = linear[y0:y1, x0:x1, :3]
    # PNG is loaded as Non-Color, so its pixels are already sRGB-encoded 0..1.
    crop_display = load_pixels(png)[y0:y1, x0:x1, :3] * 255.0
    linear_mean = crop_linear.reshape(-1, 3).mean(axis=0)
    display_mean = crop_display.reshape(-1, 3).mean(axis=0)
    return {
        "meanLinearRgb": [round(float(value), 6) for value in linear_mean],
        "meanDisplayRgb": [round(float(value), 2) for value in display_mean],
        "rMinusBLinear": round(float(linear_mean[0] - linear_mean[2]), 6),
        "rMinusGLinear": round(float(linear_mean[0] - linear_mean[1]), 6),
        "rMinusBDisplay": round(float(display_mean[0] - display_mean[2]), 2),
        "rMinusGDisplay": round(float(display_mean[0] - display_mean[1]), 2),
    }


def disable_ao(material, ao_image):
    tree = material.node_tree
    ao_node = next(
        node for node in tree.nodes
        if node.type == "MIX_RGB" and node.blend_type == "MULTIPLY"
        and node.inputs[2].is_linked
        and node.inputs[2].links[0].from_node.type == "TEX_IMAGE"
        and node.inputs[2].links[0].from_node.image == ao_image
    )
    base_node = next(
        node for node in tree.nodes
        if node.type == "MIX_RGB" and node.blend_type == "MULTIPLY"
        and node.inputs[2].is_linked and node.inputs[2].links[0].from_node == ao_node
    )
    add_socket = ao_node.inputs[1].links[0].from_socket
    tree.links.new(add_socket, base_node.inputs[2])


def main():
    args = parse_args()
    config_path = args.config.resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    root = config_path.parents[1]
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / "lead-review-2026-11-10" / args.tag
    target_dir.mkdir(parents=True, exist_ok=True)
    preparation = json.loads((output_dir / "preparation-report.json").read_text(encoding="utf-8"))

    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise RuntimeError(f"Baked scene hash mismatch: {scene.get('sourceSha256')}")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bake_room import configure_cycles, make_diagnostic_materials, restore_materials
    from filament_display import save_scene_linear_preview

    configure_cycles(config)
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = args.resolution_percent
    scene.render.film_transparent = False
    scene.cycles.samples = args.samples
    scene.cycles.seed = 0

    static_objects = [obj for obj in bpy.data.collections["01_STATIC_BAKE"].objects
                      if obj.type == "MESH"]
    image_paths = {
        "B1_DIRECT_DIFFUSE": "lightmaps/direct-diffuse.exr",
        "B1_INDIRECT": "lightmaps/indirect.exr",
        "B1_AO": "lightmaps/ao.png",
    }
    images = {}
    for name, relative in image_paths.items():
        image = bpy.data.images.load(str(output_dir / relative), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        images[name] = image

    start_yaw = preparation["cameras"][0]["yawDegrees"]
    report = {
        "stage": "E4 diagnostic composite with and without the AO multiply; read-only baked scene",
        "generatedAt": datetime.now().astimezone().isoformat(),
        "sourceSha256": scene["sourceSha256"],
        "formula": {
            "ao": "base x ((direct + indirect) x AO)",
            "noAo": "base x (direct + indirect)",
        },
        "render": {"resolutionPercent": args.resolution_percent, "samples": args.samples, "seed": 0},
        "views": {},
    }

    for view_id in args.views:
        view = next(item for item in config["camera"]["views"] if item["id"] == view_id)
        yaw = math.radians(start_yaw + view.get("offlineYawOffsetDegrees", view["yawOffsetDegrees"]))
        pitch = math.radians(view["pitchDegrees"])
        direction = Vector((-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
        camera = bpy.data.objects[f"CAM_{view_id}"]
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        scene.camera = camera

        outputs = {}
        for mode in ("ao", "no-ao"):
            mapping = make_diagnostic_materials(static_objects, images)
            try:
                if mode == "no-ao":
                    for material in mapping.values():
                        disable_ao(material, images["B1_AO"])
                exr_path = target_dir / f"{view_id}-{mode}-diagnostic.exr"
                png_path = target_dir / f"{view_id}-{mode}-diagnostic.png"
                save_scene_linear_preview(scene, exr_path, png_path, config)
                outputs[mode] = {"exr": exr_path, "png": png_path}
            finally:
                restore_materials(mapping)

        view_report = {"rois": {}}
        linear = {mode: load_pixels(outputs[mode]["exr"]) for mode in outputs}
        for roi_id in ROIS[view_id]:
            ao = stats(linear["ao"], outputs["ao"]["png"], view_id, roi_id)
            no_ao = stats(linear["no-ao"], outputs["no-ao"]["png"], view_id, roi_id)
            factor = [round(no_ao["meanLinearRgb"][index] / max(ao["meanLinearRgb"][index], 1e-9), 4)
                      for index in range(3)]
            view_report["rois"][roi_id] = {
                "roiRaw": list(ROIS[view_id][roi_id]),
                "ao": ao,
                "noAo": no_ao,
                "aoLinearFactor": factor,
                "aoBrightnessContributionPercent": [
                    round((1.0 - 1.0 / value) * 100.0, 2) if value else None for value in factor
                ],
                "pngs": {
                    mode: str(outputs[mode]["png"].relative_to(output_dir)).replace("\\", "/")
                    for mode in outputs
                },
            }
            print(f"E4_ROI {view_id} {roi_id} aoFactor={factor} "
                  f"aoMean={ao['meanDisplayRgb']} noAoMean={no_ao['meanDisplayRgb']}", flush=True)
        report["views"][view_id] = view_report

    report_path = target_dir / "e4-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"E4_COMPLETE {report_path}", flush=True)


if __name__ == "__main__":
    main()
