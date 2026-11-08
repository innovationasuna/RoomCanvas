import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


def read_glb(path):
    data = path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20:20 + json_length].decode("utf-8").rstrip("\x00 "))
    return data, document


def filament_illuminant_d(temperature):
    inverse = 1.0 / temperature
    if temperature <= 7000.0:
        x = 0.244063 + 0.09911e3 * inverse + 2.9678e6 * inverse ** 2 - 4.6070e9 * inverse ** 3
    else:
        x = 0.237040 + 0.24748e3 * inverse + 1.9018e6 * inverse ** 2 - 2.0064e9 * inverse ** 3
    y = -3.0 * x * x + 2.87 * x - 0.275
    xyz = np.array((x / y, 1.0, (1.0 - x - y) / y), dtype=np.float64)
    transform = np.array(((3.2404542, -1.5371385, -0.4985314), (-0.9692660, 1.8760108, 0.0415560), (0.0556434, -0.2040259, 1.0572252)))
    unnormalized = transform @ xyz
    normalized = np.clip(unnormalized / max(1e-5, float(unnormalized.max())), 0.0, 1.0)
    return unnormalized.tolist(), normalized.tolist()


def socket_description(socket):
    value = socket.default_value
    if isinstance(value, (float, int)):
        default = value
    elif hasattr(value, "__iter__"):
        default = list(value)
    else:
        default = str(value)
    return {
        "default": default,
        "source": {
            "node": socket.links[0].from_node.name,
            "socket": socket.links[0].from_socket.name,
        } if socket.is_linked else None,
    }


def material_report(material):
    tree = material.node_tree
    principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    names = ("Base Color", "Metallic", "Roughness", "IOR", "Alpha", "Transmission Weight", "Emission Color", "Emission Strength")
    return {
        "name": material.name,
        "doubleSidedInBlender": not material.use_backface_culling,
        "surfaceRenderMethod": getattr(material, "surface_render_method", None),
        "inputs": {name: socket_description(principled.inputs[name]) for name in names if principled and name in principled.inputs},
        "images": [
            {
                "node": node.name,
                "image": node.image.name,
                "path": bpy.path.abspath(node.image.filepath),
                "colorSpace": node.image.colorspace_settings.name,
            }
            for node in tree.nodes if node.type == "TEX_IMAGE" and node.image
        ],
    }


def sample_image(image, u, v_from_top):
    x = min(image.size[0] - 1, max(0, int(u * image.size[0])))
    y = min(image.size[1] - 1, max(0, int((1.0 - v_from_top) * image.size[1])))
    index = (y * image.size[0] + x) * 4
    return list(image.pixels[index:index + 3])


