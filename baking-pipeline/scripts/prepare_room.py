import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--lighting-only", action="store_true")
    return parser.parse_args(argv)


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return minimum, maximum


def union_bounds(items):
    minimum, maximum = bounds([items[0][1]])
    for _, obj in items[1:]:
        low, high = bounds([obj])
        minimum = Vector(tuple(min(minimum[i], low[i]) for i in range(3)))
        maximum = Vector(tuple(max(maximum[i], high[i]) for i in range(3)))
    return minimum, maximum


def gltf_vector(vector):
    return (vector[0], vector[2], -vector[1])


def illuminant_d(temperature):
    value = 1000.0 / temperature
    if temperature <= 7000:
        x = -4.607 * value ** 3 + 2.9678 * value ** 2 + 0.09911 * value + 0.244063
    else:
        x = -2.0064 * value ** 3 + 1.9018 * value ** 2 + 0.24748 * value + 0.23704
    y = -3.0 * x * x + 2.87 * x - 0.275
    xyz = (x / y, 1.0, (1.0 - x - y) / y)
    matrix = (
        (3.2404542, -1.5371385, -0.4985314),
        (-0.9692660, 1.8760108, 0.0415560),
        (0.0556434, -0.2040259, 1.0572252),
    )
    return tuple(max(0.0, sum(row[i] * xyz[i] for i in range(3))) for row in matrix)


def move_to_collection(obj, collection):
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    collection.objects.link(obj)


def create_collection(name, color):
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    collection.color_tag = color
    return collection


def create_light(collection, name, light_type, position, color, energy):
    data = bpy.data.lights.new(name=name, type=light_type)
    data.color = color
    data.energy = energy
    data.use_shadow = True
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    obj.location = position
    return obj


