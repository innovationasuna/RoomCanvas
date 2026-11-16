#!/usr/bin/env python3
"""Build a shadow-only low-poly proxy GLB for static, opaque, high-cost meshes.

The proxy is exported as an independent GLB that keeps the source node names and
world transforms. The Android runtime is expected to render it with the color
pass fully culled and the shadow pass kept, while disabling shadow casting on
the matching high-poly source renderables. This script only produces the
offline asset and a per-object report; it does not touch Android assets.
"""

import argparse
import hashlib
import json
import logging
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector

logger = logging.getLogger("build_shadow_proxy")


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def triangle_count(obj: "bpy.types.Object") -> int:
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def world_bounds(obj: "bpy.types.Object") -> dict[str, list[float]]:
    """Bounds of polygon-referenced vertices only.

    Decimate leaves loose vertices that `obj.bound_box` still includes but the
    glTF exporter drops. Using referenced vertices keeps the report consistent
    with the exported GLB.
    """
    mesh = obj.data
    indices: set[int] = set()
    for polygon in mesh.polygons:
        indices.update(polygon.vertices)
    if not indices:
        raise ValueError(f"Mesh has no referenced vertices: {obj.name}")
    points = [obj.matrix_world @ mesh.vertices[index].co for index in indices]
    minimum = [min(point[axis] for point in points) for axis in range(3)]
    maximum = [max(point[axis] for point in points) for axis in range(3)]
    return {
        "min": [round(value, 6) for value in minimum],
        "max": [round(value, 6) for value in maximum],
    }


def bounds_delta(before: dict[str, list[float]], after: dict[str, list[float]]) -> float:
    return round(
        max(
            max(
                abs(before["min"][axis] - after["min"][axis]),
                abs(before["max"][axis] - after["max"][axis]),
            )
            for axis in range(3)
        ),
        6,
    )


