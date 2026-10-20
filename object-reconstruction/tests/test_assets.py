"""物体读取和标定独立于已移除的房间布局服务。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest

import trimesh
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from assets import AssetsMiddleware
from dimensions import DimensionsMiddleware


class AssetsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.client = TestClient(Starlette(middleware=[
            Middleware(AssetsMiddleware, root=self.root),
            Middleware(DimensionsMiddleware, root=self.root),
        ]))
        self.addCleanup(self.client.close)

    def model(self, name='我的椅子'):
        run = self.root/'runs'/name
        (run/'reconstruction').mkdir(parents=True)
        (run/'reconstruction/result.glb').write_bytes(
            trimesh.creation.box(extents=[2, 3, 4]).export(file_type='glb'))
        return run

    def test_catalog_needs_no_room_files_and_skips_incomplete_or_external_runs(self):
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json(), {'runs': []})
        run = self.model()
        (self.root/'runs/incomplete').mkdir()
        outside = self.root/'outside/reconstruction'
        outside.mkdir(parents=True)
        (outside/'result.glb').touch()
        (self.root/'runs/escape').symlink_to(outside.parent, target_is_directory=True)
        for path in ['/viewforge/assets/catalog', '/viewforge/layouts/catalog']:
            self.assertEqual(self.client.get(path).json(), {'runs': [run.name]})
        self.assertFalse((self.root/'data/layouts').exists())

    def test_models_and_saved_real_dimensions_are_shared_with_roomcanvas(self):
        run = self.model()
        url = '/viewforge/assets/' + run.name
        self.assertIsNone(self.client.get(url).json()['calibration'])
        calibrated = self.client.post('/viewforge/dimensions/' + run.name,
                                      json={'axis': 'Z', 'value': 60, 'unit': 'cm'})
        self.assertEqual(calibrated.status_code, 200)
        for path in [url, '/viewforge/layouts/assets/' + run.name]:
            asset = self.client.get(path)
            self.assertEqual(asset.json(), calibrated.json())
            self.assertAlmostEqual(asset.json()['calibration']['dimensions_m']['Z'], .6)
            self.assertEqual(asset.headers['cache-control'], 'no-store')
            model = self.client.get(path + '/result.glb')
            self.assertEqual(model.status_code, 200)
            self.assertEqual(model.content, (run/'reconstruction/result.glb').read_bytes())
            self.assertEqual(self.client.get(path + '/preview.glb').status_code, 404)
        # 标定后的米制模型导出仍可独立使用。
        self.assertEqual(self.client.get('/viewforge/dimensions/' + run.name + '/model.glb').content[:4], b'glTF')

    def test_single_object_viewer_and_preview_remain_available(self):
        run = self.model('toy')
        (run/'cover').mkdir()
        (run/'cover/preview.json').write_text(json.dumps({}))
        light = run/'reconstruction/preview.glb'
        light.write_bytes((run/'reconstruction/result.glb').read_bytes())
        metadata = self.client.get('/viewforge/assets/toy').json()
        self.assertIn('cover-viewer.html', metadata['viewer_url'])
        self.assertEqual(self.client.get('/viewforge/assets/toy/preview.glb').content, light.read_bytes())

    def test_scene_endpoints_are_removed_and_assets_cannot_write_layouts(self):
        for path in ['viewer', 'rooms/office.glb', 'save', 'validate', 'a' * 32]:
            for method in ['GET', 'POST']:
                self.assertEqual(self.client.request(method, '/viewforge/layouts/' + path).status_code, 404)
        self.model('toy')
        self.assertEqual(self.client.post('/viewforge/assets/toy', json={}).status_code, 405)
        for path in ['missing', 'toy/other.glb', 'toy/result.glb/extra', 'escape', '%2E%2E%2Foutside']:
            self.assertIn(self.client.get('/viewforge/assets/' + path).status_code, [400, 404])
        self.assertFalse((self.root/'data/layouts').exists())


if __name__ == '__main__':
    unittest.main()
