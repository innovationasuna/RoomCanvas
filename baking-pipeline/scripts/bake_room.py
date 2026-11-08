import argparse
import json
import math
import sys
import time
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--render-only", action="store_true")
    parser.add_argument("--export-only", action="store_true")
    return parser.parse_args(argv)


def collection_objects(name):
    return [obj for obj in bpy.data.collections[name].objects if obj.type == "MESH"]


def configure_cycles(config):
    scene = bpy.context.scene
    settings = config["bake"]
    scene.render.engine = "CYCLES"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    device_report = {"requested": settings["device"], "backend": None, "devices": []}
    if settings["device"] == "GPU":
        for backend in ("OPTIX", "CUDA"):
            try:
                preferences.compute_device_type = backend
                preferences.get_devices()
                candidates = [device for device in preferences.devices if device.type == backend]
                if candidates:
                    for device in preferences.devices:
                        device.use = device in candidates
                    device_report = {
                        "requested": "GPU",
                        "backend": backend,
                        "devices": [device.name for device in candidates],
                    }
                    scene.cycles.device = "GPU"
                    break
            except (TypeError, RuntimeError):
                continue
    if not device_report["backend"]:
        scene.cycles.device = "CPU"
        device_report["fallback"] = "No compatible GPU was available; CPU was used."
    scene.cycles.samples = settings["samples"]
    scene.cycles.preview_samples = settings["previewSamples"]
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = settings["adaptiveThreshold"]
    scene.cycles.use_denoising = settings["useDenoising"]
    scene.cycles.max_bounces = settings["maxBounces"]
    scene.cycles.diffuse_bounces = settings["diffuseBounces"]
    scene.cycles.glossy_bounces = settings["glossyBounces"]
    scene.cycles.transmission_bounces = settings["transmissionBounces"]
    scene.cycles.transparent_max_bounces = settings["transparentMaxBounces"]
    scene.render.threads_mode = "AUTO"
    return device_report


def material_targets(static_objects):
    materials = set()
    for obj in static_objects:
        for slot in obj.material_slots:
            if slot.material is None:
                slot.material = bpy.data.materials.new(f"{obj.name}_B1_material")
                slot.material.use_nodes = True
            materials.add(slot.material)
    targets = []
    for material in materials:
        material.use_nodes = True
        tree = material.node_tree
        for node in tree.nodes:
            node.select = False
        target = tree.nodes.get("B1_LIGHTMAP_TARGET") or tree.nodes.new("ShaderNodeTexImage")
        target.name = "B1_LIGHTMAP_TARGET"
        target.label = "B1 bake destination only; not connected to runtime PBR"
        target.interpolation = "Linear"
        target.extension = "EXTEND"
        uv = tree.nodes.get("B1_LIGHTMAP_UV") or tree.nodes.new("ShaderNodeUVMap")
        uv.name = "B1_LIGHTMAP_UV"
        uv.uv_map = "UV2_Lightmap"
        tree.links.new(uv.outputs["UV"], target.inputs["Vector"])
        tree.nodes.active = target
        target.select = True
        targets.append(target)
    return targets


