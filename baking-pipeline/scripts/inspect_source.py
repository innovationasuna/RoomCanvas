#!/usr/bin/env python3
import argparse
import hashlib
import json
import re
import struct
from collections import Counter
from pathlib import Path


def read_glb(path):
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("Expected a glTF 2.0 binary file")
    version, declared_length = struct.unpack_from("<II", data, 4)
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if version != 2 or declared_length != len(data) or json_type != 0x4E4F534A:
        raise ValueError("Invalid GLB header")
    document = json.loads(data[20:20 + json_length].decode("utf-8").rstrip("\x00 "))
    return data, document


def triangle_count(document, primitive):
    mode = primitive.get("mode", 4)
    if "indices" in primitive:
        count = document["accessors"][primitive["indices"]]["count"]
    else:
        count = document["accessors"][primitive["attributes"]["POSITION"]]["count"]
    if mode == 4:
        return count // 3
    if mode in (5, 6):
        return max(0, count - 2)
    return 0


def inspect(config_path):
    config_path = config_path.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    source = (root / config["sourceModel"]).resolve()
    data, document = read_glb(source)
    digest = hashlib.sha256(data).hexdigest()
    if digest != config["expectedSha256"]:
        raise ValueError(f"Source SHA-256 mismatch: {digest}")

    nodes = document.get("nodes", [])
    animated_roots = {
        channel["target"]["node"]
        for animation in document.get("animations", [])
        for channel in animation.get("channels", [])
        if "node" in channel.get("target", {})
    }

    def subtree(index):
        return {index}.union(*(subtree(child) for child in nodes[index].get("children", [])))

    dynamic_indices = set().union(*(subtree(index) for index in animated_roots)) if animated_roots else set()
    excluded_patterns = [re.compile(pattern) for pattern in config["classification"]["excludedNodePatterns"]]
    excluded_roots = {
        index for index, node in enumerate(nodes)
        if any(pattern.search(node.get("name", "")) for pattern in excluded_patterns)
    }
    excluded_indices = set().union(*(subtree(index) for index in excluded_roots)) if excluded_roots else set()
    transmissive_materials = {
        index
        for index, material in enumerate(document.get("materials", []))
        if material.get("alphaMode", "OPAQUE") != "OPAQUE"
        or material.get("extensions", {}).get("KHR_materials_transmission", {}).get("transmissionFactor", 0) > 0
    }
    dynamic_meshes = {nodes[index]["mesh"] for index in dynamic_indices if "mesh" in nodes[index]}
    special_meshes = set()
    for index, node in enumerate(nodes):
        if "mesh" not in node:
            continue
        if index in excluded_indices:
            special_meshes.add(node["mesh"])
        mesh = document["meshes"][node["mesh"]]
        if any(primitive.get("material") in transmissive_materials for primitive in mesh["primitives"]):
            special_meshes.add(node["mesh"])

    rows = []
    counts = Counter()
    triangles = Counter()
    for index, node in enumerate(nodes):
        if "mesh" not in node:
            continue
        mesh = document["meshes"][node["mesh"]]
        triangle_total = sum(triangle_count(document, primitive) for primitive in mesh["primitives"])
        if node["mesh"] in dynamic_meshes:
            role = "dynamic_animated_subtree"
        elif node["mesh"] in special_meshes:
            role = "realtime_special_material_or_backdrop"
        else:
            role = "static_bake"
        counts[role] += 1
        triangles[role] += triangle_total
        rows.append({
            "nodeIndex": index,
            "nodeName": node.get("name", f"node_{index}"),
            "meshIndex": node["mesh"],
            "role": role,
            "triangles": triangle_total,
        })

    animations = [
        {
            "index": index,
            "name": animation.get("name", f"animation_{index}"),
            "targets": [
                {
                    "nodeIndex": channel["target"]["node"],
                    "nodeName": nodes[channel["target"]["node"]].get("name"),
                    "path": channel["target"].get("path"),
                }
                for channel in animation.get("channels", [])
                if "node" in channel.get("target", {})
            ],
        }
        for index, animation in enumerate(document.get("animations", []))
    ]
    report = {
        "roomId": config["roomId"],
        "source": {
            "path": str(source),
            "fileName": source.name,
            "fileBytes": len(data),
            "sha256": digest,
            "provenance": config["sourceProvenance"],
        },
        "asset": document.get("asset", {}),
        "counts": {
            "nodes": len(nodes),
            "meshNodes": len(rows),
            "meshes": len(document.get("meshes", [])),
            "primitives": sum(len(mesh["primitives"]) for mesh in document.get("meshes", [])),
            "triangles": sum(triangle_count(document, primitive) for mesh in document.get("meshes", []) for primitive in mesh["primitives"]),
            "materials": len(document.get("materials", [])),
            "images": len(document.get("images", [])),
            "animations": len(animations),
            "skins": len(document.get("skins", [])),
            "gltfLights": len(document.get("extensions", {}).get("KHR_lights_punctual", {}).get("lights", [])),
        },
        "classification": {
            "meshNodesByRole": dict(counts),
            "trianglesByRole": dict(triangles),
            "animatedRootNodeIndices": sorted(animated_roots),
            "dynamicNodeIndicesIncludingDescendants": sorted(dynamic_indices),
            "transmissiveOrNonOpaqueMaterialIndices": sorted(transmissive_materials),
            "rows": rows,
        },
        "animations": animations,
        "extensionsUsed": document.get("extensionsUsed", []),
    }
    output_dir = root / "output" / config["roomId"] / "b0"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / "source-inspection.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {key: value for key, value in report.items() if key not in ("classification", "animations")}
    summary["classification"] = {key: value for key, value in report["classification"].items() if key != "rows"}
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    print(f"Saved {output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description="Verify source identity and classify animated/static GLB nodes")
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    inspect(args.config)


if __name__ == "__main__":
    main()