def configure_lights(config, source_rows, collections):
    settings = config["lighting"]
    for existing in list(collections["lights"].objects):
        bpy.data.objects.remove(existing, do_unlink=True)
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    by_name = {obj.name: obj for obj in mesh_objects}
    named = [(row["nodeIndex"], row["nodeName"], by_name[row["nodeName"]]) for row in source_rows]
    shell = [(name, obj) for _, name, obj in named if name.lower().startswith(("wall", "floor", "ceiling"))]
    room_min, room_max = union_bounds(shell) if shell else bounds(mesh_objects)
    room_center = (room_min + room_max) * 0.5
    diagonal = (room_max - room_min).length
    falloff = max(diagonal * settings["falloffDiagonalMultiplier"], 1.0)
    specs = []
    for _, name, obj in named:
        if not name.lower().startswith("ceiling"):
            continue
        low, high = bounds([obj])
        center = (low + high) * 0.5
        specs.append({
            "kind": "CEILING",
            "sourceName": name,
            "position": (center.x, center.y, low.z - settings["ceilingDropMeters"]),
        })
    window_group = re.compile(r"^window(?:[_-]?\d+)?", re.IGNORECASE)
    window_parts = [
        (name, obj) for _, name, obj in named
        if name.lower().startswith("window") and not re.search(r"drape|sheer|curtain|blind", name, re.IGNORECASE)
    ]
    groups = {}
    for name, obj in window_parts:
        match = window_group.search(name)
        groups.setdefault(match.group(0).lower() if match else name.lower(), []).append((name, obj))
    for group_name, items in groups.items():
        low, high = union_bounds(items)
        center = (low + high) * 0.5
        inward_x = room_center.x - center.x
        inward_y = room_center.y - center.y
        length = math.hypot(inward_x, inward_y)
        if length < 1e-6:
            inward_x, inward_y, length = 0.0, -1.0, 1.0
        inward_x /= length
        inward_y /= length
        direction = Vector((inward_x, inward_y, -settings["windowDownwardSlope"])).normalized()
        specs.append({
            "kind": "WINDOW",
            "sourceName": group_name,
            "position": (
                center.x + inward_x * settings["windowInsetMeters"],
                center.y + inward_y * settings["windowInsetMeters"],
                center.z,
            ),
            "direction": tuple(direction),
        })
    specs = specs[:settings["maxLocalLights"]]

    elevation = math.radians(settings["sunElevationDegrees"])
    rotation = math.radians(settings["sunRotationDegrees"])
    direction_gltf = (
        -math.cos(elevation) * math.sin(rotation),
        -math.sin(elevation),
        -math.cos(elevation) * math.cos(rotation),
    )
    direction = Vector((direction_gltf[0], -direction_gltf[2], direction_gltf[1]))
    sun = create_light(
        collections["lights"], "A0_SUN_2500_LUX", "SUN", (0, 0, 0),
        illuminant_d(settings["sunTemperatureKelvin"]),
        settings["sunIntensityLux"] * settings["filamentPhotometricUnitToCycles"],
    )
    sun.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    sun.data.angle = math.radians(settings["sunAngularRadiusDegrees"] * 2.0)
    light_report = [{
        "name": sun.name,
        "type": "SUN",
        "intensityLux": settings["sunIntensityLux"],
        "cyclesIrradiance": sun.data.energy,
        "directionGltf": direction_gltf,
        "temperatureKelvin": settings["sunTemperatureKelvin"],
        "angularRadiusDegrees": settings["sunAngularRadiusDegrees"],
    }]
    for index, spec in enumerate(specs):
        ceiling = spec["kind"] == "CEILING"
        temperature = settings["ceilingTemperatureKelvin"] if ceiling else settings["windowTemperatureKelvin"]
        watts = settings["ceilingWatts"] if ceiling else settings["windowWatts"]
        radius = settings["ceilingBulbRadiusMeters"] if ceiling else settings["windowBulbRadiusMeters"]
        luminous_power = watts * settings["filamentLedEfficiency"] * settings["photopicLumensPerWatt"]
        cycles_power = luminous_power * settings["filamentPhotometricUnitToCycles"]
        light = create_light(
            collections["lights"], f"A0_{spec['kind']}_{index:02d}",
            "POINT" if ceiling else "SPOT", spec["position"], illuminant_d(temperature), cycles_power,
        )
        light.data.shadow_soft_size = radius
        light["filamentFalloffMeters"] = falloff
        if not ceiling:
            light.data.spot_size = math.radians(settings["windowOuterDegrees"])
            light.data.spot_blend = 1.0 - settings["windowInnerDegrees"] / settings["windowOuterDegrees"]
            light.rotation_euler = Vector(spec["direction"]).to_track_quat("-Z", "Y").to_euler()
        light_report.append({
            "name": light.name,
            "type": light.data.type,
            "sourceName": spec["sourceName"],
            "positionBlender": list(light.location),
            "positionGltf": gltf_vector(light.location),
            "directionBlender": spec.get("direction"),
            "watts": watts,
            "filamentLedEfficiency": settings["filamentLedEfficiency"],
            "filamentLuminousPowerLumens": luminous_power,
            "cyclesPowerFilamentPhotometricEquivalent": cycles_power,
            "filamentPhotometricUnitToCycles": settings["filamentPhotometricUnitToCycles"],
            "temperatureKelvin": temperature,
            "filamentFalloffMeters": falloff,
            "bulbRadiusMeters": radius,
            "note": "Filament converts electrical watts to lumens once as efficiency * 683 * watts. Its SUN and POINT paths retain lux/lumens without an additional 1/683 divisor; Cycles uses the equivalent scene-linear photometric values here. Falloff is metadata, not a different light shape.",
        })
    return {
        "roomMinBlender": list(room_min),
        "roomMaxBlender": list(room_max),
        "falloffMeters": falloff,
        "lights": light_report,
        "ceilingCount": sum(spec["kind"] == "CEILING" for spec in specs),
        "windowCount": sum(spec["kind"] == "WINDOW" for spec in specs),
    }


def configure_world(config, root, ao_distance):
    hdr = (root / config["environment"]["hdr"]).resolve()
    digest = hashlib.sha256(hdr.read_bytes()).hexdigest()
    if digest != config["environment"]["expectedSha256"]:
        raise ValueError(f"HDR SHA-256 mismatch: {digest}")
    world = bpy.data.worlds.new("A0_IBL_studio_small_09_2k")
    world.use_nodes = True
    nodes = world.node_tree.nodes
    nodes.clear()
    environment = nodes.new("ShaderNodeTexEnvironment")
    environment.image = bpy.data.images.load(str(hdr), check_existing=True)
    background = nodes.new("ShaderNodeBackground")
    background.inputs["Strength"].default_value = config["environment"]["intensity"]
    output = nodes.new("ShaderNodeOutputWorld")
    world.node_tree.links.new(environment.outputs["Color"], background.inputs["Color"])
    world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])
    world.light_settings.distance = ao_distance
    bpy.context.scene.world = world
    return {"path": str(hdr), "sha256": digest, "strength": config["environment"]["intensity"], "rotation": "default/unverified"}


