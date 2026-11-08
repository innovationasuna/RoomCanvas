import argparse
import hashlib
import json
import math
import sys
from collections import Counter
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--views", nargs="*", default=["01-entry", "02-reverse"])
    parser.add_argument("--resolution-percent", type=int, default=50)
    parser.add_argument("--render", action="store_true")
    return parser.parse_args(argv)


def base_color_socket(material):
    principled = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    return principled.inputs["Base Color"] if principled else None


def describe_material(material):
    tree = material.node_tree
    base = base_color_socket(material)
    textures = []
    for node in tree.nodes:
        if node.type != "TEX_IMAGE" or not node.image:
            continue
        vector = node.inputs["Vector"]
        textures.append({
            "name": node.name,
            "image": node.image.name,
            "vectorLink": vector.links[0].from_socket.name if vector.is_linked else None,
            "vectorNode": vector.links[0].from_node.name if vector.is_linked else None,
            "uvMap": vector.links[0].from_node.uv_map if vector.is_linked and vector.links[0].from_node.type == "UVMAP" else None,
        })
    return {
        "name": material.name,
        "doubleSidedInBlender": not material.use_backface_culling,
        "surfaceRenderMethod": getattr(material, "surface_render_method", None),
        "baseDefault": list(base.default_value) if base else None,
        "baseSource": {"node": base.links[0].from_node.name, "socket": base.links[0].from_socket.name} if base and base.is_linked else None,
        "textures": textures,
    }


