#!/usr/bin/env python3
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw


def read_glb(path):
    data = path.read_bytes()
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if data[:4] != b"glTF" or json_type != 0x4E4F534A:
        raise ValueError("Invalid GLB")
    document = json.loads(data[20:20 + json_length].decode("utf-8").rstrip("\x00 "))
    bin_header = 20 + json_length
    bin_length, bin_type = struct.unpack_from("<II", data, bin_header)
    if bin_type != 0x004E4942:
        raise ValueError("GLB has no BIN chunk")
    binary = data[bin_header + 8:bin_header + 8 + bin_length]
    return data, document, binary


def accessor_values(document, binary, index):
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    formats = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
    code = formats[accessor["componentType"]]
    width = struct.calcsize("<" + code)
    stride = view.get("byteStride", components * width)
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [
        struct.unpack_from("<" + code * components, binary, start + item * stride)
        for item in range(accessor["count"])
    ]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"]
    source = (root / config["sourceModel"]).resolve()
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != config["expectedSha256"]:
        raise ValueError("Original source changed during baking")
    _, source_document, source_binary = read_glb(source)
    _, baked, binary = read_glb(output_dir / f"{config['roomId']}.baked.glb")
    inspection = json.loads((output_dir / "b0" / "source-inspection.json").read_text(encoding="utf-8"))
    source_roles = {row["nodeName"]: row["role"] for row in inspection["classification"]["rows"]}
    baked_nodes = {node.get("name"): node for node in baked.get("nodes", [])}
    source_edges = {
        (parent.get("name"), source_document["nodes"][child].get("name"))
        for parent in source_document.get("nodes", []) for child in parent.get("children", [])
    }
    baked_edges = {
        (parent.get("name"), baked["nodes"][child].get("name"))
        for parent in baked.get("nodes", []) for child in parent.get("children", [])
    }
    missing_hierarchy_edges = sorted(source_edges - baked_edges)
    missing_nodes = sorted(set(source_roles) - set(baked_nodes))
    role_mismatches = []
    uv2_missing = []
    uv2_out_of_bounds = []
    total_uv_area = 0.0
    total_static_triangles = 0
    degenerate_uv_triangles = 0
    uv_channel_counts = {}
    layout = Image.new("RGB", (2048, 2048), (14, 18, 24))
    draw = ImageDraw.Draw(layout)

    for name, role in source_roles.items():
        node = baked_nodes.get(name)
        if node is None:
            continue
        if node.get("extras", {}).get("bakeRole") != role:
            role_mismatches.append(name)
        if role != "static_bake":
            if "lightmapDirect" in node.get("extras", {}):
                role_mismatches.append(f"{name}: dynamic/special object has lightmap binding")
            continue
        uv_index = node.get("extras", {}).get("lightmapUvIndex")
        channel = f"TEXCOORD_{uv_index}"
        uv_channel_counts[channel] = uv_channel_counts.get(channel, 0) + 1
        mesh = baked["meshes"][node["mesh"]]
        for primitive in mesh["primitives"]:
            attributes = primitive["attributes"]
            if uv_index not in (1, 2) or channel not in attributes:
                uv2_missing.append(name)
                continue
            uvs = accessor_values(baked, binary, attributes[channel])
            flat = [value for uv in uvs for value in uv]
            if not all(math.isfinite(value) for value in flat) or min(flat) < -0.001 or max(flat) > 1.001:
                uv2_out_of_bounds.append(name)
            indices = [item[0] for item in accessor_values(baked, binary, primitive["indices"])] if "indices" in primitive else list(range(len(uvs)))
            for offset in range(0, len(indices) - 2, 3):
                a, b, c = (uvs[indices[offset + axis]] for axis in range(3))
                area = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) * 0.5
                total_uv_area += area
                total_static_triangles += 1
                if area < 1e-12:
                    degenerate_uv_triangles += 1
                color = (70, 190, 150) if offset % 6 == 0 else (45, 110, 100)
                points = [(round(u * 2047), round((1.0 - v) * 2047)) for u, v in (a, b, c)]
                draw.line(points + [points[0]], fill=color, width=1)
    layout_path = output_dir / "previews" / "uv2-layout.png"
    layout_path.parent.mkdir(parents=True, exist_ok=True)
    layout.save(layout_path)

    source_nodes = {node.get("name"): node for node in source_document.get("nodes", [])}
    _, previous_baked, previous_binary = read_glb(output_dir / config["review"]["previousBaked"])
    previous_nodes = {node.get("name"): node for node in previous_baked.get("nodes", [])}
    normal_mismatches = []
    normal_comparisons = 0
    max_normal_distance = 0.0
    max_normal_distance_by_object = {}
    missing_normal_positions = []
    previous_normal_mismatches = []
    previous_uv2_mismatches = []
    previous_normal_comparisons = 0
    previous_uv2_comparisons = 0
    normal_tolerance = config["review"]["sourceNormalTolerance"]
    for name in source_roles:
        source_node = source_nodes[name]
        baked_node = baked_nodes.get(name)
        if baked_node is None:
            continue
        source_mesh = source_document["meshes"][source_node["mesh"]]
        baked_mesh = baked["meshes"][baked_node["mesh"]]
        previous_mesh = previous_baked["meshes"][previous_nodes[name]["mesh"]]
        normals_by_position = {}
        for primitive_index, (baked_primitive, previous_primitive) in enumerate(zip(baked_mesh["primitives"], previous_mesh["primitives"])):
            positions = accessor_values(baked, binary, baked_primitive["attributes"]["POSITION"])
            normals = accessor_values(baked, binary, baked_primitive["attributes"]["NORMAL"])
            previous_normals = accessor_values(previous_baked, previous_binary, previous_primitive["attributes"]["NORMAL"])
            previous_normal_comparisons += 1
            if normals != previous_normals:
                previous_normal_mismatches.append(f"{name}: primitive {primitive_index}")
            for position, normal in zip(positions, normals):
                normals_by_position.setdefault(tuple(position), []).append(normal)
            if source_roles[name] == "static_bake":
                channel = f"TEXCOORD_{baked_node['extras']['lightmapUvIndex']}"
                previous_channel = f"TEXCOORD_{previous_nodes[name]['extras']['lightmapUvIndex']}"
                previous_uv2_comparisons += 1
                if channel != previous_channel or accessor_values(baked, binary, baked_primitive["attributes"][channel]) != accessor_values(previous_baked, previous_binary, previous_primitive["attributes"][previous_channel]):
                    previous_uv2_mismatches.append(f"{name}: primitive {primitive_index}")
        for source_primitive in source_mesh["primitives"]:
            source_positions = accessor_values(source_document, source_binary, source_primitive["attributes"]["POSITION"])
            source_normals = accessor_values(source_document, source_binary, source_primitive["attributes"]["NORMAL"])
            for position, normal in zip(source_positions, source_normals):
                normal_comparisons += 1
                candidates = normals_by_position.get(tuple(position), [])
                if not candidates:
                    missing_normal_positions.append(name)
                    continue
                distance = min(math.dist(normal, candidate) for candidate in candidates)
                max_normal_distance = max(max_normal_distance, distance)
                max_normal_distance_by_object[name] = max(max_normal_distance_by_object.get(name, 0.0), distance)
        if max_normal_distance_by_object.get(name, 0.0) > normal_tolerance:
            normal_mismatches.append({"object": name, "maxNormalDistance": max_normal_distance_by_object[name]})

    preview_images = []
    for view in config["camera"]["views"]:
        for suffix in ("baked-static-diagnostic", "offline-full-pbr"):
            relative = f"previews/{view['id']}-{suffix}.png"
            path = output_dir / relative
            valid = path.is_file()
            if valid:
                with Image.open(path) as image:
                    valid = image.format == "PNG" and image.size == tuple(config["camera"]["resolution"])
                    image.verify()
            preview_images.append({"path": relative, "validPngAtExpectedSize": valid, "notOlderThanDirectMaster": valid and path.stat().st_mtime_ns >= (output_dir / "lightmaps" / "direct-diffuse.exr").stat().st_mtime_ns})

    extensions = set(baked.get("extensionsUsed", []))
    animations = [
        {
            "name": animation.get("name"),
            "targets": sorted({baked["nodes"][channel["target"]["node"]].get("name") for channel in animation["channels"] if "node" in channel.get("target", {})}),
        }
        for animation in baked.get("animations", [])
    ]
    lightmaps = {}
    for relative in ("lightmaps/direct-diffuse.exr", "lightmaps/indirect.exr", "lightmaps/ao.png"):
        path = output_dir / relative
        lightmaps[relative] = {
            "exists": path.is_file(),
            "bytes": path.stat().st_size if path.is_file() else 0,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None,
        }
    ao = Image.open(output_dir / "lightmaps" / "ao.png")
    checks = {
        "originalSourceUnchanged": source_hash == config["expectedSha256"],
        "allSourceMeshNodesPresent": not missing_nodes,
        "hierarchyPreserved": not missing_hierarchy_edges,
        "rolesPreserved": not role_mismatches,
        "allStaticPrimitivesHaveUv2": not uv2_missing,
        "uv2FiniteAndWithinAtlas": not uv2_out_of_bounds,
        "uvAreaFitsSingleAtlas": total_uv_area <= 1.00001,
        "existingUv2LayoutUnchanged": abs(total_uv_area - config["uv"]["expectedExistingArea"]) < 1e-10 and uv_channel_counts == config["uv"]["expectedExistingChannelCounts"],
        "originalNormalsPreserved": not normal_mismatches and not missing_normal_positions and normal_comparisons > 0,
        "normalDataUnchangedFromPreviousBaked": not previous_normal_mismatches and previous_normal_comparisons > 0,
        "uv2DataUnchangedFromPreviousBaked": not previous_uv2_mismatches and previous_uv2_comparisons > 0,
        "fourAnimationsPreserved": len(animations) == 4,
        "noUnlitExtension": "KHR_materials_unlit" not in extensions,
        "noExportedPunctualLights": "KHR_lights_punctual" not in extensions,
        "allLightmapMastersPresent": all(row["exists"] and row["bytes"] > 0 for row in lightmaps.values()),
        "previewImagesValid": all(row["validPngAtExpectedSize"] for row in preview_images),
        "previewImagesFromCurrentRun": all(row["notOlderThanDirectMaster"] for row in preview_images),
    }
    report = {
        "stage": "B1 structural validation",
        "checks": checks,
        "allStructuralChecksPassed": all(checks.values()),
        "bakedGlb": {
            "fileBytes": (output_dir / f"{config['roomId']}.baked.glb").stat().st_size,
            "sha256": hashlib.sha256((output_dir / f"{config['roomId']}.baked.glb").read_bytes()).hexdigest(),
            "nodes": len(baked.get("nodes", [])),
            "meshes": len(baked.get("meshes", [])),
            "materials": len(baked.get("materials", [])),
            "extensionsUsed": sorted(extensions),
            "animations": animations,
        },
        "missingNodes": missing_nodes,
        "roleMismatches": role_mismatches,
        "sourceNormalComparison": {
            "method": "Each source POSITION/NORMAL corner is compared with the closest NORMAL at the exact same exported local POSITION; UV seams may change vertex counts and primitive order",
            "normalTolerance": normal_tolerance,
            "maxMinimumEuclideanNormalDifference": max_normal_distance,
            "mismatches": normal_mismatches,
            "missingPositions": sorted(set(missing_normal_positions)),
            "cornerComparisons": normal_comparisons,
        },
        "previousBakedComparison": {
            "path": config["review"]["previousBaked"],
            "normalArraysIdentical": not previous_normal_mismatches,
            "normalMismatches": previous_normal_mismatches,
            "normalPrimitiveComparisons": previous_normal_comparisons,
            "uv2ArraysIdentical": not previous_uv2_mismatches,
            "uv2Mismatches": previous_uv2_mismatches,
            "uv2PrimitiveComparisons": previous_uv2_comparisons,
        },
        "previewImages": preview_images,
        "uv2Missing": sorted(set(uv2_missing)),
        "uv2OutOfBounds": sorted(set(uv2_out_of_bounds)),
        "uv2": {
            "sumTriangleAreaInUvSpace": total_uv_area,
            "staticTrianglesChecked": total_static_triangles,
            "degenerateUvTriangles": degenerate_uv_triangles,
            "meshNodesByLightmapChannel": uv_channel_counts,
            "layoutPreview": "previews/uv2-layout.png",
            "overlapAssurance": "UVs are packed on one temporary joined mesh and transferred back by source-loop indices. The area sum is a necessary condition, not an exhaustive pixel-level overlap proof.",
        },
        "lightmaps": lightmaps,
        "aoImage": {"size": list(ao.size), "mode": ao.mode, "extrema": ao.getextrema()},
        "visualAcceptance": "Separate manual step; structural checks do not prove A0 visual equivalence.",
    }
    (output_dir / "validation-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
    if not report["allStructuralChecksPassed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
