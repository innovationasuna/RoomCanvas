"""CPU quality gates for two same-input/seed runs; never require identical GPU bytes.

Example: python scripts/check_reconstruction_quality.py --old-run <baseline>
         --new-run <candidate> --output <report.json>
Uses NumPy, trimesh, Pillow and Open3D from the existing reconstruction environment.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
import trimesh
import yaml

THRESHOLDS = dict(bounds_diagonal_fraction=.02, surface_p99_diagonal_fraction=.02,
                  surface_max_diagonal_fraction=.05, support_hit_agreement=.98,
                  support_p95_diagonal_fraction=.02, support_max_diagonal_fraction=.05,
                  surface_color_mean_absolute=.10, cover_max_iou_drop=.05,
                  camera_rtol=1e-5, camera_atol=1e-6)


def read_json(path):
    return json.loads(Path(path).read_text())


def provenance(run):
    inputs, config = read_json(run/'inputs.json'), yaml.safe_load((run/'config.yaml').read_text())
    rows = []
    for row in inputs['images']:
        hashes = {}
        for key in ('image', 'mask'):
            path = Path(row[key])
            if not path.is_absolute():
                path = run/path
            hashes[key] = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append(hashes)
    return dict(inputs_in_order=rows, seed=config.get('seed'),
                inference={key: config.get(key) for key in ('da3', 'mv', 'mesh_export')})


def camera_arrays(old, new):
    from da3_arrays import load_da3_arrays
    reports = {}
    with np.load(old/'da3/da3_output.npz', allow_pickle=False) as a, np.load(new/'da3/da3_output.npz', allow_pickle=False) as b:
        for name in ('depth', 'intrinsics', 'extrinsics'):
            x, y = a[name], b[name]
            same_shape = x.shape == y.shape
            reports[name] = dict(shape_old=list(x.shape), shape_new=list(y.shape),
                max_absolute_error=float(np.abs(x-y).max()) if same_shape else None,
                passed=same_shape and bool(np.allclose(x, y, rtol=1e-5, atol=1e-6)))
    x, y = load_da3_arrays(old/'da3/da3_output.npz')['pointmaps_sam3d'], load_da3_arrays(new/'da3/da3_output.npz')['pointmaps_sam3d']
    same_shape = x.shape == y.shape
    reports['pointmaps'] = dict(shape_old=list(x.shape), shape_new=list(y.shape),
        max_absolute_error=float(np.abs(x-y).max()) if same_shape else None,
        passed=same_shape and bool(np.allclose(x, y, rtol=1e-5, atol=1e-6)))
    return dict(passed=all(row['passed'] for row in reports.values()), arrays=reports)


def coordinate_contract(run):
    from cover_scene import load_scene, matrix_list
    stable = run/'asset.json'
    manifest = read_json(stable if stable.is_file() else run/'cover/preview.json')
    recommendation = read_json(run/'cover/preview.json')
    scene = load_scene(run)
    errors = {}
    for key, name in [('glb', 'mesh_transform'), ('gaussian', 'gaussian_transform')]:
        actual = np.asarray(manifest['assets'][key]['transform'])
        expected = np.asarray(matrix_list(scene[name]))
        dynamic = np.asarray(recommendation['assets'][key]['transform'])
        errors[key] = dict(derived_max_error=float(np.abs(actual-expected).max()),
                          recommendation_max_error=float(np.abs(actual-dynamic).max()))
    return manifest, dict(passed=all(max(row.values()) <= 1e-7 for row in errors.values()),
                          published=stable.is_file(), transforms=errors)


def material_report(mesh):
    material = getattr(mesh.visual, 'material', None)
    texture = getattr(material, 'baseColorTexture', None)
    result = dict(mode=mesh.visual.kind, pbr=isinstance(material, trimesh.visual.material.PBRMaterial),
                  texture_size=list(texture.size) if texture is not None else None,
                  metallic=getattr(material, 'metallicFactor', None), roughness=getattr(material, 'roughnessFactor', None))
    result['finite_uv'] = bool(mesh.visual.kind == 'texture' and np.isfinite(mesh.visual.uv).all())
    if texture is not None:
        rgb = np.asarray(texture.convert('RGB'), dtype=np.float32)/255.
        result['texture_rgb_mean'] = rgb.mean(axis=(0, 1)).tolist()
        result['texture_rgb_std'] = rgb.std(axis=(0, 1)).tolist()
    return result


class Surface:
    def __init__(self, run, manifest):
        import open3d as o3d
        self.o3d = o3d
        display = np.asarray(manifest['assets']['glb']['transform']).reshape(4, 4, order='F')
        scene = trimesh.load_scene(run/'reconstruction/result.glb', process=False)
        self.parts, self.offsets, self.materials = [], [], []
        vertices, faces = [], []
        vertex_offset = face_offset = 0
        for node in scene.graph.nodes_geometry:
            matrix, name = scene.graph[node]
            mesh = scene.geometry[name].copy()
            if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
                continue
            mesh.apply_transform(display @ matrix)
            self.parts.append(mesh); self.offsets.append(face_offset)
            self.materials.append(material_report(mesh))
            vertices.append(mesh.vertices); faces.append(mesh.faces+vertex_offset)
            vertex_offset += len(mesh.vertices); face_offset += len(mesh.faces)
        self.mesh = trimesh.Trimesh(vertices=np.concatenate(vertices), faces=np.concatenate(faces), process=False)
        if not np.isfinite(self.mesh.vertices).all():
            raise ValueError(f'{run.name}: nonfinite model geometry')
        self.query = o3d.t.geometry.RaycastingScene()
        self.query.add_triangles(o3d.core.Tensor(self.mesh.vertices.astype(np.float32)),
                                 o3d.core.Tensor(self.mesh.faces.astype(np.uint32)))

    def colors(self, face_ids, weights):
        colors = np.ones((len(face_ids), 3))
        for mesh, offset in zip(self.parts, self.offsets):
            take = (face_ids >= offset) & (face_ids < offset+len(mesh.faces))
            if not take.any():
                continue
            faces = mesh.faces[face_ids[take]-offset]
            w = weights[take, :, None]
            if mesh.visual.kind == 'texture':
                uv = (mesh.visual.uv[faces]*w).sum(axis=1)
                sampled = np.asarray(mesh.visual.material.to_color(uv))
                if sampled.ndim == 1:
                    sampled = np.broadcast_to(sampled, (len(uv), len(sampled)))
                colors[take] = sampled[:, :3]/255.
                factor = mesh.visual.material.baseColorFactor
                if factor is not None and mesh.visual.material.baseColorTexture is not None:
                    colors[take] *= np.asarray(factor[:3])/255.
            elif mesh.visual.kind == 'vertex':
                colors[take] = (mesh.visual.vertex_colors[faces, :3]/255.*w).sum(axis=1)
            else:
                colors[take] = mesh.visual.face_colors[face_ids[take]-offset, :3]/255.
        return colors

    def directed_difference(self, other, samples, diagonal):
        points, face_ids = trimesh.sample.sample_surface(self.mesh, samples, seed=42)
        weights = trimesh.triangles.points_to_barycentric(self.mesh.triangles[face_ids], points)
        closest = other.query.compute_closest_points(self.o3d.core.Tensor(points.astype(np.float32)))
        coordinates = closest['points'].numpy()
        uv = closest['primitive_uvs'].numpy()
        target_weights = np.column_stack((1-uv.sum(axis=1), uv))
        distances = np.linalg.norm(points-coordinates, axis=1)/diagonal
        color_error = np.abs(self.colors(face_ids, weights)-other.colors(closest['primitive_ids'].numpy(), target_weights)).mean(axis=1)
        return dict(samples=samples, surface_mean_fraction=float(distances.mean()),
                    surface_p99_fraction=float(np.quantile(distances, .99)), surface_max_fraction=float(distances.max()),
                    color_mean_absolute=float(color_error.mean()), color_p95_absolute=float(np.quantile(color_error, .95)))

    def support_hits(self, xz, height):
        rays = np.zeros((len(xz), 6), dtype=np.float32)
        rays[:, [0, 2]], rays[:, 1], rays[:, 4] = xz, height, -1
        return self.query.cast_rays(self.o3d.core.Tensor(rays))['t_hit'].numpy()


def support_comparison(a, b, diagonal, grid):
    lower = np.minimum(a.mesh.bounds[0], b.mesh.bounds[0])
    upper = np.maximum(a.mesh.bounds[1], b.mesh.bounds[1])
    steps = (np.arange(grid)+.5)/grid
    x, z = np.meshgrid(lower[0]+steps*(upper[0]-lower[0]), lower[2]+steps*(upper[2]-lower[2]))
    probes = [np.column_stack((x.ravel(), z.ravel()))]
    # Probe actual near-horizontal triangles too, including tiny support surfaces.
    for surface in (a, b):
        centers = surface.mesh.triangles_center[np.abs(surface.mesh.face_normals[:, 1]) >= .97]
        if len(centers):
            probes.append(centers[np.linspace(0, len(centers)-1, min(len(centers), 2048), dtype=int)][:, [0, 2]])
    xz = np.concatenate(probes)
    ha, hb = a.support_hits(xz, upper[1]+diagonal), b.support_hits(xz, upper[1]+diagonal)
    valid_a, valid_b = np.isfinite(ha), np.isfinite(hb)
    union, common = valid_a | valid_b, valid_a & valid_b
    agreement = float(common.sum()/union.sum()) if union.any() else 0.
    error = np.abs(ha[common]-hb[common])/diagonal
    p95, maximum = (float(np.quantile(error, .95)), float(error.max())) if len(error) else (None, None)
    return dict(passed=agreement >= THRESHOLDS['support_hit_agreement'] and p95 is not None
                and p95 <= THRESHOLDS['support_p95_diagonal_fraction'] and maximum <= THRESHOLDS['support_max_diagonal_fraction'],
                probes=len(xz), source_hits=int(valid_a.sum()), candidate_hits=int(valid_b.sum()),
                hit_agreement=agreement, height_p95_fraction=p95, height_max_fraction=maximum)


def cover_comparison(old, new):
    reports, views = [], []
    for run in (old, new):
        data = read_json(run/'cover/result.json')
        projection = data['projection']
        rows = {row['id']: row for row in projection['views']}
        views.append(rows)
        scores = [row['mask_iou'] for row in rows.values()]
        reports.append(dict(status=data['status'], projection_status=projection['status'], best_id=(data.get('best') or {}).get('id'),
                            min_mask_iou=min(scores), median_mask_iou=float(np.median(scores)),
                            all_in_front=all(row['center_in_front'] for row in rows.values())))
    same_views = views[0].keys() == views[1].keys()
    deltas = {key: views[1][key]['mask_iou']-row['mask_iou'] for key, row in views[0].items() if key in views[1]}
    return dict(passed=same_views and all(row['status'] == 'complete' and row['projection_status'] == 'passed'
                and row['all_in_front'] and row['min_mask_iou'] >= .1 and row['median_mask_iou'] >= .25 for row in reports)
                and bool(deltas) and min(deltas.values()) >= -THRESHOLDS['cover_max_iou_drop'],
                runs=reports, mask_iou_delta_by_view=deltas,
                note='Projection catches coordinate errors; recommendation identity may change near score ties.')


def compare(old, new, samples=4096, grid=65):
    pa, pb = provenance(old), provenance(new)
    ma, ca = coordinate_contract(old)
    mb, cb = coordinate_contract(new)
    a, b = Surface(old, ma), Surface(new, mb)
    diagonal = float(np.linalg.norm(a.mesh.extents))
    if diagonal <= 0:
        raise ValueError('Baseline has no measurable model extent')
    directions = [a.directed_difference(b, samples, diagonal), b.directed_difference(a, samples, diagonal)]
    bounds_error = float(np.abs(a.mesh.bounds-b.mesh.bounds).max())/diagonal
    material_ok = all(row['pbr'] and row['texture_size'] and row['finite_uv'] for row in a.materials+b.materials)
    signature = lambda row: (row['pbr'], row['texture_size'], row['metallic'], row['roughness'])
    checks = dict(
        provenance=dict(passed=pa == pb and pa['seed'] is not None, old=pa, new=pb),
        coordinate_contract=dict(passed=ca['passed'] and cb['passed'], old=ca, new=cb),
        camera_and_pointmaps=camera_arrays(old, new),
        geometry=dict(passed=bounds_error <= THRESHOLDS['bounds_diagonal_fraction'] and all(
            row['surface_p99_fraction'] <= THRESHOLDS['surface_p99_diagonal_fraction']
            and row['surface_max_fraction'] <= THRESHOLDS['surface_max_diagonal_fraction'] for row in directions),
            source_faces=len(a.mesh.faces), candidate_faces=len(b.mesh.faces), baseline_diagonal=diagonal,
            bounds_old=a.mesh.bounds.tolist(), bounds_new=b.mesh.bounds.tolist(), bounds_error_fraction=bounds_error,
            source_to_candidate=directions[0], candidate_to_source=directions[1]),
        support=support_comparison(a, b, diagonal, grid),
        pbr=dict(passed=material_ok and [signature(row) for row in a.materials] == [signature(row) for row in b.materials]
            and all(row['color_mean_absolute'] <= THRESHOLDS['surface_color_mean_absolute'] for row in directions),
            old=a.materials, new=b.materials, note='Texture UVs may be repacked; compare sampled surface colour, not raw texture pixels.'),
        cover=cover_comparison(old, new))
    return dict(status='passed' if all(check['passed'] for check in checks.values()) else 'review_required',
        old_run=str(old), new_run=str(new), thresholds=THRESHOLDS, checks=checks,
        limitations=['Geometry probes sample surfaces; they do not prove every thin part or hole is unchanged.',
                    'Vertical rays compare topmost support heights, not hidden undersides or full collision behaviour.',
                    'Surface colour is a texture sanity check, not a rendered perceptual-quality score.',
                    'One fixed-seed pair bounds this run difference; it does not characterize GPU randomness over many seeds.',
                    'COVER mask IoU is a projection sanity check, not reconstruction accuracy against ground truth.'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-run', type=Path, required=True)
    parser.add_argument('--new-run', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=4096)
    parser.add_argument('--support-grid', type=int, default=65)
    args = parser.parse_args()
    if args.samples < 64 or args.support_grid < 8:
        parser.error('Use at least 64 surface samples and an 8x8 support grid')
    try:
        report = compare(args.old_run.resolve(), args.new_run.resolve(), args.samples, args.support_grid)
    except Exception as exc:
        report = dict(status='error', error=f'{type(exc).__name__}: {exc}')
    args.output.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2)+'\n')
    print(json.dumps(dict(status=report['status'], output=str(args.output),
                         checks={key: row['passed'] for key, row in report.get('checks', {}).items()},
                         **({'error': report['error']} if 'error' in report else {}))))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    sys.exit(main())
