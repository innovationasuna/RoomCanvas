"""Native colour baking must preserve geometry and retain an honest material contract."""
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from mvsam_pbr import baked_export, export_settings, native_baking_support, pad_texture


class BakedExportTests(unittest.TestCase):
    def test_default_and_invalid_options(self):
        self.assertIsNone(export_settings({}))
        for options in [dict(mode='unknown'), dict(mode='baked_pbr', texture_size=123),
                        dict(mode='baked_pbr', roughness=-.1), dict(mode='baked_pbr', metallic=float('nan'))]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                export_settings(dict(mesh_export=options))

    def test_native_export_retains_a_control_and_only_changes_material(self):
        source = trimesh.creation.box()
        calls = []
        def native(app, mesh, **options):
            self.assertIs(mesh, source)
            calls.append(options)
            out = source.copy()
            if options['with_texture_baking']:
                out.visual = trimesh.visual.TextureVisuals(uv=np.zeros((len(out.vertices), 2)),
                    material=trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new('RGB', (4, 4), 'red')))
            else:
                out.visual.vertex_colors = [220, 10, 10, 255]
            return out
        module = SimpleNamespace(to_glb=native)
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            settings = export_settings(dict(mesh_export=dict(mode='baked_pbr')))
            with baked_export(module, folder, settings) as receipt:
                result = module.to_glb(None, source, with_mesh_postprocess=True, with_texture_baking=False)
            self.assertIs(module.to_glb, native)
            np.testing.assert_array_equal(source.vertices, result.vertices)
            np.testing.assert_array_equal(source.faces, result.faces)
            self.assertTrue((folder/'vertex-color.glb').exists())
            self.assertEqual(receipt['status'], 'complete')
            self.assertFalse(receipt['predicted_material_maps'])
            self.assertEqual((result.visual.material.roughnessFactor, result.visual.material.metallicFactor), (1., 0.))
            self.assertEqual([c['with_texture_baking'] for c in calls], [False, True])
            self.assertTrue(all(c['with_mesh_postprocess'] is False for c in calls))
            self.assertEqual(calls[1]['texture_size'], 2048)

    def test_failure_does_not_silently_fall_back_or_keep_the_override(self):
        def native(*args, **kwargs):
            raise RuntimeError('rasterizer failed')
        module = SimpleNamespace(to_glb=native)
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            with self.assertRaisesRegex(RuntimeError, 'rasterizer failed'):
                with baked_export(module, folder, export_settings(dict(mesh_export=dict(mode='baked_pbr')))):
                    module.to_glb(None, None)
            self.assertIs(module.to_glb, native)
            self.assertEqual(json.loads((folder/'materials.json').read_text())['status'], 'failed')

    def test_uv_cache_checks_source_geometry_and_restores_native_functions(self):
        calls = []
        def uv(vertices, faces):
            calls.append(True)
            return vertices, faces, np.zeros((len(vertices), 2))
        original_views = object()
        module = SimpleNamespace(parametrize_mesh=uv, render_multiview=original_views)
        vertices, faces = np.zeros((3, 3)), np.array([[0, 1, 2]])
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(RuntimeError, 'after UV'):
                with native_baking_support(module, temporary):
                    module.parametrize_mesh(vertices, faces)
                    module.parametrize_mesh(vertices, faces)
                    self.assertEqual(len(calls), 1)
                    module.parametrize_mesh(vertices+1, faces)
                    self.assertEqual(len(calls), 2)
                    raise RuntimeError('after UV')
            self.assertIs(module.parametrize_mesh, uv)
            self.assertIs(module.render_multiview, original_views)

    def test_padding_fills_gaps_without_changing_observed_texture(self):
        image = np.arange(27, dtype=np.uint8).reshape(3, 3, 3)
        mask = np.ones((3, 3), dtype=np.uint8)
        mask[1, 1] = 0
        padded = pad_texture(image, mask)
        np.testing.assert_array_equal(padded, np.broadcast_to(image[1, 1], image.shape))
        np.testing.assert_array_equal(image, np.arange(27, dtype=np.uint8).reshape(3, 3, 3))
        with self.assertRaisesRegex(ValueError, 'no covered UV'):
            pad_texture(image, np.ones((3, 3)))


if __name__ == '__main__':
    unittest.main()
