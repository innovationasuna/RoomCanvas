import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import bpy
import numpy as np


def mesh_metrics(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    positions = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get("co", positions)
    positions = positions.reshape(-1, 3)
    indices = np.array([triangle.vertices[:] for triangle in mesh.loop_triangles], dtype=np.int32)
    volume = 0.0
    if len(indices):
        triangles = positions[indices]
        volume = float(np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum() / 6.0)
    edge_counts = Counter()
    welded_positions = {}
    for index, position in enumerate(positions):
        welded_positions[index] = tuple(np.round(position, decimals=6))
    for polygon in mesh.polygons:
        for edge_index in polygon.edge_keys:
            edge_counts[tuple(sorted(welded_positions[index] for index in edge_index))] += 1
    determinant = obj.matrix_world.determinant()
    return {
        "object": obj.name,
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
        "triangles": len(mesh.loop_triangles),
        "localSignedVolume": volume,
        "worldDeterminant": determinant,
        "worldSignedVolume": volume * determinant,
        "boundaryEdgesAtOneMicrometer": sum(count == 1 for count in edge_counts.values()),
        "nonManifoldEdgesAtOneMicrometer": sum(count != 2 for count in edge_counts.values()),
    }


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args(argv)
    config_path = args.config.resolve()
    root = config_path.parents[1]
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output_dir = root / "output" / config["roomId"] / "diagnostics"
    output_dir.mkdir(parents=True, exist_ok=True)
    objects = [obj for obj in bpy.data.collections["01_STATIC_BAKE"].objects if obj.type == "MESH"]
    rows = [mesh_metrics(obj) for obj in objects]
    negative = [row for row in rows if row["worldSignedVolume"] < -1e-12]
    negative_closed = [row for row in negative if row["boundaryEdgesAtOneMicrometer"] == 0]
    report = {
        "sourceSha256": bpy.context.scene["sourceSha256"],
        "staticObjects": len(rows),
        "negativeWorldVolumeObjects": len(negative),
        "negativeClosedObjects": len(negative_closed),
        "negativeClosedNames": [row["object"] for row in negative_closed],
        "negativeOpenObjects": [row["object"] for row in negative if row["boundaryEdgesAtOneMicrometer"] != 0],
        "negativeObjects": negative,
        "selectedMaterials": [row for row in rows if any(name in ("Ivory PVC trunking", "White painted metal", "ceiling_tile", "navy_fabric") for name in row["materials"])],
    }
    (output_dir / "normal-audit.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key not in ("negativeObjects", "selectedMaterials")}, ensure_ascii=False, indent=2), flush=True)
    print("SELECTED_MATERIALS", flush=True)
    for row in report["selectedMaterials"]:
        if row["object"].startswith(("Trunking channel", "Ceiling tee", "Ceiling0", "geometry_0")):
            print(json.dumps(row, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
