"""The shared TRELLIS adapter's photo, artifact, calibration and failure contracts (CPU)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
import trimesh
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import run
import run_trellis
from dimensions import geometry, metric_glb, save_dimensions
from reconstruction_backends import BACKENDS, backend_name, capabilities, pipeline_stages, run_backend, validate_selection


def textured_box():
    mesh = trimesh.creation.box(extents=[2, 3, 4])
    material = trimesh.visual.material.PBRMaterial(
        baseColorTexture=Image.new('RGB', (4, 4), (180, 70, 20)),
        metallicRoughnessTexture=Image.new('RGB', (4, 4), (255, 140, 30)),
        roughnessFactor=.6, metallicFactor=.2)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.zeros((len(mesh.vertices), 2)), material=material)
    return mesh.export(file_type='glb')


class TrellisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root/'run'
        self.directory.mkdir()
        self.photo = self.root/'photo.png'
        self.mask = self.root/'mask.png'
        Image.new('RGB', (8, 6), (0, 0, 0)).save(self.photo)
        mask = Image.new('RGBA', (8, 6), (0, 255, 0, 0))
        mask.paste((0, 255, 0, 255), (2, 1, 6, 5))
        mask.save(self.mask)
        self.inputs = dict(input_dir=str(self.root), images=[
            dict(name='000001', source_name='chair', image=str(self.photo), mask=str(self.mask))])

    def test_confirmed_alpha_preserves_black_foreground_and_discards_mask_rgb(self):
        reference = self.root/'reference.png'
        receipt = run_trellis.prepare_reference(self.inputs, reference)
        with Image.open(reference) as image:
            self.assertEqual(image.mode, 'RGBA')
            self.assertEqual(image.getpixel((image.width//2, image.height//2)), (0, 0, 0, 255))
            self.assertEqual(image.getpixel((0, 0))[3], 0)
        self.assertEqual(receipt['source_image_id'], 'chair')
        self.assertEqual(receipt['crop'], [2, 1, 6, 5])

    def test_no_silent_multiview_or_capture_fallback(self):
        for photos, parent in [([], None), (['a'], 'old')]:
            with self.assertRaises(ValueError):
                validate_selection('trellis', photos, parent)
        validate_selection('trellis', ['a'])
        validate_selection('mvsam3d', ['a', 'b'], 'old')
        with self.assertRaises(ValueError):
            backend_name('unknown')
        self.assertFalse(capabilities('trellis')['cover'])
        self.assertFalse(capabilities('trellis')['gaussian'])
        self.inputs['images'].append(dict(self.inputs['images'][0], source_name='unused_view'))
        receipt = run_trellis.prepare_reference(self.inputs, self.root/'reference.png')
        self.assertEqual(receipt['source_image_id'], 'chair')
        self.assertEqual(receipt['unused_image_ids'], ['unused_view'])

    def test_stage_dispatch_skips_da3_and_does_not_require_gaussian(self):
        commands = run.stage_commands(self.root, self.directory, {'backend': 'trellis'}, self.inputs)
        self.assertEqual([name for name, _ in commands], ['reconstruction'])
        self.assertIn('run_trellis.py', commands[0][1][1])
        (self.directory/'logs').mkdir()
        (self.directory/'reconstruction').mkdir()
        (self.directory/'reconstruction/result.glb').write_bytes(textured_box())
        result = {}
        with patch.object(run.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            run.execute(self.directory, commands, result, 'trellis')
        self.assertEqual(result['status'], 'complete')
        with patch.object(run.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaisesRegex(RuntimeError, 'result.ply'):
                run.execute(self.directory, [], {}, 'mvsam3d')

    def test_shared_launcher_output_preserves_pbr_through_metric_export(self):
        source = self.root/'source.glb'
        source.write_bytes(textured_box())
        # A real subprocess stands in for GPU inference. Everything around it is production code.
        launcher = self.root/'launcher.py'
        launcher.write_text('import sys\nfrom pathlib import Path\n'
                            f'Path(sys.argv[sys.argv.index("-o")+1]).write_bytes(Path({str(source)!r}).read_bytes())\n')
        (self.directory/'inputs.json').write_text(json.dumps(self.inputs))
        (self.directory/'config.yaml').write_text(yaml.safe_dump(dict(seed=42)))
        with patch.object(run_trellis, 'runtime_paths', return_value=(self.root, Path(sys.executable), launcher)), \
             patch.object(run_trellis, 'CHECKOUT', self.root), \
             patch.object(sys, 'argv', ['run_trellis.py', '--run-dir', str(self.directory)]):
            run_trellis.main()
        model = self.directory/'reconstruction/result.glb'
        self.assertEqual(model.read_bytes(), source.read_bytes())
        manifest = json.loads((self.directory/'cover/preview.json').read_text())
        self.assertIsNone(manifest['recommendation'])
        self.assertNotIn('gaussian', manifest['assets'])
        self.assertFalse((self.directory/'reconstruction/preview.glb').exists())
        self.assertEqual(geometry(self.directory)['lengths'], {'X': 2., 'Y': 4., 'Z': 3.})
        save_dimensions(self.directory, 'Z', .6, 'm')
        scaled = metric_glb(self.directory)
        original = trimesh.load_scene(model, process=False)
        exported = trimesh.load_scene(scaled, process=False)
        self.assertAlmostEqual(exported.extents[1], .6)
        old_mat = next(iter(original.geometry.values())).visual.material
        new_mat = next(iter(exported.geometry.values())).visual.material
        np.testing.assert_array_equal(np.asarray(old_mat.baseColorTexture), np.asarray(new_mat.baseColorTexture))
        np.testing.assert_array_equal(np.asarray(old_mat.metallicRoughnessTexture), np.asarray(new_mat.metallicRoughnessTexture))

    def test_no_artifact_is_failure_even_when_shared_launcher_exits_zero(self):
        launcher = self.root/'launcher.py'; launcher.write_text('pass\n')
        (self.directory/'inputs.json').write_text(json.dumps(self.inputs))
        (self.directory/'config.yaml').write_text(yaml.safe_dump(dict(seed=42)))
        with patch.object(run_trellis, 'runtime_paths', return_value=(self.root, Path(sys.executable), launcher)), \
             patch.object(run_trellis, 'CHECKOUT', self.root), \
             patch.object(sys, 'argv', ['run_trellis.py', '--run-dir', str(self.directory)]):
            with self.assertRaisesRegex(RuntimeError, 'did not produce'):
                run_trellis.main()

    def test_shared_runtime_environment_replaces_mvsam_native_paths(self):
        launcher = self.root/'room-reconstruction/server/trellis_local.py'
        with patch.object(run_trellis, 'runtime_paths', return_value=(self.root, self.root/'runtime/trellis-env/bin/python', launcher)), \
             patch.dict(os.environ, {'CPATH': 'mv/include', 'LIBRARY_PATH': 'mv/lib', 'CUDA_VISIBLE_DEVICES': 'GPU-allowed'}):
            command, env = run_trellis.launch_command(self.directory, {'seed': 7}, self.photo)
        self.assertEqual(command[1], str(launcher))
        self.assertNotIn('CPATH', env)
        self.assertNotIn('LIBRARY_PATH', env)
        self.assertEqual(env['CUDA_VISIBLE_DEVICES'], 'GPU-allowed')
        self.assertIn('room-reconstruction/src', env['PYTHONPATH'])
        self.assertNotIn('mvsam', env['LD_LIBRARY_PATH'])

    def test_retired_multi_backend_cannot_start_work_or_fall_back_to_single_image(self):
        self.assertNotIn('trellis_multi', BACKENDS)
        with patch.dict(os.environ, VIEWFORGE_BACKEND='trellis_multi'):
            with self.assertRaisesRegex(ValueError, '已停用'):
                backend_name()
        for images in (['1'], ['1', '2'], list('1234')):
            with self.assertRaisesRegex(ValueError, '已停用'):
                validate_selection('trellis_multi', images)
        cfg = dict(seed=42, backend='trellis_multi')
        (self.directory/'inputs.json').write_text(json.dumps(self.inputs))
        (self.directory/'config.yaml').write_text(yaml.safe_dump(cfg))
        with patch.object(run_trellis, 'runtime_paths') as runtime, \
             patch.object(run_trellis.subprocess, 'run') as worker, \
             patch.object(sys, 'argv', ['run_trellis.py', '--run-dir', str(self.directory)]):
            with self.assertRaisesRegex(ValueError, '已停用'):
                run_trellis.main()
            with self.assertRaisesRegex(ValueError, '已停用'):
                run_trellis.launch_command(self.directory, cfg, self.photo)
            runtime.assert_not_called()
            worker.assert_not_called()
        self.assertFalse((self.directory/'reconstruction').exists())

    def test_historical_multi_results_keep_their_identity_and_material_contract(self):
        (self.directory/'result.json').write_text(json.dumps(dict(backend='trellis_multi', status='complete')))
        self.assertEqual(run_backend(self.directory), 'trellis_multi')
        cap = capabilities(run_backend(self.directory))
        self.assertTrue(cap['retired'])
        self.assertEqual(cap['material_mode'], 'pbr')
        self.assertTrue(cap['uses_all_photos'])
        self.assertFalse(cap['capture'] or cap['gaussian'])
        self.assertEqual(pipeline_stages('trellis_multi'), ['queued', 'preparing', 'reconstruction'])


if __name__ == '__main__':
    unittest.main()