def apply_decimation(
    obj: "bpy.types.Object", target_triangles: int, minimum_ratio: float
) -> tuple[int, int, float]:
    source_triangles = triangle_count(obj)
    if source_triangles <= target_triangles:
        return source_triangles, source_triangles, 1.0
    ratio = max(minimum_ratio, target_triangles / source_triangles)
    if obj.data.users > 1:
        obj.data = obj.data.copy()
    modifier = obj.modifiers.new("ShadowProxyDecimate", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return source_triangles, triangle_count(obj), round(ratio, 6)


def ancestors(obj: "bpy.types.Object") -> set["bpy.types.Object"]:
    result = set()
    current = obj.parent
    while current is not None:
        result.add(current)
        current = current.parent
    return result


def write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def proxy_material(config: dict) -> "bpy.types.Material":
    material = bpy.data.materials.new(config["proxy"]["materialName"])
    material.use_nodes = True
    material.use_backface_culling = True
    base = config["proxy"]["material"]
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = base["baseColor"]
    principled.inputs["Roughness"].default_value = base["roughness"]
    principled.inputs["Metallic"].default_value = base["metallic"]
    return material


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    source = (root / config["sourceModel"]).resolve()
    inspection = (root / config["sourceInspection"]).resolve()

    digest = sha256(source)
    if digest != config["expectedSha256"]:
        raise ValueError(f"Source SHA-256 mismatch: {digest}")

    inspection_data = json.loads(inspection.read_text(encoding="utf-8"))
    if inspection_data.get("source", {}).get("sha256") != digest:
        raise ValueError("source-inspection.json does not match the source SHA-256; regenerate it")
    rows = inspection_data["classification"]["rows"]
    name_counts: dict[str, int] = {}
    for row in rows:
        name_counts[row["nodeName"]] = name_counts.get(row["nodeName"], 0) + 1
    duplicates = sorted(name for name, count in name_counts.items() if count > 1)
    if duplicates:
        raise ValueError(f"Duplicate glTF node names are not supported: {duplicates}")

    proxy_config = config["proxy"]
    exclude_patterns = [
        re.compile(pattern) for pattern in proxy_config.get("excludeNodePatterns", [])
    ]

    def eligible_ancestor(obj: "bpy.types.Object") -> bool:
        row = row_by_name.get(obj.name)
        return (
            row is not None
            and row["role"] == proxy_config["role"]
            and not any(pattern.search(obj.name) for pattern in exclude_patterns)
        )

    row_by_name = {row["nodeName"]: row for row in rows}
    candidates = [
        row for row in rows
        if row["role"] == proxy_config["role"]
        and row["triangles"] >= proxy_config["minSourceTriangles"]
        and not any(pattern.search(row["nodeName"]) for pattern in exclude_patterns)
    ]
    if not candidates:
        raise ValueError("No candidate meshes matched the proxy selection rules")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    objects = {obj.name: obj for obj in bpy.data.objects}

    missing = [row["nodeName"] for row in candidates if row["nodeName"] not in objects]
    if missing:
        raise ValueError(f"Candidate objects missing after import: {missing}")
    non_mesh = [name for name in objects if name in row_by_name and objects[name].type != "MESH"]
    if non_mesh:
        raise ValueError(f"Expected mesh objects but found other types: {non_mesh}")

    candidate_names = {row["nodeName"] for row in candidates}
    candidate_objects = [objects[row["nodeName"]] for row in candidates]
    proxy_objects = list(candidate_objects)
    seen = {obj.name for obj in proxy_objects}
    for obj in candidate_objects:
        for ancestor in ancestors(obj):
            if ancestor.type != "MESH":
                continue
            if not eligible_ancestor(ancestor):
                raise ValueError(
                    f"Ancestor mesh {ancestor.name} is not an eligible static opaque proxy mesh"
                )
            if ancestor.name not in seen:
                proxy_objects.append(ancestor)
                seen.add(ancestor.name)
    keep = set(proxy_objects)
    for obj in proxy_objects:
        keep |= ancestors(obj)

    report_rows = []
    for obj in proxy_objects:
        row = row_by_name.get(obj.name)
        if row is None:
            raise ValueError(f"Proxy mesh is missing from the source inspection: {obj.name}")
        before = world_bounds(obj)
        source_triangles = row["triangles"]
        target = max(
            proxy_config["minOutputTriangles"],
            round(triangle_count(obj) * proxy_config["decimateRatio"]),
        )
        _, proxy_triangles, ratio = apply_decimation(obj, target, minimum_ratio=0.01)
        after = world_bounds(obj)
        report_rows.append({
            "nodeName": obj.name,
            "ancestorMesh": obj.name not in candidate_names,
            "sourceTriangles": source_triangles,
            "proxyTriangles": proxy_triangles,
            "targetTriangles": target,
            "decimateRatio": ratio,
            "sourceBounds": before,
            "proxyBounds": after,
            "boundsDeltaMeters": bounds_delta(before, after),
        })

    for obj in [item for item in bpy.data.objects if item not in keep]:
        bpy.data.objects.remove(obj, do_unlink=True)

    material = proxy_material(config)
    for obj in proxy_objects:
        obj.data.materials.clear()
        obj.data.materials.append(material)
        for polygon in obj.data.polygons:
            polygon.material_index = 0

    source_total = sum(row["sourceTriangles"] for row in report_rows)
    proxy_total = sum(row["proxyTriangles"] for row in report_rows)
    report = {
        "schemaVersion": 1,
        "roomId": config["roomId"],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {"path": str(source), "sha256": digest},
        "selection": {
            "role": proxy_config["role"],
            "minSourceTriangles": proxy_config["minSourceTriangles"],
            "decimateRatio": proxy_config["decimateRatio"],
            "minOutputTriangles": proxy_config["minOutputTriangles"],
            "excludeNodePatterns": proxy_config.get("excludeNodePatterns", []),
            "candidateCount": len(candidates),
            "proxyObjectCount": len(report_rows),
        },
        "totals": {
            "sourceTriangles": source_total,
            "proxyTriangles": proxy_total,
            "reductionPercent": round((1 - proxy_total / source_total) * 100, 3),
        },
        "rows": report_rows,
    }

    if args.dry_run:
        logger.info(json.dumps(report, ensure_ascii=False, indent=2))
        return

    glb_path = (root / config["output"]["glb"]).resolve()
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=False,
        export_apply=False,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
    )
    report["output"] = {
        "glb": str(glb_path),
        "fileBytes": glb_path.stat().st_size,
        "sha256": sha256(glb_path),
    }
    report_path = (root / config["output"]["report"]).resolve()
    write_json_atomic(report_path, report)
    logger.info(json.dumps({
        "glb": str(glb_path),
        "fileBytes": report["output"]["fileBytes"],
        "sha256": report["output"]["sha256"],
        "totals": report["totals"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
