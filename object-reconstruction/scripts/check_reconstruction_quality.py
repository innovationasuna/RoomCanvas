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
                  support_edge_nearest_fraction=1e-4, support_edge_radius_fraction=1e-4,
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

    def support_intersections(self, xz, height):
        rays = np.zeros((len(xz), 6), dtype=np.float32)
        rays[:, [0, 2]], rays[:, 1], rays[:, 4] = xz, height, -1
        return {key: value.numpy() for key, value in self.query.cast_rays(self.o3d.core.Tensor(rays)).items()}

    def support_hits(self, xz, height):
        return self.support_intersections(xz, height)['t_hit']

    def vertical_reference(self, xz):
        """Independent float64 triangle intersection for a small number of disputed rays."""
        triangles = self.mesh.triangles
        if not hasattr(self, '_xz_bounds'):
            coordinates = triangles[:, :, [0, 2]]
            self._xz_bounds = coordinates.min(axis=1), coordinates.max(axis=1)
        lower, upper = self._xz_bounds
        candidates = np.flatnonzero(((lower <= xz) & (upper >= xz)).all(axis=1))
        tri = triangles[candidates]
        a, b, p = tri[:, 1, [0, 2]]-tri[:, 0, [0, 2]], tri[:, 2, [0, 2]]-tri[:, 0, [0, 2]], xz-tri[:, 0, [0, 2]]
        determinant = a[:, 0]*b[:, 1]-a[:, 1]*b[:, 0]
        usable = np.abs(determinant) > 1e-18
        u, v = np.zeros(len(tri)), np.zeros(len(tri))
        u[usable] = (p[usable, 0]*b[usable, 1]-p[usable, 1]*b[usable, 0])/determinant[usable]
        v[usable] = (a[usable, 0]*p[usable, 1]-a[usable, 1]*p[usable, 0])/determinant[usable]
        inside = usable & (u >= -1e-10) & (v >= -1e-10) & (u+v <= 1+1e-10)
        if not inside.any():
            return dict(height=None, candidates=len(candidates))
        ys = tri[:, 0, 1]+u*(tri[:, 1, 1]-tri[:, 0, 1])+v*(tri[:, 2, 1]-tri[:, 0, 1])
        hit = np.flatnonzero(inside)[np.argmax(ys[inside])]
        return dict(height=float(ys[hit]), triangle=int(candidates[hit]), candidates=len(candidates),
                    barycentric=[float(1-u[hit]-v[hit]), float(u[hit]), float(v[hit])])


OFFSETS = np.array([[1, 0], [-1, 0], [0, 1], [0, -1],
                    [1, 1], [1, -1], [-1, 1], [-1, -1]], dtype=float)
OFFSETS /= np.linalg.norm(OFFSETS, axis=1, keepdims=True)


def neighborhood(a, b, xz, height, radius):
    points = xz[:, None, :]+OFFSETS[None, :, :]*radius
    points = np.concatenate([xz[:, None, :], points], axis=1)
    shape = points.shape[:2]
    old = a.support_hits(points.reshape(-1, 2), height).reshape(shape)
    new = b.support_hits(points.reshape(-1, 2), height).reshape(shape)
    return old, new


def explain_support_edges(a, b, xz, height, diagonal, old, new):
    """Explain every height exceedance, independently of the top-N diagnostic display."""
    common = np.isfinite(old) & np.isfinite(new)
    ids = np.flatnonzero(common)
    errors = np.abs(old[common]-new[common])/diagonal
    # Inspect all samples above the original 2% height tolerance, including the
    # subset exceeding the original 5% maximum; never inspect just the top 20.
    ids = ids[errors > THRESHOLDS['support_p95_diagonal_fraction']]
    rule = dict(height_exceedance_fraction=THRESHOLDS['support_p95_diagonal_fraction'],
                nearest_surface_fraction=THRESHOLDS['support_edge_nearest_fraction'],
                ring_radius_fraction=THRESHOLDS['support_edge_radius_fraction'],
                ring_rays=8, all_ring_rays_hit_in_both=True,
                ring_max_height_difference_fraction=THRESHOLDS['support_p95_diagonal_fraction'])
    if not len(ids):
        return dict(passed=True, total=0, explained=0, unexplained=0, rule=rule, records=[])
    origins = xz[ids].astype(np.float32)
    cross_distances = []
    for hits, target in ((old, b), (new, a)):
        points = np.column_stack((origins[:, 0], np.float32(height)-hits[ids], origins[:, 1])).astype(np.float32)
        nearest = target.query.compute_closest_points(target.o3d.core.Tensor(points))['points'].numpy()
        cross_distances.append(np.linalg.norm(points-nearest, axis=1)/diagonal)
    ha, hb = neighborhood(a, b, origins.astype(float), height,
                          diagonal*THRESHOLDS['support_edge_radius_fraction'])
    # The center is intentionally reported separately: the ring must agree on
    # the same topmost layer in both models on all eight sides of that center.
    ring_a, ring_b = ha[:, 1:], hb[:, 1:]
    matches = np.isfinite(ring_a) & np.isfinite(ring_b)
    all_hit = matches.all(axis=1)
    gaps = np.full(ring_a.shape, np.inf)
    gaps[matches] = np.abs(ring_a[matches]-ring_b[matches])/diagonal
    maxima = gaps.max(axis=1)
    records = []
    for index, probe in enumerate(ids):
        near = [float(values[index]) for values in cross_distances]
        reasons = []
        if max(near) > rule['nearest_surface_fraction']:
            reasons.append('opposite_surface_too_far')
        if not all_hit[index]:
            reasons.append('ring_missing_hits')
        elif maxima[index] > rule['ring_max_height_difference_fraction']:
            reasons.append('ring_height_disagreement')
        records.append(dict(probe=int(probe), xz=origins[index].tolist(), explained=not reasons,
            reason='small_boundary_layer_switch' if not reasons else ','.join(reasons),
            height_difference_fraction=float(abs(old[probe]-new[probe])/diagonal),
            exceeds_raw_maximum=bool(abs(old[probe]-new[probe])/diagonal > THRESHOLDS['support_max_diagonal_fraction']),
            nearest_cross_surface_fractions=near, ring_matching_hits=int(matches[index].sum()),
            ring_max_height_difference_fraction=float(maxima[index]) if np.isfinite(maxima[index]) else None))
    explained = sum(row['explained'] for row in records)
    return dict(passed=explained == len(records), total=len(records), explained=explained,
                unexplained=len(records)-explained, rule=rule, records=records)


