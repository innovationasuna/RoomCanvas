"""A geometry-only collision asset; never replace the textured display model."""
import argparse
import hashlib
import json
from pathlib import Path
import time


def _mesh(vertices, faces):
    import trimesh
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    # UV seams duplicate vertices in display meshes; topology uses geometric vertices.
    mesh.merge_vertices()
    return mesh


def _open3d(mesh):
    import open3d as o3d
    return o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(mesh.vertices),
                                     o3d.utility.Vector3iVector(mesh.faces))


def _surface_distance(source, target, samples=2048):
    """Deterministic bidirectional surface checks through Open3D's triangle BVH."""
    import numpy as np
    import open3d as o3d
    import trimesh
    points, _ = trimesh.sample.sample_surface(source, samples, seed=42)
    # Include extrema and support surfaces, even when their area is very small.
    extreme = np.r_[source.vertices.argmin(axis=0), source.vertices.argmax(axis=0)]
    support = source.triangles_center[np.abs(source.face_normals[:, 1]) > .99]
    if len(support) > samples:
        support = support[np.linspace(0, len(support)-1, samples, dtype=int)]
    points = np.concatenate([points, source.vertices[extreme], support]).astype(np.float32)
    scene = o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.t.geometry.TriangleMesh.from_legacy(_open3d(target)))
    distances = scene.compute_distance(o3d.core.Tensor(points)).numpy()
    return float(distances.max()), float(np.quantile(distances, .99))


def quality(source, candidate):
    import numpy as np
    diagonal = float(np.linalg.norm(source.extents))
    if not len(candidate.faces) or not np.isfinite(candidate.vertices).all() or diagonal <= 0:
        return dict(accepted=False, reason='invalid_geometry')
    if source.euler_number != candidate.euler_number:
        return dict(accepted=False, reason='changed_topology')
    bounds_error = float(np.abs(source.bounds-candidate.bounds).max()) / diagonal
    distances = [_surface_distance(source, candidate), _surface_distance(candidate, source)]
    maximum = max(row[0] for row in distances) / diagonal
    percentile = max(row[1] for row in distances) / diagonal
    return dict(accepted=bounds_error <= .005 and maximum <= .01 and percentile <= .005,
                bounds_error_fraction=bounds_error, surface_max_fraction=maximum,
                surface_p99_fraction=percentile)


def generate_collision_proxy(run, target_faces=12000):
    import numpy as np
    import trimesh
    from cover_scene import write_json

    if target_faces < 12:
        raise ValueError('target_faces must be at least 12')
    started = time.monotonic()
    directory = Path(run)/'reconstruction'
    source, destination = directory/'result.glb', directory/'collision.glb'
    metadata = directory/'collision-glb.json'
    original = source.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if destination.is_file() and metadata.is_file():
        previous = json.loads(metadata.read_text())
        if previous.get('source_sha256') == digest and previous.get('target_faces') == target_faces:
            return previous
    scene = trimesh.load_scene(source, process=False)
    total = sum(len(mesh.faces) for mesh in scene.geometry.values() if isinstance(mesh, trimesh.Trimesh))
    if not total:
        raise ValueError('GLB has no triangle geometry')
    records = []
    for name, display in list(scene.geometry.items()):
        if not isinstance(display, trimesh.Trimesh) or not len(display.faces):
            continue
        mesh = _mesh(display.vertices.copy(), display.faces.copy())
        # Decimate connected pieces separately so thin legs and tiny parts survive.
        labels, counts, _ = _open3d(mesh).cluster_connected_triangles()
        labels = np.asarray(labels)
        pieces = []
        for index, count in enumerate(counts):
            piece = mesh.submesh([np.flatnonzero(labels == index)], append=True)
            budget = max(12, int(target_faces * count / total))
            record = dict(geometry=name, component=index, source_faces=len(piece.faces))
            if len(piece.faces) > budget:
                reduced = _open3d(piece).simplify_quadric_decimation(budget, boundary_weight=100.)
                candidate = _mesh(np.asarray(reduced.vertices), np.asarray(reduced.triangles))
                record.update(quality(piece, candidate))
                if record['accepted']:
                    piece = candidate
            else:
                record.update(accepted=True, reason='already_small')
            record['proxy_faces'] = len(piece.faces)
            records.append(record)
            pieces.append(piece)
        # A fresh mesh drops textures, colours, UVs and material references.
        combined = trimesh.util.concatenate(pieces)
        scene.geometry[name] = _mesh(combined.vertices, combined.faces)
    data = scene.export(file_type='glb', include_normals=False)
    result = dict(schema_version=1, source_sha256=digest, target_faces=target_faces,
                  source_faces=total, proxy_faces=sum(len(m.faces) for m in scene.geometry.values()
                                                     if isinstance(m, trimesh.Trimesh)),
                  source_bytes=len(original), proxy_bytes=len(data), components=records,
                  elapsed_seconds=round(time.monotonic()-started, 3))
    temporary = destination.with_suffix('.glb.tmp')
    temporary.write_bytes(data)
    temporary.replace(destination)
    write_json(metadata, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--target-faces', type=int, default=12000)
    args = parser.parse_args()
    print(json.dumps(generate_collision_proxy(args.run_dir, args.target_faces)), flush=True)
