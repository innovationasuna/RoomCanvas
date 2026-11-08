"""Read-only ceiling/normal/direct-light boundary diagnostic for B1.

Run inside Blender with the existing baked scene. The script never saves the
scene, bakes a lightmap, edits the source GLB, or changes phone assets. All
outputs go to a dedicated diagnostics directory.
"""

import argparse
import hashlib
import json
import math
import struct
import sys
from pathlib import Path
from typing import Any

import bpy
import numpy as np
from mathutils import Vector

POINTS = {
    "01-entry": ((0.46, 0.07), (0.48, 0.12), (0.80, 0.18), (0.80, 0.35), (0.50, 0.50), (0.50, 0.72)),
    "02-reverse": ((0.25, 0.50), (0.50, 0.50), (0.75, 0.50), (0.25, 0.72), (0.50, 0.72), (0.75, 0.72)),
    "03-left": ((0.46, 0.06), (0.50, 0.12), (0.50, 0.32), (0.72, 0.35), (0.50, 0.60), (0.72, 0.70)),
    "04-right": ((0.52, 0.48), (0.60, 0.62), (0.68, 0.75), (0.82, 0.25), (0.82, 0.50), (0.82, 0.72)),
}


def read_glb(path: Path) -> tuple[bytes, dict[str, Any]]:
    data = path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    return data, json.loads(data[20:20 + json_length].decode("utf-8").rstrip("\x00 "))


def normal_matrix(obj: bpy.types.Object):
    return obj.matrix_world.to_3x3().inverted().transposed()


def world_normal(obj: bpy.types.Object, normal: Vector) -> Vector:
    return (normal_matrix(obj) @ normal).normalized()


def sample_pixel(image: bpy.types.Image, u: float, v_from_top: float) -> list[float] | None:
    width, height = image.size
    if width == 0 or height == 0:
        return None
    x = min(width - 1, max(0, int(u * width)))
    y = min(height - 1, max(0, int((1.0 - v_from_top) * height)))
    index = (y * width + x) * image.channels
    return [float(value) for value in image.pixels[index:index + 3]]


def sample_uv(image: bpy.types.Image, uv: tuple[float, float]) -> list[float] | None:
    width, height = image.size
    if width == 0 or height == 0:
        return None
    x = min(width - 1, max(0, int(uv[0] * width)))
    y = min(height - 1, max(0, int(uv[1] * height)))
    index = (y * width + x) * image.channels
    return [float(value) for value in image.pixels[index:index + 3]]


def first_images_upstream(socket: bpy.types.NodeSocket) -> list[bpy.types.Node]:
    result = []
    queue = [link.from_socket for link in socket.links]
    seen: set[int] = set()
    while queue:
        source = queue.pop(0)
        node = source.node
        marker = node.as_pointer()
        if marker in seen:
            continue
        seen.add(marker)
        if node.type == "TEX_IMAGE" and node.image:
            result.append(node)
            continue
        for input_socket in node.inputs:
            queue.extend(link.from_socket for link in input_socket.links)
    return result


def uv_map_for(node: bpy.types.Node) -> str | None:
    queue = [node.inputs["Vector"]]
    seen: set[int] = set()
    while queue:
        socket = queue.pop(0)
        for link in socket.links:
            source = link.from_node
            marker = source.as_pointer()
            if marker in seen:
                continue
            seen.add(marker)
            if source.type == "UVMAP" and source.uv_map:
                return source.uv_map
            for input_socket in source.inputs:
                queue.append(input_socket)
    return None


def texture_node_report(node: bpy.types.Node) -> dict[str, Any]:
    image = node.image
    return {
        "node": node.name,
        "image": image.name if image else None,
        "path": bpy.path.abspath(image.filepath) if image else None,
        "size": list(image.size) if image else None,
        "channels": image.channels if image else None,
        "colorSpace": image.colorspace_settings.name if image else None,
        "packed": bool(image.packed_file) if image else None,
        "uvMap": uv_map_for(node),
        "extension": node.extension,
        "interpolation": node.interpolation,
    }