def support_diagnostics(a, b, xz, height, diagonal, hit_a, hit_b, grid_count, old_center_count):
    old, new = hit_a['t_hit'], hit_b['t_hit']
    common = np.isfinite(old) & np.isfinite(new)
    ids = np.flatnonzero(common)
    errors = np.abs(old[common]-new[common])/diagonal
    edge_explanations = explain_support_edges(a, b, xz, height, diagonal, old, new)
    selected = ids[np.argsort(errors)[-20:][::-1]]
    records = []
    for index in selected:
        # Match the actual float32 ray origin sent to Open3D, not an unrounded copy.
        origin = xz[index].astype(np.float32).astype(float)
        ys = [float(np.float32(height)-hits['t_hit'][index]) for hits in (hit_a, hit_b)]
        p = [np.array([origin[0], y, origin[1]], dtype=np.float32) for y in ys]
        nearest = []
        for point, surface in zip(p, (b, a)):
            answer = surface.query.compute_closest_points(surface.o3d.core.Tensor(point[None]))
            closest = answer['points'].numpy()[0]
            nearest.append(dict(point=closest.tolist(), distance_fraction=float(np.linalg.norm(point-closest)/diagonal),
                                normal=answer['primitive_normals'].numpy()[0].tolist()))
        neighborhoods = []
        for fraction in (1e-6, 1e-5, 1e-4, 1e-3):
            ha, hb = neighborhood(a, b, origin[None], height, diagonal*fraction)
            ha, hb = ha[0], hb[0]
            valid = np.isfinite(ha) & np.isfinite(hb)
            span = lambda values: float(np.ptp(values[np.isfinite(values)])/diagonal) if np.isfinite(values).any() else None
            delta = np.abs(ha[valid]-hb[valid])/diagonal
            neighborhoods.append(dict(radius_fraction=fraction, common_hits=int(valid.sum()),
                old_height_span_fraction=span(ha), new_height_span_fraction=span(hb),
                max_difference_fraction=float(delta.max()) if len(delta) else None,
                old_heights=[float(np.float32(height)-value) if np.isfinite(value) else None for value in ha],
                new_heights=[float(np.float32(height)-value) if np.isfinite(value) else None for value in hb]))
        discontinuity = any(any(row[key] is not None and row[key] > THRESHOLDS['support_p95_diagonal_fraction']
            for key in ('old_height_span_fraction', 'new_height_span_fraction')) for row in neighborhoods)
        close_surfaces = all(row['distance_fraction'] <= 1e-4 for row in nearest)
        records.append(dict(probe=int(index), source='grid' if index < grid_count else
                'old_horizontal_triangle' if index < grid_count+old_center_count else 'new_horizontal_triangle',
            xz=origin.tolist(), old_height=ys[0], new_height=ys[1], height_difference_fraction=float(abs(ys[0]-ys[1])/diagonal),
            old_normal=hit_a['primitive_normals'][index].tolist(), new_normal=hit_b['primitive_normals'][index].tolist(),
            old_barycentric_uv=hit_a['primitive_uvs'][index].tolist(), new_barycentric_uv=hit_b['primitive_uvs'][index].tolist(),
            float64_reference_old=a.vertical_reference(origin), float64_reference_new=b.vertical_reference(origin),
            old_hit_nearest_new=nearest[0], new_hit_nearest_old=nearest[1], neighborhoods=neighborhoods,
            classification='edge_or_depth_discontinuity' if discontinuity and close_surfaces else
                'surface_displacement' if not close_surfaces else 'stable_height_comparison'))
    ha, hb = neighborhood(a, b, xz, height, diagonal*.001)
    all_hit = np.isfinite(ha).all(axis=1) & np.isfinite(hb).all(axis=1)
    stable = np.zeros(len(xz), dtype=bool)
    stable[all_hit] = (np.ptp(ha[all_hit], axis=1)/diagonal <= .02) & (np.ptp(hb[all_hit], axis=1)/diagonal <= .02)
    horizontal = (np.abs(hit_a['primitive_normals'][:, 1]) >= .97) & (np.abs(hit_b['primitive_normals'][:, 1]) >= .97)
    interior = stable & horizontal & common
    interior_error = np.abs(old[interior]-new[interior])/diagonal
    raw_failures = common.copy()
    raw_failures[common] = errors > THRESHOLDS['support_max_diagonal_fraction']
    maximum = float(interior_error.max()) if len(interior_error) else None
    return dict(top_height_differences=records, raw_max_failures=int(raw_failures.sum()), edge_explanations=edge_explanations,
        stable_interior=dict(rule=dict(radius_diagonal_fraction=.001, offsets=OFFSETS.tolist(),
            all_nine_rays_hit_in_both=True, max_height_span_in_each=.02, min_abs_normal_y=.97),
            probes=int(interior.sum()), excluded_probes=int((common & ~interior).sum()),
            raw_failures_included=int((raw_failures & interior).sum()), raw_failures_excluded=int((raw_failures & ~interior).sum()),
            height_p95_fraction=float(np.quantile(interior_error, .95)) if len(interior_error) else None,
            height_max_fraction=maximum, passed=len(interior_error) >= 32 and maximum <= THRESHOLDS['support_max_diagonal_fraction']
                and float(np.quantile(interior_error, .95)) <= THRESHOLDS['support_p95_diagonal_fraction']),
        note='The gate uses stable horizontal supports and hit agreement. Every raw height exceedance must also satisfy the explicit boundary explanation; the top 20 are display-only.')


