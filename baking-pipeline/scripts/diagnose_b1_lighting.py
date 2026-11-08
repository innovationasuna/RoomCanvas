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


POINTS = {
    "01-entry": ((0.46, 0.07), (0.48, 0.12), (0.80, 0.18), (0.80, 0.35), (0.50, 0.50), (0.50, 0.72)),
    "02-reverse": ((0.25, 0.50), (0.50, 0.50), (0.75, 0.50), (0.25, 0.72), (0.50, 0.72), (0.75, 0.72)),
    "03-left": ((0.46, 0.06), (0.50, 0.12), (0.50, 0.32), (0.72, 0.35), (0.50, 0.60), (0.72, 0.70)),
    "04-right": ((0.52, 0.48), (0.60, 0.62), (0.68, 0.75), (0.82, 0.25), (0.82, 0.50), (0.82, 0.72)),
}

PASSES = ("DiffDir", "DiffInd", "GlossDir", "GlossInd", "TransDir", "TransInd", "Emit", "Env", "DiffCol", "GlossCol")


def read_glb(path):
    data = path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    return data, json.loads(data[20:20 + json_length].decode("utf-8").rstrip("\x00 "))


def socket_value(socket):
    value = socket.default_value
    if isinstance(value, (float, int)):
        default = value
    elif hasattr(value, "__iter__"):
        default = list(value)
    else:
        default = str(value)
    return {
        "default": default,
        "source": {"node": socket.links[0].from_node.name, "socket": socket.links[0].from_socket.name} if socket.is_linked else None,
    }