def material_report(material: bpy.types.Material) -> dict[str, Any]:
    tree = material.node_tree
    principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    if not principled:
        return {"name": material.name, "principled": None}
    normal_link = principled.inputs["Normal"].links[0] if principled.inputs["Normal"].is_linked else None
    normal_node = normal_link.from_node if normal_link else None
    normal_images = first_images_upstream(normal_node.inputs["Color"]) if normal_node and normal_node.type == "NORMAL_MAP" else []
    base_color_images = first_images_upstream(principled.inputs["Base Color"])
    roughness_images = first_images_upstream(principled.inputs["Roughness"])
    return {
        "name": material.name,
        "doubleSidedInBlender": not material.use_backface_culling,
        "principled": {
            "baseColorDefault": list(principled.inputs["Base Color"].default_value),
            "baseColorLinked": principled.inputs["Base Color"].is_linked,
            "roughnessDefault": principled.inputs["Roughness"].default_value,
            "roughnessLinked": principled.inputs["Roughness"].is_linked,
            "metallicDefault": principled.inputs["Metallic"].default_value,
            "specularIorLevel": principled.inputs["Specular IOR Level"].default_value,
            "normalLinked": principled.inputs["Normal"].is_linked,
        },
        "normalMap": {
            "node": normal_node.name if normal_node else None,
            "type": normal_node.type if normal_node else None,
            "strength": normal_node.inputs["Strength"].default_value if normal_node and normal_node.type == "NORMAL_MAP" else None,
            "space": normal_node.space if normal_node and normal_node.type == "NORMAL_MAP" else None,
            "images": [texture_node_report(node) for node in normal_images],
        },
        "baseColorImages": [texture_node_report(node) for node in base_color_images],
        "roughnessImages": [texture_node_report(node) for node in roughness_images],
    }


def nearest_loop(mesh: bpy.types.Mesh, polygon: bpy.types.MeshPolygon, position: Vector, obj: bpy.types.Object) -> int:
    best_loop = polygon.loop_start
    best_distance = math.inf
    for loop_index in range(polygon.loop_start, polygon.loop_start + polygon.loop_total):
        vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
        distance = ((obj.matrix_world @ vertex.co) - position).length
        if distance < best_distance:
            best_distance = distance
            best_loop = loop_index
    return best_loop


def loop_normals(mesh: bpy.types.Mesh, polygon: bpy.types.MeshPolygon, obj: bpy.types.Object) -> list[Vector]:
    normals = []
    for loop_index in range(polygon.loop_start, polygon.loop_start + polygon.loop_total):
        normal = mesh.corner_normals[loop_index].vector
        normals.append(world_normal(obj, normal))
    return normals


def uv_at_loop(mesh: bpy.types.Mesh, loop_index: int, uv_map: str | None) -> list[float] | None:
    if not uv_map or uv_map not in mesh.uv_layers:
        return None
    uv = mesh.uv_layers[uv_map].data[loop_index].uv
    return [float(uv.x), float(uv.y)]


def spot_cone_factor(light: bpy.types.Object, to_light: Vector) -> float:
    data = light.data
    if data.type != "SPOT":
        return 1.0
    direction = light.matrix_world.to_3x3() @ Vector((0.0, 0.0, -1.0))
    angle = math.acos(max(-1.0, min(1.0, direction.normalized().dot(to_light.normalized()))))
    outer = data.spot_size * 0.5
    inner = outer * (1.0 - data.spot_blend)
    if angle >= outer:
        return 0.0
    if angle <= inner:
        return 1.0
    t = (outer - angle) / max(outer - inner, 1e-9)
    return t * t * (3.0 - 2.0 * t)


