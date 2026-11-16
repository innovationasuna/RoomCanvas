#!/usr/bin/env python3
"""Validate a shadow-proxy GLB against its source node set and geometry budget.

Checks are structural: node coverage, triangle budget, world-space bounds from
glTF node transforms, material/alpha mode, and absence of animations, skins,
cameras, lights and textures. It does not claim runtime shadow equivalence.
"""

import argparse
import hashlib
import json
import logging
import math
import re
import struct
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("validate_shadow_proxy")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_glb(path: Path) -> tuple[bytes, dict, bytes]:
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise ValueError("Expected a glTF 2.0 binary file")
    version, declared_length = struct.unpack_from("<II", data, 4)
    json_length, json_type = struct.unpack_from("<II", data, 12)
    if version != 2 or declared_length != len(data) or json_type != 0x4E4F534A:
        raise ValueError("Invalid GLB header")
    document = json.loads(data[20:20 + json_length].decode("utf-8").rstrip("\x00 "))
    binary_header = 20 + json_length
    binary = b""
    if binary_header + 8 <= len(data):
        binary_length, binary_type = struct.unpack_from("<II", data, binary_header)
        if binary_type == 0x004E4942:
            binary = data[binary_header + 8:binary_header + 8 + binary_length]
    return data, document, binary


def identity() -> list[float]:
    return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]


def mat_mul(left: list[float], right: list[float]) -> list[float]:
    result = [0.0] * 16
    for column in range(4):
        for row in range(4):
            result[column * 4 + row] = sum(
                left[index * 4 + row] * right[column * 4 + index] for index in range(4)
            )
    return result


def transform_point(matrix: list[float], point: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = point
    return (
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    )


def translation_matrix(translation: list[float]) -> list[float]:
    matrix = identity()
    matrix[12] = float(translation[0])
    matrix[13] = float(translation[1])
    matrix[14] = float(translation[2])
    return matrix


def quaternion_matrix(rotation: list[float]) -> list[float]:
    x, y, z, w = (float(value) for value in rotation)
    length = math.sqrt(x * x + y * y + z * z + w * w)
    if length == 0.0:
        raise ValueError("Zero-length quaternion in node rotation")
    x, y, z, w = x / length, y / length, z / length, w / length
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0.0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0.0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]


def trs_matrix(node: dict) -> list[float]:
    if "matrix" in node:
        return [float(value) for value in node["matrix"]]
    translation = node.get("translation", [0.0, 0.0, 0.0])
    rotation = node.get("rotation", [0.0, 0.0, 0.0, 1.0])
    scale = node.get("scale", [1.0, 1.0, 1.0])
    scale_matrix = identity()
    scale_matrix[0] = float(scale[0])
    scale_matrix[5] = float(scale[1])
    scale_matrix[10] = float(scale[2])
    return mat_mul(
        translation_matrix(translation),
        mat_mul(quaternion_matrix(rotation), scale_matrix),
    )


def world_matrices(document: dict) -> dict[int, list[float]]:
    nodes = document.get("nodes", [])
    parents: dict[int, int] = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            parents[child] = index
    result: dict[int, list[float]] = {}

    def resolve(index: int) -> list[float]:
        if index not in result:
            local = trs_matrix(nodes[index])
            result[index] = mat_mul(resolve(parents[index]), local) if index in parents else local
        return result[index]

    for index in range(len(nodes)):
        resolve(index)
    return result


def triangle_count(document: dict, primitive: dict) -> int:
    mode = primitive.get("mode", 4)
    accessor = document["accessors"][
        primitive["indices"] if "indices" in primitive else primitive["attributes"]["POSITION"]
    ]
    if mode == 4:
        return accessor["count"] // 3
    if mode in (5, 6):
        return max(0, accessor["count"] - 2)
    return 0


def node_triangles(document: dict, node: dict) -> int:
    mesh = document["meshes"][node["mesh"]]
    return sum(triangle_count(document, primitive) for primitive in mesh["primitives"])


def mesh_node_bounds(
    document: dict, matrix: list[float], node: dict
) -> tuple[tuple[float, float, float], tuple[float, float, float]]:
    points: list[tuple[float, float, float]] = []
    mesh = document["meshes"][node["mesh"]]
    for primitive in mesh["primitives"]:
        position = document["accessors"][primitive["attributes"]["POSITION"]]
        minimum = position.get("min")
        maximum = position.get("max")
        if minimum is None or maximum is None:
            raise ValueError("POSITION accessor is missing min/max")
        for x in (minimum[0], maximum[0]):
            for y in (minimum[1], maximum[1]):
                for z in (minimum[2], maximum[2]):
                    points.append(transform_point(matrix, (x, y, z)))
    return (
        tuple(min(point[axis] for point in points) for axis in range(3)),
        tuple(max(point[axis] for point in points) for axis in range(3)),
    )