def describe_material(material):
    tree = material.node_tree
    principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    names = ("Base Color", "Metallic", "Roughness", "IOR", "Specular IOR Level", "Specular Tint",
             "Anisotropic IOR Level", "Coat Weight", "Coat Roughness", "Alpha", "Transmission Weight",
             "Emission Color", "Emission Strength", "Normal")
    textures = []
    for node in tree.nodes:
        if node.type != "TEX_IMAGE" or not node.image:
            continue
        vector = node.inputs["Vector"]
        textures.append({
            "node": node.name,
            "image": node.image.name,
            "colorSpace": node.image.colorspace_settings.name,
            "vectorSource": {"node": vector.links[0].from_node.name, "socket": vector.links[0].from_socket.name,
                             "uvMap": getattr(vector.links[0].from_node, "uv_map", None)} if vector.is_linked else None,
            "links": [{"toNode": link.to_node.name, "toSocket": link.to_socket.name} for link in node.outputs["Color"].links],
        })
    normal_maps = [{"node": node.name, "strength": node.inputs["Strength"].default_value,
                    "source": socket_value(node.inputs["Color"])["source"]}
                   for node in tree.nodes if node.type == "NORMAL_MAP"]
    return {
        "name": material.name,
        "doubleSidedInBlender": not material.use_backface_culling,
        "inputs": {name: socket_value(principled.inputs[name]) for name in names if principled and name in principled.inputs},
        "textures": textures,
        "normalMaps": normal_maps,
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
    return {"pixel": [u, v_from_top], "object": obj.name, "role": obj.get("bakeRole"),
            "material": material, "position": list(position), "normal": list(normal),
            "normalTowardRay": normal.dot(-direction) > 0}


def configure_cycles(config):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from bake_room import configure_cycles as configure
    return configure(config)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--label", default="remaining-visual-review")
    parser.add_argument("--render-passes", action="store_true")
    parser.add_argument("--views", nargs="*", default=["01-entry", "04-right"])
    parser.add_argument("--resolution-percent", type=int, default=25)
    parser.add_argument("--samples", type=int, default=32)
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / args.label / "lighting"
    target_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise ValueError("Scene does not match the locked source hash")
    source_data, source = read_glb((root / config["sourceModel"]).resolve())
    if hashlib.sha256(source_data).hexdigest() != config["expectedSha256"]:
        raise ValueError("Original GLB hash changed")
    source_materials = {material.get("name"): material for material in source.get("materials", [])}
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = 100
    report = {
        "stage": "B1 material/object/channel sampling; no saved scene or lightmap bake",
        "sourceSha256": config["expectedSha256"],
        "sceneLinearRerenderedForSamples": False,
        "lightmapsRebaked": False,
        "views": {},
        "materials": {},
    }
    material_names = set()
    for view in config["camera"]["views"]:
        view_id = view["id"]
        camera = bpy.data.objects[f"CAM_{view_id}"]
        scene.camera = camera
        bpy.context.view_layer.update()
        rows = [ray_sample(scene, camera, u, v) for u, v in POINTS[view_id]]
        material_names.update(row["material"] for row in rows if row.get("material"))
        image = bpy.data.images.load(str(output_dir / "previews" / "scene-linear" / f"{view_id}-offline-full-pbr.exr"), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        for row in rows:
            row["combinedLinearRgb"] = sample_image(image, *row["pixel"])
        bpy.data.images.remove(image)
        report["views"][view_id] = {"samples": rows}
    for name in sorted(material_names):
        report["materials"][name] = {
            "source": source_materials.get(name),
            "blender": describe_material(bpy.data.materials[name]),
        }
    path = target_dir / "material-report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"MATERIAL_DIAGNOSTIC_COMPLETE {path}", flush=True)
    if not args.render_passes:
        return

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import apply_display_transform, save_display_rgb

    device = configure_cycles(config)
    scene.cycles.samples = args.samples
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.resolution_percentage = args.resolution_percent
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    view_layer = bpy.context.view_layer
    for socket, attribute in (("DiffDir", "use_pass_diffuse_direct"), ("DiffInd", "use_pass_diffuse_indirect"),
                              ("GlossDir", "use_pass_glossy_direct"), ("GlossInd", "use_pass_glossy_indirect"),
                              ("TransDir", "use_pass_transmission_direct"), ("TransInd", "use_pass_transmission_indirect"),
                              ("DiffCol", "use_pass_diffuse_color"), ("GlossCol", "use_pass_glossy_color")):
        setattr(view_layer, attribute, True)
    view_layer.use_pass_emit = True
    view_layer.use_pass_environment = True
    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    layers = tree.nodes.new("CompositorNodeRLayers")
    layers.scene = scene
    layers.layer = view_layer.name
    pass_report = {
        "device": device,
        "resolutionPercent": args.resolution_percent,
        "samples": args.samples,
        "seed": 0,
        "scope": "Small Cycles pass renders in memory. Original lights, materials, IBL, geometry and visibility are unchanged. No scene is saved and no lightmap is baked.",
        "views": {},
    }
    for view_id in args.views:
        scene.camera = bpy.data.objects[f"CAM_{view_id}"]
        bpy.context.view_layer.update()
        pass_dir = target_dir / "passes" / view_id
        pass_dir.mkdir(parents=True, exist_ok=True)
        scene.render.image_settings.file_format = "OPEN_EXR"
        scene.render.image_settings.color_depth = "32"
        scene.render.image_settings.exr_codec = "ZIP"
        scene.render.filepath = str(pass_dir / f"{view_id}-Combined.exr")
        output = tree.nodes.new("CompositorNodeOutputFile")
        output.format.file_format = "OPEN_EXR"
        output.format.color_mode = "RGB"
        output.format.color_depth = "32"
        output.format.exr_codec = "ZIP"
        output.file_slots.clear()
        output.base_path = str(pass_dir)
        for name in PASSES:
            output.file_slots.new(f"{view_id}-{name}")
            tree.links.new(layers.outputs[name], output.inputs[f"{view_id}-{name}"])
        bpy.ops.render.render(write_still=True)
        tree.nodes.remove(output)
        view_report = {"passes": {}, "combined": str(Path(scene.render.filepath).relative_to(target_dir))}
        for name in PASSES:
            linear_path = pass_dir / f"{view_id}-{name}{scene.frame_current:04d}.exr"
            if not linear_path.is_file():
                candidates = sorted(pass_dir.glob(f"{view_id}-{name}*.exr"))
                if len(candidates) != 1:
                    raise FileNotFoundError(f"Cannot identify pass output for {view_id} {name}: {candidates}")
                linear_path = candidates[0]
            image = bpy.data.images.load(str(linear_path), check_existing=False)
            image.colorspace_settings.name = "Non-Color"
            pixels = np.asarray(image.pixels[:], dtype=np.float64).reshape(image.size[1], image.size[0], 4)
            mean_linear = pixels[..., :3].mean(axis=(0, 1)).tolist()
            ray_samples = [sample_image(image, *sample["pixel"]) for sample in report["views"][view_id]["samples"]]
            png_path = pass_dir / f"{view_id}-{name}.png"
            pixels[..., :3] = apply_display_transform(pixels[..., :3], config)
            save_display_rgb(pixels, png_path, scene)
            view_report["passes"][name] = {
                "linear": str(linear_path.relative_to(target_dir)),
                "png": str(png_path.relative_to(target_dir)),
                "meanLinearRgb": mean_linear,
                "raySamples": ray_samples,
            }
            bpy.data.images.remove(image)
            print(f"LIGHTING_PASS {view_id} {name}", flush=True)
        pass_report["views"][view_id] = view_report
    path = target_dir / "pass-report.json"
    path.write_text(json.dumps(pass_report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"LIGHTING_PASS_COMPLETE {path}", flush=True)


if __name__ == "__main__":
    main()