def configure_cameras(config, mesh_objects, collection):
    minimum, maximum = bounds(mesh_objects)
    center = (minimum + maximum) * 0.5
    size = maximum - minimum
    start_yaw = 90.0 if size.x >= size.y else 0.0
    position = Vector((center.x, center.y, minimum.z + config["camera"]["eyeHeightMeters"]))
    views = []
    for view in config["camera"]["views"]:
        yaw = start_yaw + view.get("offlineYawOffsetDegrees", view["yawOffsetDegrees"])
        pitch = view["pitchDegrees"]
        yaw_radians = math.radians(yaw)
        pitch_radians = math.radians(pitch)
        direction = Vector((
            -math.sin(yaw_radians) * math.cos(pitch_radians),
            math.cos(yaw_radians) * math.cos(pitch_radians),
            math.sin(pitch_radians),
        ))
        data = bpy.data.cameras.new(view["id"])
        data.type = "PERSP"
        data.sensor_fit = "VERTICAL"
        data.angle_y = math.radians(config["camera"]["verticalFovDegrees"])
        data.clip_start = config["camera"]["nearMeters"]
        data.clip_end = config["camera"]["farMeters"]
        obj = bpy.data.objects.new(f"CAM_{view['id']}", data)
        collection.objects.link(obj)
        obj.location = position
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        views.append({
            **view,
            "objectName": obj.name,
            "positionBlender": list(position),
            "positionGltf": gltf_vector(position),
            "yawDegrees": yaw,
            "directionBlender": list(direction),
        })
    return views


