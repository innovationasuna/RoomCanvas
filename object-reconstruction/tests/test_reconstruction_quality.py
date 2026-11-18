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
from check_reconstruction_quality import Surface, camera_arrays, provenance, support_comparison


def textured_box():
    mesh = trimesh.creation.box()
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new('RGB', (4, 4), (100, 150, 200)),
        baseColorFactor=[128, 255, 255, 255], metallicFactor=0., roughnessFactor=1.)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.zeros((len(mesh.vertices), 2)), material=material)
    return mesh


class QualityHelpersTests(unittest.TestCase):
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


if __name__ == '__main__':
    unittest.main()