def load_images(output_dir):
    images = {}
    for name, relative in (("direct", "direct-diffuse.exr"), ("indirect", "indirect.exr"), ("ao", "ao.png")):
        image = bpy.data.images.load(str(output_dir / "lightmaps" / relative), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        images[name] = image
    return images


def sample_image(image, uv):
    x = min(image.size[0] - 1, max(0, int(uv[0] * image.size[0])))
    y = min(image.size[1] - 1, max(0, int(uv[1] * image.size[1])))
    index = (y * image.size[0] + x) * 4
    return list(image.pixels[index:index + 4])


def triangle_uv(obj, polygon_index, position):
    mesh = obj.data
    mesh.calc_loop_triangles()
    candidates = [triangle for triangle in mesh.loop_triangles if triangle.polygon_index == polygon_index]
    for triangle in candidates:
        vertices = [mesh.vertices[index].co for index in triangle.vertices]
        a, b, c = (obj.matrix_world @ vertex for vertex in vertices)
        normal = (b - a).cross(c - a)
        denominator = normal.length_squared
        if denominator < 1e-20:
            continue
        weights = [
            (b - position).cross(c - position).dot(normal) / denominator,
            (c - position).cross(a - position).dot(normal) / denominator,
            (a - position).cross(b - position).dot(normal) / denominator,
        ]
        if min(weights) < -1e-4:
            continue
        uv_layer = mesh.uv_layers.get("UV2_Lightmap")
        if not uv_layer:
            return None
        coordinates = [uv_layer.data[index].uv for index in triangle.loops]
        return tuple(sum(coordinates[corner][axis] * weights[corner] for corner in range(3)) for axis in range(2))
    return None


def ray_samples(scene, view_id, images):
    camera = bpy.data.objects[f"CAM_{view_id}"]
    aspect = scene.render.resolution_x / scene.render.resolution_y
    tangent = math.tan(camera.data.angle_y * 0.5)
    rows = []
    for v in (0.50, 0.59, 0.63, 0.66, 0.69, 0.72, 0.76, 0.83):
        for u in (0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80):
            direction = camera.matrix_world.to_3x3() @ Vector(((2 * u - 1) * tangent * aspect, (1 - 2 * v) * tangent, -1)).normalized()
            hit, position, normal, polygon_index, obj, matrix = scene.ray_cast(bpy.context.evaluated_depsgraph_get(), camera.location, direction)
            if not hit:
                continue
            uv = triangle_uv(obj, polygon_index, position) if obj.type == "MESH" else None
            rows.append({
                "pixel": [u, v],
                "object": obj.name,
                "role": obj.get("bakeRole"),
                "material": obj.data.materials[obj.data.polygons[polygon_index].material_index].name if obj.type == "MESH" and len(obj.data.materials) else None,
                "position": list(position),
                "normal": list(normal),
                "normalTowardRay": normal.dot(-direction) > 0,
                "uv2": uv,
                "channels": {name: sample_image(image, uv) for name, image in images.items()} if uv else None,
            })
    return rows


def install_materials(static_objects, images, mode):
    mapping = {}
    for obj in static_objects:
        for slot in obj.material_slots:
            original = slot.material
            if original in mapping:
                slot.material = mapping[original]
                continue
            material = original.copy()
            material.name = f"ISOLATION_ONLY_{mode}_{original.name}"
            mapping[original] = material
            tree = material.node_tree
            uv = tree.nodes.new("ShaderNodeUVMap")
            uv.uv_map = "UV2_Lightmap"

            def texture(name):
                node = tree.nodes.new("ShaderNodeTexImage")
                node.image = images[name]
                node.extension = "EXTEND"
                tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
                return node.outputs["Color"]

            def add(left, right):
                node = tree.nodes.new("ShaderNodeMixRGB")
                node.blend_type = "ADD"
                node.inputs[0].default_value = 1.0
                tree.links.new(left, node.inputs[1])
                tree.links.new(right, node.inputs[2])
                return node.outputs[0]

            def multiply(left, right):
                node = tree.nodes.new("ShaderNodeMixRGB")
                node.blend_type = "MULTIPLY"
                node.inputs[0].default_value = 1.0
                tree.links.new(left, node.inputs[1])
                tree.links.new(right, node.inputs[2])
                return node.outputs[0]

            base = base_color_socket(material)
            if mode in ("direct", "indirect", "ao"):
                color = texture(mode)
            elif mode == "sum":
                color = add(texture("direct"), texture("indirect"))
            elif mode == "base":
                color = base.links[0].from_socket if base.is_linked else None
            elif mode == "diagnostic":
                color = multiply(multiply(base.links[0].from_socket if base.is_linked else None, add(texture("direct"), texture("indirect"))), texture("ao")) if base.is_linked else multiply(add(texture("direct"), texture("indirect")), texture("ao"))
            elif mode == "uv-check":
                checker = tree.nodes.new("ShaderNodeTexChecker")
                checker.inputs["Scale"].default_value = 64.0
                tree.links.new(uv.outputs["UV"], checker.inputs["Vector"])
                color = checker.outputs["Color"]
            elif mode == "material-id":
                color = None
            else:
                raise ValueError(mode)
            emission = tree.nodes.new("ShaderNodeEmission")
            if mode == "base" and not base.is_linked:
                emission.inputs["Color"].default_value = base.default_value
            elif mode == "material-id":
                digest = hashlib.sha256(original.name.encode("utf-8")).digest()
                emission.inputs["Color"].default_value = tuple(0.15 + byte / 255 * 0.85 for byte in digest[:3]) + (1.0,)
            else:
                tree.links.new(color, emission.inputs["Color"])
            output = next(node for node in tree.nodes if node.type == "OUTPUT_MATERIAL")
            tree.links.new(emission.outputs[0], output.inputs["Surface"])
            slot.material = material
    return mapping


def restore_materials(mapping):
    for original, diagnostic in mapping.items():
        for obj in bpy.data.objects:
            for slot in obj.material_slots:
                if slot.material == diagnostic:
                    slot.material = original
        bpy.data.materials.remove(diagnostic)


def main():
    args = parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / args.label
    target_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    static_objects = [obj for obj in bpy.data.collections["01_STATIC_BAKE"].objects if obj.type == "MESH"]
    excluded = [obj for collection in ("02_DYNAMIC_REALTIME", "03_SPECIAL_REALTIME") for obj in bpy.data.collections[collection].objects if obj.type == "MESH"]
    original_visibility = {obj: obj.hide_render for obj in excluded}
    for obj in excluded:
        obj.hide_render = True
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = args.resolution_percent
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.view_transform = config["render"]["viewTransform"]
    scene.view_settings.look = config["render"]["look"]
    scene.view_settings.exposure = config["render"]["exposure"]
    scene.cycles.samples = 4
    images = load_images(output_dir)
    materials = sorted({slot.material for obj in static_objects for slot in obj.material_slots if slot.material}, key=lambda item: item.name)
    report = {
        "sourceSha256": scene["sourceSha256"],
        "blenderVersion": bpy.app.version_string,
        "renderSettings": {"viewTransform": scene.view_settings.view_transform, "look": scene.view_settings.look, "exposure": scene.view_settings.exposure},
        "materials": [describe_material(material) for material in materials],
        "doubleSidedObjectCounts": dict(Counter("double" if all(not slot.material.use_backface_culling for slot in obj.material_slots) else "singleOrMixed" for obj in static_objects)),
        "lightmapTargets": [{"material": material.name, "image": material.node_tree.nodes["B1_LIGHTMAP_TARGET"].image.name if material.node_tree.nodes.get("B1_LIGHTMAP_TARGET") and material.node_tree.nodes["B1_LIGHTMAP_TARGET"].image else None} for material in materials],
        "views": {},
    }
    for view_id in args.views:
        scene.camera = bpy.data.objects[f"CAM_{view_id}"]
        bpy.context.view_layer.update()
        report["views"][view_id] = ray_samples(scene, view_id, images)
        if args.render:
            for mode in ("diagnostic", "direct", "indirect", "ao", "sum", "base", "uv-check", "material-id"):
                mapping = install_materials(static_objects, images, mode)
                scene.render.filepath = str(target_dir / f"{view_id}-{mode}.png")
                bpy.ops.render.render(write_still=True)
                restore_materials(mapping)
    for obj, hidden in original_visibility.items():
        obj.hide_render = hidden
    (target_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"ISOLATION_COMPLETE {target_dir}", flush=True)


if __name__ == "__main__":
    main()