def create_uv2(static_objects, config):
    from array import array

    settings = config["uv"]
    layer_name = settings["layerName"]
    object_attribute = "B1_SOURCE_OBJECT"
    loop_attribute = "B1_SOURCE_LOOP"
    collection = bpy.data.collections.new("TEMP_UV_ATLAS_ONLY")
    bpy.context.scene.collection.children.link(collection)
    copies = []
    for object_index, obj in enumerate(static_objects):
        mesh = obj.data
        if not mesh.uv_layers:
            mesh.uv_layers.new(name="UVMap")
        uv2 = mesh.uv_layers.get(layer_name) or mesh.uv_layers.new(name=layer_name)
        for index, layer in enumerate(mesh.uv_layers):
            layer.active_render = index == 0
        mesh.uv_layers.active_index = list(mesh.uv_layers).index(uv2)
        source_object = mesh.attributes.get(object_attribute) or mesh.attributes.new(object_attribute, "INT", "CORNER")
        source_loop = mesh.attributes.get(loop_attribute) or mesh.attributes.new(loop_attribute, "INT", "CORNER")
        source_object.data.foreach_set("value", [object_index] * len(mesh.loops))
        source_loop.data.foreach_set("value", list(range(len(mesh.loops))))
        copy = obj.copy()
        copy.data = mesh.copy()
        copy.name = f"TEMP_UV_COPY_{object_index:04d}"
        copy.animation_data_clear()
        copy.parent = None
        copy.matrix_world = obj.matrix_world
        collection.objects.link(copy)
        copies.append(copy)
    bpy.ops.object.select_all(action="DESELECT")
    for copy in copies:
        copy.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    proxy = bpy.context.view_layer.objects.active
    proxy.name = "TEMP_SHARED_UV_ATLAS"
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(settings["angleLimitDegrees"]),
        margin_method="FRACTION",
        island_margin=settings["islandMargin"],
        correct_aspect=True,
        scale_to_bounds=settings["scaleToBounds"],
    )
    bpy.ops.uv.pack_islands(
        rotate=settings["rotate"],
        margin_method="FRACTION",
        margin=settings["packMargin"],
    )
    bpy.ops.object.mode_set(mode="OBJECT")

    mesh = proxy.data
    object_ids = array("i", [0]) * len(mesh.loops)
    loop_ids = array("i", [0]) * len(mesh.loops)
    mesh.attributes[object_attribute].data.foreach_get("value", object_ids)
    mesh.attributes[loop_attribute].data.foreach_get("value", loop_ids)
    proxy_uv = mesh.uv_layers[layer_name].data
    transferred = [0] * len(static_objects)
    for proxy_loop, (object_id, source_loop) in enumerate(zip(object_ids, loop_ids)):
        uv = proxy_uv[proxy_loop].uv
        static_objects[object_id].data.uv_layers[layer_name].data[source_loop].uv = (uv.x, uv.y)
        transferred[object_id] += 1
    for object_index, obj in enumerate(static_objects):
        if transferred[object_index] != len(obj.data.loops):
            raise ValueError(f"UV loop transfer mismatch for {obj.name}: {transferred[object_index]} != {len(obj.data.loops)}")
    proxy_mesh = proxy.data
    bpy.data.objects.remove(proxy, do_unlink=True)
    if proxy_mesh.users == 0:
        bpy.data.meshes.remove(proxy_mesh)
    bpy.data.collections.remove(collection)

    minimum = float("inf")
    maximum = float("-inf")
    total_area = 0.0
    degenerate_triangles = 0
    for obj in static_objects:
        mesh = obj.data
        mesh.attributes.remove(mesh.attributes[object_attribute])
        mesh.attributes.remove(mesh.attributes[loop_attribute])
        uv = mesh.uv_layers[layer_name].data
        for loop in uv:
            minimum = min(minimum, loop.uv.x, loop.uv.y)
            maximum = max(maximum, loop.uv.x, loop.uv.y)
        mesh.calc_loop_triangles()
        for triangle in mesh.loop_triangles:
            a, b, c = (uv[index].uv for index in triangle.loops)
            area = abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5
            total_area += area
            if area < 1e-12:
                degenerate_triangles += 1
    if minimum < -0.001 or maximum > 1.001:
        raise ValueError(f"UV2 escaped the 0-1 atlas: min={minimum}, max={maximum}")
    if total_area > 1.00001:
        raise ValueError(f"UV2 triangle area exceeds one atlas: {total_area}")
    return {
        "layerName": layer_name,
        "staticObjectCount": len(static_objects),
        "coordinateMin": minimum,
        "coordinateMax": maximum,
        "sumTriangleAreaInUvSpace": total_area,
        "degenerateUvTriangles": degenerate_triangles,
        "sourceLoopMappingVerified": True,
        "packOperationCompleted": True,
        "atlasCount": 1,
    }