def bounds_delta(
    before: tuple[tuple[float, float, float], tuple[float, float, float]],
    after: tuple[tuple[float, float, float], tuple[float, float, float]],
) -> float:
    return max(
        max(abs(before[0][axis] - after[0][axis]) for axis in range(3)),
        max(abs(before[1][axis] - after[1][axis]) for axis in range(3)),
    )


def mesh_nodes(document: dict) -> list[dict]:
    return [node for node in document.get("nodes", []) if "mesh" in node]


def ancestor_mesh_names(
    document: dict,
    names: set[str],
    rows_by_name: dict[str, dict],
    role: str,
    exclude_patterns: list[re.Pattern],
) -> tuple[set[str], list[str]]:
    nodes = document.get("nodes", [])
    parents: dict[int, int] = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            parents[child] = index
    index_by_name = {
        node.get("name"): index for index, node in enumerate(nodes)
        if "mesh" in node and node.get("name")
    }
    result: set[str] = set()
    violations: list[str] = []
    for name in names:
        index = index_by_name.get(name)
        if index is None:
            continue
        current = parents.get(index)
        while current is not None:
            ancestor = nodes[current]
            ancestor_name = ancestor.get("name")
            if "mesh" in ancestor and ancestor_name:
                row = rows_by_name.get(ancestor_name)
                if (
                    row is None
                    or row["role"] != role
                    or any(pattern.search(ancestor_name) for pattern in exclude_patterns)
                ):
                    violations.append(ancestor_name)
                else:
                    result.add(ancestor_name)
            current = parents.get(current)
    return result, violations


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args()
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    source = (root / config["sourceModel"]).resolve()
    inspection = (root / config["sourceInspection"]).resolve()
    proxy = (root / config["output"]["glb"]).resolve()
    report_path = (root / config["output"]["report"]).resolve()
    validation_path = (root / config["output"]["validation"]).resolve()

    source_hash = sha256(source)
    proxy_hash = sha256(proxy)
    _, source_document, _ = read_glb(source)
    _, proxy_document, _ = read_glb(proxy)
    inspection_data = json.loads(inspection.read_text(encoding="utf-8"))
    rows = inspection_data["classification"]["rows"]
    report = json.loads(report_path.read_text(encoding="utf-8"))

    selection = config["proxy"]
    exclude_patterns = [
        re.compile(pattern) for pattern in selection.get("excludeNodePatterns", [])
    ]
    name_counts: dict[str, int] = {}
    for row in rows:
        name_counts[row["nodeName"]] = name_counts.get(row["nodeName"], 0) + 1
    duplicates = sorted(name for name, count in name_counts.items() if count > 1)
    rows_by_name = {row["nodeName"]: row for row in rows}
    candidates = {
        row["nodeName"]: row for row in rows
        if row["role"] == selection["role"]
        and row["triangles"] >= selection["minSourceTriangles"]
        and not any(pattern.search(row["nodeName"]) for pattern in exclude_patterns)
    }
    ancestors, ancestor_violations = ancestor_mesh_names(
        source_document,
        set(candidates),
        rows_by_name,
        selection["role"],
        exclude_patterns,
    )
    expected = set(candidates) | ancestors
    proxy_nodes = {node.get("name"): node for node in mesh_nodes(proxy_document)}
    report_rows = {row["nodeName"]: row for row in report.get("rows", [])}
    source_world = world_matrices(source_document)
    proxy_world = world_matrices(proxy_document)
    source_index = {
        node.get("name"): index for index, node in enumerate(source_document.get("nodes", []))
        if "mesh" in node
    }
    proxy_index = {
        node.get("name"): index for index, node in enumerate(proxy_document.get("nodes", []))
        if "mesh" in node
    }

    checks: list[dict] = []

    def record(name: str, passed: bool, detail: str) -> None:
        checks.append({"name": name, "passed": passed, "detail": detail})

    record("source-sha256", source_hash == config["expectedSha256"], source_hash)
    record(
        "inspection-sha256",
        inspection_data.get("source", {}).get("sha256") == source_hash,
        str(inspection_data.get("source", {}).get("sha256")),
    )
    record(
        "report-source-sha256",
        report.get("source", {}).get("sha256") == source_hash,
        str(report.get("source", {}).get("sha256")),
    )
    record("unique-node-names", not duplicates, f"duplicates={duplicates}")
    record(
        "ancestor-policy",
        not ancestor_violations,
        f"ineligibleAncestorMeshes={sorted(set(ancestor_violations))}",
    )
    record("proxy-sha256", proxy_hash == report.get("output", {}).get("sha256"), proxy_hash)

    missing = sorted(expected - set(proxy_nodes))
    extra = sorted(set(proxy_nodes) - expected)
    record("node-coverage", not missing and not extra, f"missing={missing} extra={extra}")
    report_missing = sorted(expected - set(report_rows))
    record(
        "report-rows-coverage",
        not report_missing,
        f"missing={report_missing}",
    )

    per_node = []
    total_source = 0
    total_proxy = 0
    max_delta = 0.0
    for name in sorted(expected):
        proxy_node = proxy_nodes.get(name)
        if proxy_node is None:
            continue
        source_node = source_document["nodes"][source_index[name]]
        source_triangles = node_triangles(source_document, source_node)
        proxy_triangles = node_triangles(proxy_document, proxy_node)
        reported_proxy = report_rows.get(name, {}).get("proxyTriangles")
        source_bounds = mesh_node_bounds(source_document, source_world[source_index[name]], source_node)
        proxy_bounds = mesh_node_bounds(proxy_document, proxy_world[proxy_index[name]], proxy_node)
        delta = bounds_delta(source_bounds, proxy_bounds)
        total_source += source_triangles
        total_proxy += proxy_triangles
        max_delta = max(max_delta, delta)
        per_node.append({
            "nodeName": name,
            "sourceTriangles": source_triangles,
            "proxyTriangles": proxy_triangles,
            "reportedProxyTriangles": reported_proxy,
            "triangleDelta": None if reported_proxy is None else proxy_triangles - reported_proxy,
            "sourceBounds": [list(source_bounds[0]), list(source_bounds[1])],
            "proxyBounds": [list(proxy_bounds[0]), list(proxy_bounds[1])],
            "boundsDeltaMeters": round(delta, 6),
        })

    tolerance = config["validation"]["triangleCountTolerance"]
    mismatch = [
        item["nodeName"] for item in per_node
        if item["triangleDelta"] is None or abs(item["triangleDelta"]) > tolerance
    ]
    record("triangle-counts-match-report", not mismatch,
           f"tolerance={tolerance} mismatches={mismatch}")

    percent = 100.0 * total_proxy / total_source if total_source else 100.0
    record(
        "triangle-budget",
        percent <= config["validation"]["maxTotalTrianglePercent"],
        f"{total_proxy}/{total_source} = {percent:.3f}% "
        f"(limit {config['validation']['maxTotalTrianglePercent']}%)",
    )
    record(
        "world-bounds",
        max_delta <= config["validation"]["maxBoundsDeltaMeters"],
        f"maxDelta={max_delta:.6f} m (limit {config['validation']['maxBoundsDeltaMeters']} m)",
    )

    record("no-animations", not proxy_document.get("animations"), "animations must be empty")
    record("no-skins", not proxy_document.get("skins"), "skins must be empty")
    record("no-cameras", not proxy_document.get("cameras"), "cameras must be empty")
    record(
        "no-lights",
        not proxy_document.get("extensions", {}).get("KHR_lights_punctual")
        and "KHR_lights_punctual" not in proxy_document.get("extensionsUsed", []),
        "KHR_lights_punctual must be absent",
    )
    record("no-textures",
           not proxy_document.get("images") and not proxy_document.get("textures"),
           "images/textures must be empty")

    materials = proxy_document.get("materials", [])
    material_ok = len(materials) == 1 and materials[0].get("alphaMode", "OPAQUE") == "OPAQUE"
    record("single-opaque-material", material_ok,
           f"materials={len(materials)} alphaMode="
           f"{[material.get('alphaMode', 'OPAQUE') for material in materials]}")

    reported_total = report.get("totals", {}).get("proxyTriangles")
    record(
        "report-total-match",
        reported_total is not None and abs(reported_total - total_proxy) <= tolerance,
        f"report={reported_total} glb={total_proxy} tolerance={tolerance}",
    )
    reported_source_total = report.get("totals", {}).get("sourceTriangles")
    record(
        "report-source-total-match",
        reported_source_total is not None
        and abs(reported_source_total - total_source) <= tolerance,
        f"report={reported_source_total} source={total_source} tolerance={tolerance}",
    )
    delta_tolerance = config["validation"].get("reportBoundsDeltaToleranceMeters", 0.005)
    delta_mismatches = []
    for item in per_node:
        reported_delta = report_rows.get(item["nodeName"], {}).get("boundsDeltaMeters")
        if reported_delta is None or abs(reported_delta - item["boundsDeltaMeters"]) > delta_tolerance:
            delta_mismatches.append({
                "nodeName": item["nodeName"],
                "report": reported_delta,
                "glb": item["boundsDeltaMeters"],
            })
    record(
        "report-bounds-delta-match",
        not delta_mismatches,
        f"tolerance={delta_tolerance} mismatches={delta_mismatches}",
    )

    failures = [check for check in checks if not check["passed"]]
    result = {
        "schemaVersion": 1,
        "roomId": config["roomId"],
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceSha256": source_hash,
        "proxy": {
            "path": str(proxy),
            "sha256": proxy_hash,
            "fileBytes": proxy.stat().st_size,
        },
        "checks": checks,
        "failures": failures,
        "passed": not failures,
        "perNode": per_node,
    }
    validation_path.parent.mkdir(parents=True, exist_ok=True)
    validation_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    logger.info(json.dumps({
        "passed": result["passed"],
        "failures": [failure["name"] for failure in failures],
        "perNode": len(per_node),
        "totalSourceTriangles": total_source,
        "totalProxyTriangles": total_proxy,
        "maxBoundsDeltaMeters": round(max_delta, 6),
    }, ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