def ray_sample(scene, camera, u, v_from_top):
    aspect = scene.render.resolution_x / scene.render.resolution_y
    tangent = math.tan(camera.data.angle_y * 0.5)
    direction = camera.matrix_world.to_3x3() @ Vector(((2 * u - 1) * tangent * aspect, (1 - 2 * v_from_top) * tangent, -1)).normalized()
    hit, position, normal, polygon_index, obj, _ = scene.ray_cast(bpy.context.evaluated_depsgraph_get(), camera.location, direction)
    if not hit:
        return {"pixel": [u, v_from_top], "object": None}
    material = None
    if obj.type == "MESH" and obj.data.materials:
        material = obj.data.materials[obj.data.polygons[polygon_index].material_index].name
    return {
        "pixel": [u, v_from_top],
        "object": obj.name,
        "role": obj.get("bakeRole"),
        "material": material,
        "position": list(position),
        "normal": list(normal),
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--render-contributions", action="store_true")
    parser.add_argument("--views", nargs="*", default=["01-entry", "02-reverse"])
    parser.add_argument("--variants", nargs="*", default=["all", "sun-only", "ceiling-only", "ibl-only"], choices=["all", "sun-only", "ceiling-only", "ibl-only"])
    parser.add_argument("--resolution-percent", type=int, default=25)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--label", default="same-condition-calibration")
    parser.add_argument("--normalize-light-colors", action="store_true")
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / args.label
    target_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise ValueError("Calibration scene does not match the locked source hash")
    source_data, source = read_glb((root / config["sourceModel"]).resolve())
    source_hash = hashlib.sha256(source_data).hexdigest()
    if source_hash != config["expectedSha256"]:
        raise ValueError("Original GLB hash changed")
    source_by_name = {material.get("name"): material for material in source.get("materials", [])}
    source_nodes = {node.get("name"): node for node in source.get("nodes", []) if "mesh" in node}
    light_rows = []
    for obj in sorted(bpy.data.collections["04_A0_LIGHTS"].objects, key=lambda item: item.name):
        data = obj.data
        temperature = 6500.0 if data.type == "SUN" else config["lighting"]["ceilingTemperatureKelvin"]
        unnormalized, expected = filament_illuminant_d(temperature)
        direction = obj.matrix_world.to_3x3() @ Vector((0.0, 0.0, -1.0))
        light_rows.append({
            "name": obj.name,
            "type": data.type,
            "energy": data.energy,
            "color": list(data.color),
            "temperatureKelvin": temperature,
            "unnormalizedFilamentColorBeforeSaturate": unnormalized,
            "expectedFilamentColor": expected,
            "positionBlender": list(obj.location),
            "directionBlender": list(direction),
            "angularDiameterDegrees": math.degrees(data.angle) if data.type == "SUN" else None,
            "shadowSoftSize": getattr(data, "shadow_soft_size", None),
            "filamentFalloffMeters": obj.get("filamentFalloffMeters"),
        })
    world = scene.world
    environment = next((node for node in world.node_tree.nodes if node.type == "TEX_ENVIRONMENT"), None)
    background = next((node for node in world.node_tree.nodes if node.type == "BACKGROUND"), None)
    hdr_path = Path(bpy.path.abspath(environment.image.filepath)) if environment and environment.image else None
    world_report = {
        "path": str(hdr_path) if hdr_path else None,
        "sha256": hashlib.sha256(hdr_path.read_bytes()).hexdigest() if hdr_path and hdr_path.is_file() else None,
        "strength": background.inputs["Strength"].default_value if background else None,
        "projection": environment.projection if environment else None,
        "vectorLinked": environment.inputs["Vector"].is_linked if environment else None,
        "explicitRotationTransform": any(node.type in ("MAPPING", "VECT_ROTATE") for node in world.node_tree.nodes),
        "filamentRuntimePath": "HDR -> equirectangular cubemap -> specularFilter; IndirectLight intensity 0.25",
        "equivalenceBoundary": "Cycles path-traced world illumination and Filament diffuse/specular IBL prefiltering are not proven equivalent by matching the HDR file or strength.",
    }
    material_names = ("Glazing", "Actual exterior view")
    materials = []
    for name in material_names:
        material = bpy.data.materials.get(name)
        source_material = source_by_name.get(name)
        users = [obj.name for obj in scene.objects if obj.type == "MESH" and any(slot.material == material for slot in obj.material_slots)]
        materials.append({
            "source": source_material,
            "blender": material_report(material) if material else None,
            "objectUsers": users,
            "roles": [bpy.data.objects[obj_name].get("bakeRole") for obj_name in users],
            "sourceNodes": [source_nodes.get(obj_name) for obj_name in users],
        })
    camera_rows = []
    for view in config["camera"]["views"]:
        camera = bpy.data.objects[f"CAM_{view['id']}"]
        camera_rows.append({
            "id": view["id"],
            "verticalFovDegrees": math.degrees(camera.data.angle_y),
            "horizontalFovDegrees": math.degrees(camera.data.angle_x),
            "sensorFit": camera.data.sensor_fit,
            "positionBlender": list(camera.location),
            "directionBlender": list(camera.matrix_world.to_3x3() @ Vector((0.0, 0.0, -1.0))),
        })
    bake_report = json.loads((output_dir / "bake-report.json").read_text(encoding="utf-8"))
    report = {
        "stage": "B1 same-condition calibration; no B2 integration",
        "blenderScene": bpy.data.filepath,
        "sourceSha256": source_hash,
        "bakedGlbSha256": hashlib.sha256((output_dir / "example_room_2.baked.glb").read_bytes()).hexdigest(),
        "normalCorrectionsPreserved": bake_report.get("normalCorrections", {}).get("flippedObjectCount") == 1084,
        "lightSources": light_rows,
        "world": world_report,
        "materials": materials,
        "cameras": camera_rows,
        "lightmaps": [{"name": row["name"], "master": row["master"]} for row in bake_report["passes"]],
        "scope": "Read-only scene/material inspection. No lightmap bake, GLB export, Android asset or saved Blender scene is produced.",
    }
    report_path = target_dir / "scene-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CALIBRATION_SCENE_REPORT {report_path}", flush=True)
    if not args.render_contributions:
        return

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bake_room import configure_cycles
    from filament_display import display_metadata, save_scene_linear_preview

    original_colors = {obj: tuple(obj.data.color) for obj in bpy.data.collections["04_A0_LIGHTS"].objects}
    normalization_rows = []
    if args.normalize_light_colors:
        for obj, original in original_colors.items():
            temperature = 6500.0 if obj.data.type == "SUN" else config["lighting"]["ceilingTemperatureKelvin"]
            _, expected = filament_illuminant_d(temperature)
            obj.data.color = expected
            normalization_rows.append({"light": obj.name, "before": list(original), "after": expected})
    device = configure_cycles(config)
    scene.cycles.samples = args.samples
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = args.resolution_percent
    lights = list(bpy.data.collections["04_A0_LIGHTS"].objects)
    original_visibility = {obj: obj.hide_render for obj in lights}
    original_strength = background.inputs["Strength"].default_value
    variants = tuple(args.variants)
    contribution_report = {
        "device": device,
        "resolutionPercent": args.resolution_percent,
        "samples": args.samples,
        "seed": 0,
        "display": display_metadata(config),
        "lightColorNormalization": normalization_rows,
        "scope": "Small Cycles diagnostic renders only. Dynamic/special meshes and emissive materials remain present; solo variants are not a claim of independent additive light-group decomposition.",
        "views": {},
    }
    points = ((0.25, 0.50), (0.50, 0.50), (0.75, 0.50), (0.25, 0.72), (0.50, 0.72), (0.75, 0.72))
    try:
        for view_id in args.views:
            scene.camera = bpy.data.objects[f"CAM_{view_id}"]
            bpy.context.view_layer.update()
            view_report = {"samples": [ray_sample(scene, scene.camera, u, v) for u, v in points], "variants": {}}
            for variant in variants:
                for obj in lights:
                    selected = variant == "all" or (variant == "sun-only" and obj.data.type == "SUN") or (variant == "ceiling-only" and obj.data.type != "SUN")
                    obj.hide_render = not selected
                background.inputs["Strength"].default_value = original_strength if variant in ("all", "ibl-only") else 0.0
                stem = f"{view_id}-{variant}"
                linear_path = target_dir / "contributions" / "scene-linear" / f"{stem}.exr"
                png_path = target_dir / "contributions" / f"{stem}.png"
                save_scene_linear_preview(scene, linear_path, png_path, config)
                image = bpy.data.images.load(str(linear_path), check_existing=False)
                image.colorspace_settings.name = "Non-Color"
                pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(image.size[1], image.size[0], 4)[..., :3]
                view_report["variants"][variant] = {
                    "linear": str(linear_path.relative_to(target_dir)),
                    "png": str(png_path.relative_to(target_dir)),
                    "meanLinearRgb": pixels.mean(axis=(0, 1)).tolist(),
                    "raySamples": [sample_image(image, *sample["pixel"]) for sample in view_report["samples"]],
                }
                bpy.data.images.remove(image)
                print(f"CALIBRATION_CONTRIBUTION {stem}", flush=True)
            contribution_report["views"][view_id] = view_report
    finally:
        for obj, hidden in original_visibility.items():
            obj.hide_render = hidden
        for obj, color in original_colors.items():
            obj.data.color = color
        background.inputs["Strength"].default_value = original_strength
    path = target_dir / "contribution-report.json"
    path.write_text(json.dumps(contribution_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CALIBRATION_CONTRIBUTIONS_COMPLETE {path}", flush=True)


if __name__ == "__main__":
    main()
