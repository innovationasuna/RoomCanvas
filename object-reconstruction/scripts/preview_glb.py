"""Export a small, colored GLB for progressive display without altering result.glb."""
import argparse
import hashlib
import json
from pathlib import Path


def generate_preview(run, target_faces=12000):
    import numpy as np
    import open3d as o3d
    import trimesh
    from scipy.spatial import cKDTree

    if target_faces < 4:
        raise ValueError('target_faces must be at least 4')
    directory = Path(run)/'reconstruction'
    source, destination = directory/'result.glb', directory/'preview.glb'
    metadata = directory/'preview-glb.json'
    original = source.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if destination.is_file() and metadata.is_file():
        previous = json.loads(metadata.read_text())
        if previous.get('source_sha256') == digest and previous.get('target_faces') == target_faces:
            return previous
    scene = trimesh.load_scene(source, process=False)
    meshes = [mesh for mesh in scene.geometry.values() if isinstance(mesh, trimesh.Trimesh)]
    total = sum(len(mesh.faces) for mesh in meshes)
    if not total:
        raise ValueError('GLB has no triangle geometry')
    for name, mesh in list(scene.geometry.items()):
        if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
            continue
        budget = max(4, int(target_faces * len(mesh.faces) / total))
        if len(mesh.faces) <= budget:
            continue
        # Keep geometry in its original node space; the scene graph and the
        # manifest's display transform are shared by preview and full model.
        colors = (mesh.visual.to_color().vertex_colors if mesh.visual.kind == 'texture'
                  else mesh.visual.vertex_colors)
        reduced = o3d.geometry.TriangleMesh(
            o3d.utility.Vector3dVector(np.asarray(mesh.vertices)),
            o3d.utility.Vector3iVector(np.asarray(mesh.faces)))
        reduced.vertex_colors = o3d.utility.Vector3dVector(colors[:, :3] / 255.)
        reduced = reduced.simplify_quadric_decimation(budget)
        vertices, faces = np.asarray(reduced.vertices), np.asarray(reduced.triangles)
        if not len(faces) or not np.isfinite(vertices).all():
            raise ValueError('Simplification produced invalid geometry')
        nearest = cKDTree(mesh.vertices).query(vertices)[1]
        rgba = np.column_stack((np.clip(np.asarray(reduced.vertex_colors) * 255., 0, 255),
                                colors[nearest, 3])).round().astype(np.uint8)
        scene.geometry[name] = trimesh.Trimesh(vertices=vertices, faces=faces,
                                             vertex_colors=rgba, process=False)
    data = scene.export(file_type='glb')
    result = dict(source_sha256=digest, target_faces=target_faces, source_faces=total,
                  preview_faces=sum(len(m.faces) for m in scene.geometry.values()
                                    if isinstance(m, trimesh.Trimesh)),
                  source_bytes=len(original), preview_bytes=len(data))
    if len(data) >= len(original):
        # Tiny models already load quickly; don't download a redundant preview.
        destination.unlink(missing_ok=True)
        metadata.unlink(missing_ok=True)
        return dict(result, status='not_smaller')
    temporary = destination.with_suffix('.glb.tmp')
    temporary.write_bytes(data)
    temporary.replace(destination)
    temporary = metadata.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n')
    temporary.replace(metadata)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    parser.add_argument('--target-faces', type=int, default=12000)
    args = parser.parse_args()
    print(json.dumps(generate_preview(args.run_dir, args.target_faces)), flush=True)
