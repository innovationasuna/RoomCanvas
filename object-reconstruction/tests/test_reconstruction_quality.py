import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from check_reconstruction_quality import Surface, camera_arrays, provenance, support_comparison, explain_support_edges


def textured_box():
    mesh = trimesh.creation.box()
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new('RGB', (4, 4), (100, 150, 200)),
        baseColorFactor=[128, 255, 255, 255], metallicFactor=0., roughnessFactor=1.)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.zeros((len(mesh.vertices), 2)), material=material)
    return mesh


class QualityHelpersTests(unittest.TestCase):
    def test_float64_vertical_reference_independently_finds_top_surface(self):
        surface = Surface.__new__(Surface)
        surface.mesh = trimesh.creation.box()
        self.assertAlmostEqual(surface.vertical_reference(np.array([0., 0.]))['height'], .5)
        self.assertIsNone(surface.vertical_reference(np.array([2., 2.]))['height'])
        surface.mesh.apply_translation([0, .2, 0])
        self.assertAlmostEqual(surface.vertical_reference(np.array([0., 0.]))['height'], .7)

    def test_surface_colour_includes_pbr_factor_and_does_not_depend_on_face_order(self):
        surface = Surface.__new__(Surface)
        surface.parts, surface.offsets = [textured_box()], [0]
        result = surface.colors(np.array([3, 0]), np.array([[.2, .3, .5], [1, 0, 0]]))
        expected = np.tile([100/255*128/255, 150/255, 200/255], (2, 1))
        np.testing.assert_allclose(result, expected)

    def test_provenance_compares_content_and_order_not_run_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            runs = [Path(temp)/name for name in ('old', 'new')]
            for run in runs:
                run.mkdir()
                (run/'photo').write_bytes(b'photo')
                (run/'mask').write_bytes(b'mask')
                (run/'inputs.json').write_text(json.dumps(dict(images=[dict(image=str(run/'photo'), mask=str(run/'mask'))])))
                (run/'config.yaml').write_text('seed: 42\nmv: {stage1_steps: 50}\n')
            self.assertEqual(provenance(runs[0]), provenance(runs[1]))
            (runs[1]/'photo').write_bytes(b'other')
            self.assertNotEqual(provenance(runs[0]), provenance(runs[1]))

    def test_camera_gate_handles_old_and_new_layouts_and_rejects_drift(self):
        with tempfile.TemporaryDirectory() as temp:
            old, new = Path(temp)/'old', Path(temp)/'new'
            old.joinpath('da3').mkdir(parents=True); new.joinpath('da3').mkdir(parents=True)
            depth = np.ones((1, 4, 5), dtype=np.float32)
            points = np.ones((1, 4, 5, 3), dtype=np.float32)
            camera = dict(depth=depth, extrinsics=np.eye(4)[None], intrinsics=np.eye(3)[None])
            np.savez(old/'da3/da3_output.npz', **camera, pointmaps_sam3d=points.transpose(0, 3, 1, 2).astype(float))
            np.savez(new/'da3/da3_output.npz', **camera, pointmaps=points)
            self.assertTrue(camera_arrays(old, new)['passed'])
            points[0, 1, 2, 0] += .1
            np.savez(new/'da3/da3_output.npz', **camera, pointmaps=points)
            self.assertFalse(camera_arrays(old, new)['passed'])

    @unittest.skipUnless(importlib.util.find_spec('open3d'), 'requires reconstruction environment Open3D')
    def test_real_triangle_queries_accept_equal_and_reject_shifted_supports(self):
        with tempfile.TemporaryDirectory() as temp:
            surfaces = []
            for name, shift in [('baseline', 0.), ('same', 0.), ('shifted', .2)]:
                run = Path(temp)/name
                (run/'reconstruction').mkdir(parents=True)
                mesh = textured_box()
                mesh.apply_translation([shift, 0, 0])
                mesh.export(run/'reconstruction/result.glb')
                surfaces.append(Surface(run, dict(assets=dict(glb=dict(transform=np.eye(4).flatten().tolist())))))
            a, same, moved = surfaces
            diagonal = np.linalg.norm(a.mesh.extents)
            difference = a.directed_difference(same, 128, diagonal)
            self.assertLess(difference['surface_max_fraction'], 1e-6)
            self.assertLess(difference['color_mean_absolute'], 1e-6)
            self.assertTrue(support_comparison(a, same, diagonal, 16)['passed'])
            self.assertFalse(support_comparison(a, moved, diagonal, 16)['passed'])
            # A genuine broad support-height regression stays in the strict interior set.
            run = Path(temp)/'raised'
            (run/'reconstruction').mkdir(parents=True)
            mesh = textured_box(); mesh.apply_translation([0, .2, 0])
            mesh.export(run/'reconstruction/result.glb')
            raised = Surface(run, dict(assets=dict(glb=dict(transform=np.eye(4).flatten().tolist()))))
            support = support_comparison(a, raised, diagonal, 16)
            self.assertFalse(support['passed'])
            self.assertFalse(support['diagnostics']['stable_interior']['passed'])
            self.assertGreater(support['diagnostics']['stable_interior']['raw_failures_included'], 0)

    @unittest.skipUnless(importlib.util.find_spec('open3d'), 'requires reconstruction environment Open3D')
    def test_moved_or_missing_slope_cannot_hide_behind_unchanged_horizontal_supports(self):
        with tempfile.TemporaryDirectory() as temp:
            base = trimesh.creation.box(extents=[1, .1, 1]); base.apply_translation([-1.5, -.05, 0])
            lower = trimesh.creation.box(extents=[1.5, .1, 1]); lower.apply_translation([1.5, -.05, 0])
            slope = trimesh.creation.box(extents=[1, .1, 1])
            slope.apply_transform(trimesh.transformations.rotation_matrix(np.pi/4, [0, 0, 1]))
            slope.apply_translation([1.5, .7, 0])
            raised = slope.copy(); raised.apply_translation([0, .4, 0])
            surfaces = []
            for name, parts in [('old', [base, lower, slope]), ('raised', [base, lower, raised]), ('missing', [base, lower])]:
                run = Path(temp)/name
                (run/'reconstruction').mkdir(parents=True)
                trimesh.util.concatenate(parts).export(run/'reconstruction/result.glb')
                surfaces.append(Surface(run, dict(assets=dict(glb=dict(transform=np.eye(4).flatten().tolist())))))
            baseline, *candidates = surfaces
            diagonal = np.linalg.norm(baseline.mesh.extents)
            for candidate in candidates:
                result = support_comparison(baseline, candidate, diagonal, 24)
                self.assertFalse(result['passed'])
                self.assertTrue(result['diagnostics']['stable_interior']['passed'])
                explanation = result['diagnostics']['edge_explanations']
                self.assertFalse(explanation['passed'])
                self.assertGreater(result['diagnostics']['raw_max_failures'], 20)
                self.assertGreaterEqual(explanation['total'], result['diagnostics']['raw_max_failures'])
                self.assertEqual(len(explanation['records']), explanation['total'])
                self.assertGreater(explanation['unexplained'], 20)

    @unittest.skipUnless(importlib.util.find_spec('open3d'), 'requires reconstruction environment Open3D')
    def test_small_boundary_switch_requires_both_near_surfaces_and_all_ring_matches(self):
        with tempfile.TemporaryDirectory() as temp:
            lower = trimesh.creation.box(extents=[2, .1, 2]); lower.apply_translation([0, -.05, 0])
            angle = .3
            normal = np.array([np.cos(angle), -np.sin(angle)])
            upper = trimesh.creation.box(extents=[1, .1, 1])
            upper.apply_transform(trimesh.transformations.rotation_matrix(angle, [0, 1, 0]))
            upper.apply_translation([.5, .95, 0])
            shifted = upper.copy(); shifted.apply_translation([normal[0]*2e-6, 0, normal[1]*2e-6])
            surfaces = []
            for name, part in [('old', upper), ('new', shifted)]:
                run = Path(temp)/name
                (run/'reconstruction').mkdir(parents=True)
                trimesh.util.concatenate([lower, part]).export(run/'reconstruction/result.glb')
                surfaces.append(Surface(run, dict(assets=dict(glb=dict(transform=np.eye(4).flatten().tolist())))))
            a, b = surfaces
            diagonal = np.linalg.norm(a.mesh.extents)
            # Just inside the old upper layer, just outside the shifted upper layer.
            xz = (np.array([.5, 0])-normal*.5+normal*1e-6)[None]
            old, new = a.support_hits(xz, 3.), b.support_hits(xz, 3.)
            self.assertGreater(abs(old[0]-new[0])/diagonal, .05)
            result = explain_support_edges(a, b, xz, 3., diagonal, old, new)
            self.assertTrue(result['passed'])
            self.assertEqual((result['total'], result['explained']), (1, 1))
            self.assertEqual(result['records'][0]['ring_matching_hits'], 8)


if __name__ == '__main__':
    unittest.main()