def main():
    args = parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    source = (root / config["sourceModel"]).resolve()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != config["expectedSha256"]:
        raise ValueError("Source hash mismatch")
    output_dir = root / "output" / config["roomId"]
    inspection = json.loads((output_dir / "b0" / "source-inspection.json").read_text(encoding="utf-8"))
    if inspection["source"]["sha256"] != source_hash:
        raise ValueError("Run inspect_source.py for this exact source first")
    rows = inspection["classification"]["rows"]
    names = [row["nodeName"] for row in rows]
    if len(names) != len(set(names)):
        raise ValueError("Mesh node names are not unique; refusing name-based dynamic/static assignment")
    if args.lighting_only:
        if bpy.context.scene.get("sourceSha256") != source_hash:
            raise ValueError("Lighting-only mode requires the matching prepared scene")
        report_path = output_dir / "preparation-report.json"
        report = json.loads(report_path.read_text(encoding="utf-8"))
        bpy.context.view_layer.update()
        lighting = configure_lights(config, rows, {"lights": bpy.data.collections["04_A0_LIGHTS"]})
        invariant_keys = ("name", "type", "sourceName", "positionBlender", "positionGltf", "directionBlender", "directionGltf", "temperatureKelvin", "filamentFalloffMeters", "bulbRadiusMeters", "angularRadiusDegrees")
        previous = [{key: row.get(key) for key in invariant_keys} for row in report["lighting"]["lights"]]
        current = [{key: row.get(key) for key in invariant_keys} for row in lighting["lights"]]
        if json.dumps(previous, sort_keys=True) != json.dumps(current, sort_keys=True):
            differences = [{"before": before, "after": after} for before, after in zip(previous, current) if json.dumps(before, sort_keys=True) != json.dumps(after, sort_keys=True)]
            raise ValueError(f"Lighting-only update changed light invariants: {differences}")
        report["lighting"] = lighting
        report["lightingOnlyUpdate"] = {
            "filamentLedEfficiency": config["lighting"]["filamentLedEfficiency"],
            "photopicLumensPerWatt": config["lighting"]["photopicLumensPerWatt"],
            "filamentPhotometricUnitToCycles": config["lighting"]["filamentPhotometricUnitToCycles"],
            "uvRegenerated": False,
            "cameraOrWorldChanged": False,
            "lightPlacementAndShapeInvariantsVerified": True,
        }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        bpy.ops.wm.save_as_mainfile(filepath=str(output_dir / f"{config['roomId']}.prepared.blend"), compress=True)
        print("LIGHTING_ONLY_COMPLETE", flush=True)
        return

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    by_name = {obj.name: obj for obj in mesh_objects}
    missing = [name for name in names if name not in by_name]
    if missing:
        raise ValueError(f"Imported objects do not match source node names: {missing[:20]}")
    if len(mesh_objects) != len(names):
        raise ValueError(f"Unexpected imported mesh object count: {len(mesh_objects)} != {len(names)}")

    collections = {
        "static": create_collection("01_STATIC_BAKE", "COLOR_04"),
        "dynamic": create_collection("02_DYNAMIC_REALTIME", "COLOR_01"),
        "special": create_collection("03_SPECIAL_REALTIME", "COLOR_03"),
        "lights": create_collection("04_A0_LIGHTS", "COLOR_02"),
        "cameras": create_collection("05_FIXED_CAMERAS", "COLOR_05"),
    }
    role_map = {"static_bake": "static", "dynamic_animated_subtree": "dynamic", "realtime_special_material_or_backdrop": "special"}
    classified = {key: [] for key in role_map.values()}
    object_rows = []
    for row in rows:
        obj = by_name[row["nodeName"]]
        role = role_map[row["role"]]
        classified[role].append(obj)
        move_to_collection(obj, collections[role])
        obj["bakeRole"] = row["role"]
        obj["sourceNodeIndex"] = row["nodeIndex"]
        obj["sourceSha256"] = source_hash
        object_rows.append({"name": obj.name, "role": row["role"], "triangles": row["triangles"]})
    scene = bpy.context.scene
    scene["sourceModel"] = source.name
    scene["sourceSha256"] = source_hash
    scene["bakeStage"] = "B1 prepared; no Android runtime integration"
    scene["dynamicShadowPolicy"] = "Dynamic and special collections are hidden for every static bake and restored for full PBR previews."
    lighting = configure_lights(config, rows, collections)
    world = configure_world(config, root, config["bake"]["aoDistanceMeters"])
    cameras = configure_cameras(config, mesh_objects, collections["cameras"])
    uv = create_uv2(classified["static"], config)
    bpy.context.view_layer.update()
    for obj in classified["static"]:
        obj["lightmapUvLayer"] = config["uv"]["layerName"]
        obj["lightmapUvIndex"] = list(obj.data.uv_layers).index(obj.data.uv_layers[config["uv"]["layerName"]])
        obj["lightmapAtlas"] = "example_room_2_4096"
    report = {
        "blenderVersion": bpy.app.version_string,
        "sourceSha256": source_hash,
        "counts": {
            "staticObjects": len(classified["static"]),
            "dynamicObjects": len(classified["dynamic"]),
            "specialObjects": len(classified["special"]),
            "staticTriangles": sum(row["triangles"] for row in rows if row["role"] == "static_bake"),
            "dynamicTriangles": sum(row["triangles"] for row in rows if row["role"] == "dynamic_animated_subtree"),
            "specialTriangles": sum(row["triangles"] for row in rows if row["role"] == "realtime_special_material_or_backdrop"),
        },
        "dynamicObjects": [obj.name for obj in classified["dynamic"]],
        "specialObjects": [obj.name for obj in classified["special"]],
        "lighting": lighting,
        "world": world,
        "cameras": cameras,
        "uv": uv,
        "objects": object_rows,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "preparation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    bpy.ops.wm.save_as_mainfile(filepath=str(output_dir / f"{config['roomId']}.prepared.blend"), compress=True)
    print(json.dumps({key: value for key, value in report.items() if key != "objects"}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
