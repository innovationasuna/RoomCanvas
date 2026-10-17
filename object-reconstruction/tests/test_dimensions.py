import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np
import trimesh
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from dimensions import (DimensionsMiddleware, geometry, metric_glb, read_dimensions,
                        reset_dimensions, result_directory, save_dimensions)


class DimensionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.run = self.root/'runs/test-object'
        (self.run/'reconstruction').mkdir(parents=True)
        (self.run/'cover').mkdir()
        box = trimesh.creation.box(extents=[2, 3, 4])
        box.visual.vertex_colors = [60, 120, 200, 255]
        transform = trimesh.transformations.rotation_matrix(np.pi/2, [0, 1, 0])
        transform[:3, 3] = [5, -2, 7]
        scene = trimesh.Scene()
        scene.add_geometry(box, transform=transform)
        self.source = self.run/'reconstruction/result.glb'
        self.source.write_bytes(scene.export(file_type='glb'))
        display = trimesh.transformations.rotation_matrix(np.pi/2, [0, 0, 1])
        self.manifest = dict(assets=dict(glb=dict(transform=display.flatten(order='F').tolist())))
        (self.run/'cover/preview.json').write_text(json.dumps(self.manifest))
        # Measurement must never depend on the preview geometry or its bounds.
        (self.run/'reconstruction/preview.glb').write_bytes(trimesh.creation.box(extents=[100, 100, 100]).export(file_type='glb'))

    def tearDown(self):
        self.temp.cleanup()

    def test_full_geometry_node_and_display_transforms_define_z_up_axes(self):
        base = geometry(self.run)
        np.testing.assert_allclose([base['lengths'][a] for a in 'XYZ'], [3, 2, 4], atol=1e-6)
        self.assertEqual(read_dimensions(self.run)['calibration'], None)

    def test_single_axis_units_repeat_edits_reset_and_reload(self):
        before = hashlib.sha256(self.source.read_bytes()).hexdigest()
        data = save_dimensions(self.run, 'X', 150, 'cm')['calibration']
        self.assertAlmostEqual(data['scale'], .5)
        np.testing.assert_allclose([data['dimensions_m'][a] for a in 'XYZ'], [1.5, 1, 2], atol=1e-6)
        self.assertEqual(read_dimensions(self.run)['calibration'], data)
        revised = save_dimensions(self.run, 'Z', 800, 'mm')['calibration']
        self.assertAlmostEqual(revised['scale'], .2)
        self.assertAlmostEqual(revised['dimensions_m']['Z'], .8)
        self.assertIsNone(reset_dimensions(self.run)['calibration'])
        self.assertIsNone(read_dimensions(self.run)['calibration'])
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), before)

    def test_metric_export_matches_dimensions_preserves_binary_and_is_versioned(self):
        save_dimensions(self.run, 'X', 150, 'cm')
        path = metric_glb(self.run)
        exported = trimesh.load_scene(path, process=False)
        np.testing.assert_allclose(exported.extents, [1.5, 2, 1], atol=1e-6)
        original, derived = self.source.read_bytes(), path.read_bytes()
        old_size, new_size = struct.unpack_from('<I', original, 12)[0], struct.unpack_from('<I', derived, 12)[0]
        self.assertEqual(original[20+old_size:], derived[20+new_size:])
        self.assertEqual(metric_glb(self.run), path)
        save_dimensions(self.run, 'X', 300, 'cm')
        self.assertNotEqual(metric_glb(self.run), path)
        self.assertEqual(path.read_bytes(), derived)
        np.testing.assert_allclose(trimesh.load_scene(metric_glb(self.run)).extents, [3, 4, 2], atol=1e-6)

    def test_changed_source_invalidates_previous_calibration(self):
        save_dimensions(self.run, 'X', 150, 'cm')
        self.source.write_bytes(trimesh.creation.box(extents=[1, 1, 1]).export(file_type='glb'))
        self.assertIsNone(read_dimensions(self.run)['calibration'])
        with self.assertRaises(ValueError):
            metric_glb(self.run)

    def test_bad_measurements_and_paths_are_rejected_without_writes(self):
        for value in [0, -1, float('nan'), float('inf'), True, '120', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                save_dimensions(self.run, 'X', value, 'cm')
        for axis, unit in [('W', 'cm'), ('X', 'inch')]:
            with self.assertRaises(ValueError):
                save_dimensions(self.run, axis, 10, unit)
        for name in ['..', '../test-object', '/etc/passwd', 'test-object/extra']:
            with self.assertRaises(ValueError): result_directory(self.root, name)
        (self.root/'runs/escape').symlink_to(self.root)
        with self.assertRaises(FileNotFoundError): result_directory(self.root, 'escape')
        self.assertFalse((self.run/'dimensions.json').exists())

    def test_api_save_download_reset_and_cross_origin_rejection(self):
        app = Starlette(middleware=[Middleware(DimensionsMiddleware, root=self.root)])
        with TestClient(app) as client:
            url = '/viewforge/dimensions/test-object'
            self.assertEqual(client.get(url).status_code, 200)
            self.assertEqual(client.post(url, json=dict(axis='Y', value=100, unit='cm'), headers={'Origin': 'http://elsewhere'}).status_code, 400)
            response = client.post(url, json=dict(axis='Y', value=100, unit='cm'), headers={'Origin': 'http://testserver'})
            self.assertEqual(response.status_code, 200)
            self.assertAlmostEqual(response.json()['calibration']['dimensions_m']['Y'], 1)
            download = client.get(url+'/model.glb')
            self.assertEqual(download.status_code, 200)
            self.assertEqual(download.content[:4], b'glTF')
            self.assertIsNone(client.post(url, json={'reset': True}).json()['calibration'])
            self.assertEqual(client.get(url+'/model.glb').status_code, 400)


if __name__ == '__main__': unittest.main()