def support_comparison(a, b, diagonal, grid):
    lower = np.minimum(a.mesh.bounds[0], b.mesh.bounds[0])
    upper = np.maximum(a.mesh.bounds[1], b.mesh.bounds[1])
    steps = (np.arange(grid)+.5)/grid
    x, z = np.meshgrid(lower[0]+steps*(upper[0]-lower[0]), lower[2]+steps*(upper[2]-lower[2]))
    probes = [np.column_stack((x.ravel(), z.ravel()))]
    # Probe actual near-horizontal triangles too, including tiny support surfaces.
    center_counts = []
    for surface in (a, b):
        centers = surface.mesh.triangles_center[np.abs(surface.mesh.face_normals[:, 1]) >= .97]
        if len(centers):
            probes.append(centers[np.linspace(0, len(centers)-1, min(len(centers), 2048), dtype=int)][:, [0, 2]])
        center_counts.append(min(len(centers), 2048))
    xz = np.concatenate(probes)
    height = upper[1]+diagonal
    hit_a, hit_b = a.support_intersections(xz, height), b.support_intersections(xz, height)
    ha, hb = hit_a['t_hit'], hit_b['t_hit']
    valid_a, valid_b = np.isfinite(ha), np.isfinite(hb)
    union, common = valid_a | valid_b, valid_a & valid_b
    agreement = float(common.sum()/union.sum()) if union.any() else 0.
    error = np.abs(ha[common]-hb[common])/diagonal
    p95, maximum = (float(np.quantile(error, .95)), float(error.max())) if len(error) else (None, None)
    raw_passed = agreement >= THRESHOLDS['support_hit_agreement'] and p95 is not None \
        and p95 <= THRESHOLDS['support_p95_diagonal_fraction'] and maximum <= THRESHOLDS['support_max_diagonal_fraction']
    diagnostics = support_diagnostics(a, b, xz, height, diagonal, hit_a, hit_b, grid*grid, center_counts[0])
    passed = agreement >= THRESHOLDS['support_hit_agreement'] and diagnostics['stable_interior']['passed'] \
        and diagnostics['edge_explanations']['passed']
    return dict(passed=passed, gate='stable_horizontal_supports_and_hit_agreement_with_explained_boundaries',
                raw=dict(passed=raw_passed, height_p95_fraction=p95, height_max_fraction=maximum,
                         max_failures=diagnostics['raw_max_failures']),
                probes=len(xz), source_hits=int(valid_a.sum()), candidate_hits=int(valid_b.sum()),
                hit_agreement=agreement, height_p95_fraction=p95, height_max_fraction=maximum,
                diagnostics=diagnostics)


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