def light_terms(scene: bpy.types.Scene, position: Vector, normals: dict[str, Vector]) -> list[dict[str, Any]]:
    rows = []
    for light in sorted(bpy.data.collections["04_A0_LIGHTS"].objects, key=lambda item: item.name):
        if light.type != "LIGHT":
            continue
        data = light.data
        if data.type == "SUN":
            light_direction = (light.matrix_world.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
            direction = -light_direction
            distance = None
            irradiance = data.energy
            position_world = None
        else:
            to_light = light.matrix_world.translation - position
            distance = to_light.length
            if distance < 1e-9:
                continue
            direction = to_light.normalized()
            irradiance = data.energy / (4.0 * math.pi * distance * distance)
            irradiance *= spot_cone_factor(light, to_light)
            position_world = list(light.matrix_world.translation)
        row = {
            "name": light.name,
            "type": data.type,
            "positionWorld": position_world,
            "energy": data.energy,
            "color": list(data.color),
            "distanceMeters": distance,
            "toLight": list(direction),
            "irradiance": irradiance,
            "occlusionEvaluated": data.type != "SUN",
            "cos": {},
            "expectedDiffuseRgb": {},
        }
        for key, normal in normals.items():
            cosine = max(0.0, normal.dot(direction))
            row["cos"][key] = cosine
            row["expectedDiffuseRgb"][key] = [channel * irradiance * cosine / math.pi for channel in data.color]
        rows.append(row)
    return rows


def sum_expected(rows: list[dict[str, Any]], key: str) -> list[float]:
    total = [0.0, 0.0, 0.0]
    for row in rows:
        for index, value in enumerate(row["expectedDiffuseRgb"][key]):
            total[index] += value
    return total


def ratio(actual: list[float] | None, expected: list[float]) -> list[float | None] | None:
    if actual is None:
        return None
    return [actual[index] / expected[index] if abs(expected[index]) > 1e-9 else None for index in range(3)]


def source_material_for(source: dict[str, Any], object_name: str) -> dict[str, Any] | None:
    nodes = {node.get("name"): node for node in source.get("nodes", []) if "mesh" in node}
    node = nodes.get(object_name)
    if not node:
        return None
    mesh = source["meshes"][node["mesh"]]
    rows = []
    for primitive in mesh.get("primitives", []):
        material_index = primitive.get("material")
        material = source["materials"][material_index] if material_index is not None else None
        rows.append({
            "materialIndex": material_index,
            "material": material,
            "attributes": sorted(primitive.get("attributes", {})),
        })
    return {
        "nodeIndex": source["nodes"].index(node),
        "meshIndex": node["mesh"],
        "meshName": mesh.get("name"),
        "primitives": rows,
    }


def analyze_sample(scene: bpy.types.Scene, camera: bpy.types.Object, u: float, v: float, source: dict[str, Any]) -> dict[str, Any]:
    aspect = scene.render.resolution_x / scene.render.resolution_y
    tangent = math.tan(camera.data.angle_y * 0.5)
    direction = camera.matrix_world.to_3x3() @ Vector(((2 * u - 1) * tangent * aspect, (1 - 2 * v) * tangent, -1)).normalized()
    hit, position, face_normal, polygon_index, obj, _ = scene.ray_cast(
        bpy.context.evaluated_depsgraph_get(), camera.location, direction
    )
    if not hit:
        return {"pixel": [u, v], "object": None}
    material = None
    if obj.type == "MESH" and obj.data.materials:
        material = obj.data.materials[obj.data.polygons[polygon_index].material_index]
    mesh = obj.data
    polygon = mesh.polygons[polygon_index]
    loops = loop_normals(mesh, polygon, obj)
    mean_normal = Vector((0.0, 0.0, 0.0))
    for normal in loops:
        mean_normal += normal
    mean_normal.normalize()
    to_camera = (camera.location - position).normalized()
    camera_side = "front" if face_normal.dot(to_camera) >= 0.0 else "back"
    material_data = material_report(material) if material else None

    nearest = nearest_loop(mesh, polygon, position, obj)
    texture_samples = {}
    if material_data:
        for key in ("normalMap", "baseColorImages", "roughnessImages"):
            images = material_data[key]["images"] if key == "normalMap" else material_data[key]
            for image_row in images:
                image = bpy.data.images.get(image_row["image"])
                if not image:
                    continue
                uv = uv_at_loop(mesh, nearest, image_row["uvMap"])
                row = texture_samples.setdefault(image_row["image"], {
                    "uv": uv,
                    "uvMap": image_row["uvMap"],
                    "colorSpace": image_row["colorSpace"],
                })
                if uv is not None:
                    row["rgbAtNearestLoop"] = sample_uv(image, (uv[0], uv[1]))

    normals = {
        "face": face_normal.normalized(),
        "loopMean": mean_normal,
        "loopFlipped": -mean_normal,
        "faceFlipped": -face_normal.normalized(),
    }
    lights = light_terms(scene, position, normals)
    expected = {key: sum_expected(lights, key) for key in normals}
    point_lights = [row for row in lights if row["type"] != "SUN"]
    expected_point_only = {key: sum_expected(point_lights, key) for key in normals}
    return {
        "pixel": [u, v],
        "object": obj.name,
        "role": obj.get("bakeRole"),
        "mesh": mesh.name,
        "polygonIndex": polygon_index,
        "material": material.name if material else None,
        "positionWorld": list(position),
        "faceNormalWorld": list(face_normal),
        "cameraSideOfFace": camera_side,
        "cameraToSurface": list(direction),
        "surfaceToCamera": list(to_camera),
        "loopNormalWorld": {
            "list": [list(normal) for normal in loops],
            "dotFace": [normal.dot(face_normal) for normal in loops],
            "dotCamera": [normal.dot(to_camera) for normal in loops],
            "mean": list(mean_normal),
            "minDotFace": min(normal.dot(face_normal) for normal in loops),
            "maxDotFace": max(normal.dot(face_normal) for normal in loops),
        },
        "materialDetail": material_data,
        "textureSamples": texture_samples,
        "lights": lights,
        "expectedDiffuse": expected,
        "expectedDiffusePointOnly": expected_point_only,
        "nearestCeilingLight": min(
            (row for row in lights if row["type"] == "POINT"),
            key=lambda row: row["distanceMeters"],
            default=None,
        ),
        "source": source_material_for(source, obj.name),
    }


def add_pass_values(output_dir: Path, view_id: str, samples: list[dict[str, Any]]) -> None:
    decomposition_path = output_dir / "diagnostics" / "remaining-visual-review" / "lighting" / "decomposition-report.json"
    if not decomposition_path.is_file():
        return
    decomposition = json.loads(decomposition_path.read_text(encoding="utf-8"))
    pass_samples = decomposition.get("views", {}).get(view_id, {}).get("samples", [])
    pass_dir = decomposition_path.parent / "passes" / view_id
    diff_col_path = pass_dir / f"{view_id}-DiffCol0000.exr"
    diff_col = None
    if diff_col_path.is_file():
        diff_col = bpy.data.images.load(str(diff_col_path), check_existing=False)
        diff_col.colorspace_settings.name = "Non-Color"
    for sample in samples:
        u, v = sample["pixel"]
        match = next((row for row in pass_samples if abs(row["pixel"][0] - u) < 1e-6 and abs(row["pixel"][1] - v) < 1e-6), None)
        if match:
            sample["cyclesPass"] = {
                "directDiffuseRgb": match.get("directDiffuseRgb"),
                "directGlossyRgb": match.get("directGlossyRgb"),
                "indirectDiffuseRgb": match.get("indirectDiffuseRgb"),
                "indirectGlossyRgb": match.get("indirectGlossyRgb"),
                "existingFullResolutionCombinedRgb": match.get("existingFullResolutionCombinedRgb"),
            }
            sample["visibilityRatioVsLoopFlipped"] = ratio(match.get("directDiffuseRgb"), sample["expectedDiffuse"]["loopFlipped"])
            sample["visibilityRatioVsFaceFlipped"] = ratio(match.get("directDiffuseRgb"), sample["expectedDiffuse"]["faceFlipped"])
            sample["visibilityRatioVsLoopUnflipped"] = ratio(match.get("directDiffuseRgb"), sample["expectedDiffuse"]["loopMean"])
            sample["visibilityRatioVsPointOnlyLoopFlipped"] = ratio(
                match.get("directDiffuseRgb"), sample["expectedDiffusePointOnly"]["loopFlipped"]
            )
            sample["visibilityRatioVsPointOnlyFaceFlipped"] = ratio(
                match.get("directDiffuseRgb"), sample["expectedDiffusePointOnly"]["faceFlipped"]
            )
        if diff_col is not None:
            sample["diffuseColorRgb"] = sample_pixel(diff_col, u, v)
    if diff_col is not None:
        bpy.data.images.remove(diff_col)


def render_normal_views(scene: bpy.types.Scene, views: list[str], target_dir: Path) -> list[str]:
    output = target_dir / "normal"
    output.mkdir(parents=True, exist_ok=True)
    saved_override = bpy.context.view_layer.material_override
    saved_transparent = scene.render.film_transparent
    saved_samples = scene.cycles.samples
    saved_denoise = scene.cycles.use_denoising
    saved_percent = scene.render.resolution_percentage
    saved_view = (scene.view_settings.view_transform, scene.view_settings.look, scene.view_settings.exposure, scene.view_settings.gamma)
    saved_format = (scene.render.image_settings.file_format, scene.render.image_settings.color_mode, scene.render.image_settings.color_depth)
    materials = {}
    for key in ("Normal", "True Normal"):
        material = bpy.data.materials.new(f"DIAG_NORMAL_{key.replace(' ', '_')}")
        material.use_nodes = True
        nodes = material.node_tree.nodes
        links = material.node_tree.links
        nodes.clear()
        geometry = nodes.new("ShaderNodeNewGeometry")
        multiply = nodes.new("ShaderNodeVectorMath")
        multiply.operation = "MULTIPLY"
        multiply.inputs[1].default_value = (0.5, 0.5, 0.5)
        add = nodes.new("ShaderNodeVectorMath")
        add.operation = "ADD"
        add.inputs[1].default_value = (0.5, 0.5, 0.5)
        emission = nodes.new("ShaderNodeEmission")
        emission.inputs["Strength"].default_value = 1.0
        shader_output = nodes.new("ShaderNodeOutputMaterial")
        links.new(geometry.outputs[key], multiply.inputs[0])
        links.new(multiply.outputs["Vector"], add.inputs[0])
        links.new(add.outputs["Vector"], emission.inputs["Color"])
        links.new(emission.outputs["Emission"], shader_output.inputs["Surface"])
        materials[key] = material
    written = []
    try:
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        scene.render.resolution_percentage = 25
        scene.render.film_transparent = True
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0
        scene.view_settings.gamma = 1.0
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_mode = "RGBA"
        scene.render.image_settings.color_depth = "8"
        for view_id in views:
            scene.camera = bpy.data.objects[f"CAM_{view_id}"]
            bpy.context.view_layer.update()
            for key, material in materials.items():
                bpy.context.view_layer.material_override = material
                stem = "shading" if key == "Normal" else "true"
                path = output / f"{view_id}-{stem}.png"
                scene.render.filepath = str(path)
                bpy.ops.render.render(write_still=True)
                written.append(str(path.relative_to(target_dir)))
                print(f"CEILING_BOUNDARY_NORMAL {view_id} {stem}", flush=True)
    finally:
        bpy.context.view_layer.material_override = saved_override
        scene.render.film_transparent = saved_transparent
        scene.cycles.samples = saved_samples
        scene.cycles.use_denoising = saved_denoise
        scene.render.resolution_percentage = saved_percent
        scene.view_settings.view_transform, scene.view_settings.look, scene.view_settings.exposure, scene.view_settings.gamma = saved_view
        scene.render.image_settings.file_format, scene.render.image_settings.color_mode, scene.render.image_settings.color_depth = saved_format
        for material in materials.values():
            bpy.data.materials.remove(material)
    return written


def render_shadow_tests(scene: bpy.types.Scene, config: dict[str, Any], views: list[str], target_dir: Path) -> list[str]:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import save_scene_linear_preview

    output = target_dir / "shadow-tests"
    output.mkdir(parents=True, exist_ok=True)
    lights = [obj for obj in bpy.data.collections["04_A0_LIGHTS"].objects if obj.type == "LIGHT"]
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    saved_light_shadow = {obj: obj.data.use_shadow for obj in lights}
    saved_object_shadow = {obj: obj.visible_shadow for obj in meshes}
    saved_percent = scene.render.resolution_percentage
    saved_samples = scene.cycles.samples
    saved_denoise = scene.cycles.use_denoising
    written = []
    try:
        scene.render.resolution_percentage = 25
        scene.cycles.samples = 32
        scene.cycles.use_denoising = False
        variants = ("baseline", "ceiling-lights-no-shadow", "ceiling-objects-no-shadow", "all-no-shadow")
        for view_id in views:
            scene.camera = bpy.data.objects[f"CAM_{view_id}"]
            bpy.context.view_layer.update()
            for variant in variants:
                for obj in lights:
                    obj.data.use_shadow = saved_light_shadow[obj]
                for obj in meshes:
                    obj.visible_shadow = saved_object_shadow[obj]
                if variant == "ceiling-lights-no-shadow":
                    for obj in lights:
                        if obj.name.startswith("A0_CEILING"):
                            obj.data.use_shadow = False
                elif variant == "ceiling-objects-no-shadow":
                    for obj in meshes:
                        if obj.name.startswith("Ceiling"):
                            obj.visible_shadow = False
                elif variant == "all-no-shadow":
                    for obj in lights:
                        obj.data.use_shadow = False
                stem = f"{view_id}-{variant}"
                linear_path = output / "scene-linear" / f"{stem}.exr"
                png_path = output / f"{stem}.png"
                save_scene_linear_preview(scene, linear_path, png_path, config)
                written.append(str(png_path.relative_to(target_dir)))
                print(f"CEILING_BOUNDARY_SHADOW {stem}", flush=True)
    finally:
        for obj, value in saved_light_shadow.items():
            obj.data.use_shadow = value
        for obj, value in saved_object_shadow.items():
            obj.visible_shadow = value
        scene.render.resolution_percentage = saved_percent
        scene.cycles.samples = saved_samples
        scene.cycles.use_denoising = saved_denoise
    return written


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--label", default="ceiling-boundary")
    parser.add_argument("--views", nargs="*", default=["01-entry", "04-right"])
    parser.add_argument("--render-normal", action="store_true")
    parser.add_argument("--render-shadow-tests", action="store_true")
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    target_dir = output_dir / "diagnostics" / args.label
    target_dir.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise ValueError("Scene does not match the locked source hash")
    source_data, source = read_glb((root / config["sourceModel"]).resolve())
    if hashlib.sha256(source_data).hexdigest() != config["expectedSha256"]:
        raise ValueError("Original GLB hash changed")
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = 100
    report = {
        "stage": "B1 ceiling/direct-light/normal boundary; read-only diagnostic",
        "sourceSha256": config["expectedSha256"],
        "bakedGlbSha256": hashlib.sha256((output_dir / "example_room_2.baked.glb").read_bytes()).hexdigest(),
        "scope": "Ray samples and normal/light geometry only. No scene save, no lightmap bake, no source GLB or phone asset change.",
        "views": {},
    }
    for view_id in args.views:
        camera = bpy.data.objects[f"CAM_{view_id}"]
        scene.camera = camera
        bpy.context.view_layer.update()
        samples = [analyze_sample(scene, camera, u, v, source) for u, v in POINTS[view_id]]
        add_pass_values(output_dir, view_id, samples)
        report["views"][view_id] = {"samples": samples}
    report["renderNormal"] = render_normal_views(scene, args.views, target_dir) if args.render_normal else []
    report["renderShadowTests"] = render_shadow_tests(scene, config, args.views, target_dir) if args.render_shadow_tests else []
    path = target_dir / "scene-report.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CEILING_BOUNDARY_COMPLETE {path}", flush=True)


if __name__ == "__main__":
    main()