def inverted_closed_mesh(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    positions = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", positions)
    positions = positions.reshape(-1, 3)
    indices = np.array([triangle.vertices[:] for triangle in mesh.loop_triangles], dtype=np.int32)
    if not len(indices):
        return False
    triangles = positions[indices]
    volume = float(np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6.0)
    if volume * obj.matrix_world.determinant() >= -1e-12:
        return False
    welded = [tuple(np.round(position, decimals=6)) for position in positions]
    edge_counts = {}
    for polygon in mesh.polygons:
        for edge in polygon.edge_keys:
            key = tuple(sorted(welded[index] for index in edge))
            edge_counts[key] = edge_counts.get(key, 0) + 1
    return all(count == 2 for count in edge_counts.values())


def create_bake_proxy(static_objects):
    collection = bpy.data.collections.new("TEMP_BAKE_ONLY_NOT_FOR_EXPORT")
    bpy.context.scene.collection.children.link(collection)
    copies = []
    visibility = {obj: obj.hide_render for obj in static_objects}
    corrections = []
    for index, obj in enumerate(static_objects):
        copy = obj.copy()
        copy.data = obj.data.copy()
        copy.name = f"TEMP_STATIC_COPY_{index:04d}"
        copy.animation_data_clear()
        copy.parent = None
        copy.matrix_world = obj.matrix_world
        copy.hide_render = False
        if inverted_closed_mesh(copy):
            uv_layer = copy.data.uv_layers["UV2_Lightmap"]

            def vertex_uv():
                return {
                    (polygon.index, copy.data.loops[loop_index].vertex_index): tuple(uv_layer.data[loop_index].uv)
                    for polygon in copy.data.polygons
                    for loop_index in polygon.loop_indices
                }

            uv_before = vertex_uv()
            copy.data.flip_normals()
            if uv_before != vertex_uv():
                raise ValueError(f"Normal-only proxy correction changed per-vertex UV2 on {obj.name}")
            corrections.append(obj.name)
        collection.objects.link(copy)
        copies.append(copy)
    for obj in static_objects:
        obj.hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    for copy in copies:
        copy.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    proxy = bpy.context.view_layer.objects.active
    proxy.name = "TEMP_STATIC_ATLAS_BAKE_ONLY"
    proxy.data.name = "TEMP_STATIC_ATLAS_BAKE_MESH"
    return proxy, collection, visibility, {
        "scope": "Temporary bake proxy only; source meshes, exported normals and UV2 are unchanged",
        "closedPositionToleranceMeters": 1e-6,
        "flippedObjectCount": len(corrections),
        "flippedObjects": corrections,
        "uv2PreservedExactlyOnFlippedCopies": True,
    }


def remove_bake_proxy(proxy, collection, visibility):
    mesh = proxy.data
    bpy.data.objects.remove(proxy, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)
    bpy.data.collections.remove(collection)
    for obj, hidden in visibility.items():
        obj.hide_render = hidden


def new_atlas(name, size):
    image = bpy.data.images.get(name)
    if image:
        bpy.data.images.remove(image)
    image = bpy.data.images.new(name, width=size, height=size, alpha=True, float_buffer=True)
    image.generated_color = (0.0, 0.0, 0.0, 1.0)
    image.colorspace_settings.name = "Non-Color"
    return image


def image_statistics(image):
    pixels = np.asarray(image.pixels[:], dtype=np.float32).reshape(image.size[1], image.size[0], 4)
    rgb = pixels[:, :, :3]
    finite = np.isfinite(rgb).all(axis=2)
    nonzero = np.any(np.abs(rgb) > 1e-8, axis=2) & finite
    values = rgb[nonzero]
    return {
        "width": int(image.size[0]),
        "height": int(image.size[1]),
        "allPixelsFinite": bool(finite.all()),
        "nonzeroFraction": float(nonzero.mean()),
        "nonzeroMin": values.min(axis=0).tolist() if values.size else None,
        "nonzeroMax": values.max(axis=0).tolist() if values.size else None,
        "nonzeroMean": values.mean(axis=0).tolist() if values.size else None,
    }


def bake_pass(name, bake_type, pass_filter, static_objects, targets, config, output_dir):
    scene = bpy.context.scene
    settings = config["bake"]
    image = new_atlas(name, settings["atlasSize"])
    for target in targets:
        target.image = image
    bpy.ops.object.select_all(action="DESELECT")
    for obj in static_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = static_objects[0]
    arguments = {
        "type": bake_type,
        "use_selected_to_active": False,
        "use_clear": False,
        "use_cage": False,
        "margin": settings["marginPixels"],
        "margin_type": settings["marginType"],
        "uv_layer": config["uv"]["layerName"],
        "target": "IMAGE_TEXTURES",
        "save_mode": "INTERNAL",
    }
    if pass_filter is not None:
        arguments["pass_filter"] = set(pass_filter)
    started = time.monotonic()
    print(f"BAKE_BEGIN {name} objects={len(static_objects)} materials={len(targets)}", flush=True)
    bpy.ops.object.bake(**arguments)
    elapsed = time.monotonic() - started
    stats = image_statistics(image)
    if not stats["allPixelsFinite"] or stats["nonzeroFraction"] < 0.001:
        raise ValueError(f"Bake {name} is empty or invalid: {stats}")
    lightmap_dir = output_dir / "lightmaps"
    preview_dir = output_dir / "previews" / "lightmaps"
    lightmap_dir.mkdir(parents=True, exist_ok=True)
    preview_dir.mkdir(parents=True, exist_ok=True)
    stem = {"B1_DIRECT_DIFFUSE": "direct-diffuse", "B1_INDIRECT": "indirect", "B1_AO": "ao"}[name]
    if name == "B1_AO":
        master_path = lightmap_dir / f"{stem}.png"
        image.file_format = "PNG"
        image.filepath_raw = str(master_path)
        image.save()
    else:
        master_path = lightmap_dir / f"{stem}.exr"
        image.file_format = "OPEN_EXR"
        image.filepath_raw = str(master_path)
        image.save()
        scene.render.image_settings.file_format = "PNG"
        scene.render.image_settings.color_depth = "8"
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0
        image.save_render(str(preview_dir / f"{stem}-display.png"), scene=scene)
    print(f"BAKE_END {name} seconds={elapsed:.2f} stats={stats}", flush=True)
    return {
        "name": name,
        "master": str(master_path.relative_to(output_dir)),
        "elapsedSeconds": elapsed,
        "statistics": stats,
        "bakeType": bake_type,
        "passFilter": pass_filter or [],
        "colorSpace": "Non-Color scene-linear; no ACES/FXAA/specular/reflection pass",
    }


def make_diagnostic_materials(static_objects, images):
    mapping = {}
    for obj in static_objects:
        for slot in obj.material_slots:
            original = slot.material
            if original in mapping:
                slot.material = mapping[original]
                continue
            material = original.copy()
            material.name = f"DIAGNOSTIC_ONLY_{original.name}"
            mapping[original] = material
            tree = material.node_tree
            principled = next((node for node in tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
            if principled is None:
                raise ValueError(f"No Principled BSDF in {original.name}")
            base_input = principled.inputs["Base Color"]
            base_source = base_input.links[0].from_socket if base_input.is_linked else None
            base_value = tuple(base_input.default_value)
            uv = tree.nodes.new("ShaderNodeUVMap")
            uv.uv_map = "UV2_Lightmap"

            def texture(image):
                node = tree.nodes.new("ShaderNodeTexImage")
                node.image = image
                node.extension = "EXTEND"
                tree.links.new(uv.outputs["UV"], node.inputs["Vector"])
                return node.outputs["Color"]

            add = tree.nodes.new("ShaderNodeMixRGB")
            add.blend_type = "ADD"
            add.inputs[0].default_value = 1.0
            tree.links.new(texture(images["B1_DIRECT_DIFFUSE"]), add.inputs[1])
            tree.links.new(texture(images["B1_INDIRECT"]), add.inputs[2])
            ao = tree.nodes.new("ShaderNodeMixRGB")
            ao.blend_type = "MULTIPLY"
            ao.inputs[0].default_value = 1.0
            tree.links.new(add.outputs[0], ao.inputs[1])
            tree.links.new(texture(images["B1_AO"]), ao.inputs[2])
            base = tree.nodes.new("ShaderNodeMixRGB")
            base.blend_type = "MULTIPLY"
            base.inputs[0].default_value = 1.0
            if base_source:
                tree.links.new(base_source, base.inputs[1])
            else:
                base.inputs[1].default_value = base_value
            tree.links.new(ao.outputs[0], base.inputs[2])
            emission = tree.nodes.new("ShaderNodeEmission")
            emission.inputs["Strength"].default_value = 1.0
            tree.links.new(base.outputs[0], emission.inputs["Color"])
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


def render_previews(config, output_dir, static_objects, excluded_objects):
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from filament_display import display_metadata, save_scene_linear_preview

    scene = bpy.context.scene
    preview_dir = output_dir / "previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    scene.render.resolution_x = config["camera"]["resolution"][0]
    scene.render.resolution_y = config["camera"]["resolution"][1]
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    preparation = json.loads((output_dir / "preparation-report.json").read_text(encoding="utf-8"))
    start_yaw = preparation["cameras"][0]["yawDegrees"] - config["camera"]["views"][0]["yawOffsetDegrees"]
    for view in config["camera"]["views"]:
        yaw = math.radians(start_yaw + view.get("offlineYawOffsetDegrees", view["yawOffsetDegrees"]))
        pitch = math.radians(view["pitchDegrees"])
        direction = Vector((-math.sin(yaw) * math.cos(pitch), math.cos(yaw) * math.cos(pitch), math.sin(pitch)))
        camera = bpy.data.objects[f"CAM_{view['id']}"]
        camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    paths = {
        "B1_DIRECT_DIFFUSE": "lightmaps/direct-diffuse.exr",
        "B1_INDIRECT": "lightmaps/indirect.exr",
        "B1_AO": "lightmaps/ao.png",
    }
    images = {}
    for name, relative in paths.items():
        image = bpy.data.images.load(str(output_dir / relative), check_existing=False)
        image.colorspace_settings.name = "Non-Color"
        images[name] = image
    original_visibility = {obj: obj.hide_render for obj in excluded_objects}
    for obj in excluded_objects:
        obj.hide_render = True
    scene.cycles.samples = 4
    for view in config["camera"]["views"]:
        scene.camera = bpy.data.objects[f"CAM_{view['id']}"]
        mapping = make_diagnostic_materials(static_objects, images)
        save_scene_linear_preview(
            scene,
            preview_dir / "scene-linear" / f"{view['id']}-baked-static-diagnostic.exr",
            preview_dir / f"{view['id']}-baked-static-diagnostic.png",
            config,
        )
        restore_materials(mapping)
    for obj, hidden in original_visibility.items():
        obj.hide_render = hidden
    scene.cycles.samples = config["bake"]["previewSamples"]
    for view in config["camera"]["views"]:
        scene.camera = bpy.data.objects[f"CAM_{view['id']}"]
        save_scene_linear_preview(
            scene,
            preview_dir / "scene-linear" / f"{view['id']}-offline-full-pbr.exr",
            preview_dir / f"{view['id']}-offline-full-pbr.png",
            config,
        )
    paths = [
        f"previews/{view['id']}-baked-static-diagnostic.png" for view in config["camera"]["views"]
    ] + [
        f"previews/{view['id']}-offline-full-pbr.png" for view in config["camera"]["views"]
    ]
    return paths, display_metadata(config)


def export_baked(config, output_dir):
    scene = bpy.context.scene
    for obj in collection_objects("01_STATIC_BAKE"):
        obj["lightmapUvIndex"] = list(obj.data.uv_layers).index(obj.data.uv_layers[obj["lightmapUvLayer"]])
        obj["lightmapDirect"] = "lightmaps/direct-diffuse.exr"
        obj["lightmapIndirect"] = "lightmaps/indirect.exr"
        obj["lightmapAo"] = "lightmaps/ao.png"
        obj["lightmapColorSpace"] = "scene-linear"
        obj["lightmapToneMapping"] = "none"
    scene["bakeStage"] = "B1 offline prototype generated; B2/B3/B4 not entered"
    bpy.ops.wm.save_as_mainfile(filepath=str(output_dir / f"{config['roomId']}.baked.blend"), compress=True)
    path = output_dir / f"{config['roomId']}.baked.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(path),
        export_format="GLB",
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_extras=True,
        export_yup=True,
        export_apply=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_cameras=False,
        export_lights=False,
        export_current_frame=False,
    )
    return str(path.relative_to(output_dir))


def main():
    args = parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    scene = bpy.context.scene
    if scene.get("sourceSha256") != config["expectedSha256"]:
        raise ValueError("Prepared scene source hash does not match configuration")
    static_objects = collection_objects("01_STATIC_BAKE")
    excluded_objects = collection_objects("02_DYNAMIC_REALTIME") + collection_objects("03_SPECIAL_REALTIME")
    if args.export_only:
        path = export_baked(config, output_dir)
        print(f"EXPORT_ONLY_COMPLETE {path}", flush=True)
        return
    device = configure_cycles(config)
    reports = []
    if args.render_only:
        previous_path = output_dir / "bake-report.json"
        if not previous_path.is_file():
            raise ValueError("Render-only mode requires an existing bake report")
        reports = json.loads(previous_path.read_text(encoding="utf-8")).get("passes", [])
        if len(reports) != 3:
            raise ValueError("Render-only mode requires three completed bake passes")
    original_visibility = {obj: obj.hide_render for obj in excluded_objects}
    normal_corrections = {"flippedObjectCount": 0, "flippedObjects": [], "scope": "No proxy created in render-only mode"}
    if args.render_only:
        normal_corrections = json.loads(previous_path.read_text(encoding="utf-8")).get("normalCorrections", normal_corrections)
    if not args.render_only:
        proxy = None
        try:
            for obj in excluded_objects:
                obj.hide_render = True
            targets = material_targets(static_objects)
            proxy, proxy_collection, static_visibility, normal_corrections = create_bake_proxy(static_objects)
            reports.append(bake_pass("B1_DIRECT_DIFFUSE", "DIFFUSE", config["bake"]["directPassFilter"], [proxy], targets, config, output_dir))
            reports.append(bake_pass("B1_INDIRECT", "DIFFUSE", config["bake"]["indirectPassFilter"], [proxy], targets, config, output_dir))
            reports.append(bake_pass("B1_AO", "AO", None, [proxy], targets, config, output_dir))
        finally:
            if proxy is not None:
                remove_bake_proxy(proxy, proxy_collection, static_visibility)
            for obj, hidden in original_visibility.items():
                obj.hide_render = hidden
    previews, preview_display = render_previews(config, output_dir, static_objects, excluded_objects)
    baked_glb = export_baked(config, output_dir)
    report = {
        "stage": "B1 offline prototype",
        "blenderVersion": bpy.app.version_string,
        "device": device,
        "sourceSha256": scene["sourceSha256"],
        "staticObjectCount": len(static_objects),
        "excludedDuringEveryStaticBake": [obj.name for obj in excluded_objects],
        "normalCorrections": normal_corrections,
        "previewDisplay": preview_display,
        "passes": reports,
        "previews": previews,
        "bakedGlb": baked_glb,
        "runtimeIntegration": False,
        "visualAcceptance": "Pending human comparison; no claim of A0 equivalence or performance benefit.",
    }
    (output_dir / "bake-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("B1_COMPLETE", flush=True)


if __name__ == "__main__":
    main()
