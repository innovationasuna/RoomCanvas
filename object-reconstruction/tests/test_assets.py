"""物体读取和标定独立于已移除的房间布局服务。"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import trimesh
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from assets import AssetsMiddleware
from dimensions import DimensionsMiddleware
from asset_state import publish_asset
from cover_scene import preview_manifest


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

    def test_preview_metadata_and_gaussians_do_not_depend_on_ui_file_routes(self):
        run = self.model('toy')
        (run/'cover').mkdir()
        old = dict(assets={kind: dict(url='/gradio_api/file=/old/private/path', transform=[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
                           for kind in ['glb', 'glb_preview', 'gaussian']}, recommendation={'id': 'view-1'})
        manifest = run/'cover/preview.json'
        manifest.write_text(json.dumps(old))
        original = manifest.read_bytes()
        light = run/'reconstruction/preview.glb'
        light.write_bytes((run/'reconstruction/result.glb').read_bytes())
        gaussian = run/'reconstruction/result.ply'
        gaussian.write_bytes(b'ply\nfixture')
        metadata = self.client.get('/viewforge/assets/toy').json()
        self.assertNotIn('viewer_url', metadata)
        adapted = self.client.get(metadata['manifest_url']).json()
        self.assertEqual(adapted['recommendation'], old['recommendation'])
        for kind, file in [('glb', 'result.glb'), ('glb_preview', 'preview.glb'), ('gaussian', 'result.ply')]:
            self.assertEqual(adapted['assets'][kind]['url'], '/viewforge/assets/toy/' + file)
            self.assertEqual(adapted['assets'][kind]['transform'], old['assets'][kind]['transform'])
        self.assertEqual(manifest.read_bytes(), original)
        self.assertEqual(self.client.get(adapted['assets']['gaussian']['url']).content, gaussian.read_bytes())
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

    def test_baked_mvsam_materials_are_preserved_without_losing_capture(self):
        run = self.model('baked')
        receipt = run/'reconstruction/materials.json'
        receipt.write_text(json.dumps(dict(status='complete', method='native_gaussian_colour_baking')))
        info = self.client.get('/viewforge/assets/baked').json()['capabilities']
        self.assertEqual(info['backend'], 'mvsam3d')
        self.assertEqual(info['material_mode'], 'pbr')
        self.assertTrue(info['capture'] and info['gaussian'])
        self.assertFalse(info['predicted_material_maps'])
        receipt.write_text(json.dumps(dict(status='failed', method='native_gaussian_colour_baking')))
        self.assertNotIn('capabilities', self.client.get('/viewforge/assets/baked').json())

    def prepare_publication(self):
        run = self.model('published')
        (run/'reconstruction/result.ply').write_bytes(b'ply fixture')
        (run/'config.yaml').write_text('mesh_export: {mode: baked_pbr}\n')
        (run/'reconstruction/materials.json').write_text(json.dumps(dict(
            status='complete', method='native_gaussian_colour_baking')))
        (run/'result.json').write_text(json.dumps(dict(status='running', asset_schema_version=1)))
        return run

    def publish(self, run):
        scene = dict(gaussian_transform=np.eye(4), mesh_transform=np.diag([2., 1., 1., 1.]), radius=1.)
        with patch('cover_scene.load_scene', return_value=scene):
            return publish_asset(run)

    def test_partial_mesh_and_interrupted_publication_are_not_importable(self):
        run = self.prepare_publication()
        for stage in ('running', 'complete', 'failed'):
            (run/'result.json').write_text(json.dumps(dict(status=stage, asset_schema_version=1)))
            self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], [])
            for route in ('assets/published', 'assets/published/result.glb', 'dimensions/published'):
                response = self.client.get('/viewforge/' + route)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()['state'], 'asset_failed' if stage == 'failed' else 'asset_pending')
        with patch('cover_scene.write_json', side_effect=OSError('interrupted atomic publication')):
            with self.assertRaises(OSError):
                self.publish(run)
        self.assertFalse((run/'asset.json').exists())
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], [])
        # A pre-manifest historical success remains importable.
        (run/'result.json').write_text('{"status":"complete"}')
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], ['published'])

    def test_publication_freezes_transform_and_capabilities_across_recommendations(self):
        run = self.prepare_publication()
        base = self.publish(run)
        url = '/viewforge/dimensions/published'
        calibrated = self.client.post(url, json=dict(axis='X', value=120, unit='cm')).json()
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], ['published'])
        self.assertIn('manifest_url', self.client.get('/viewforge/assets/published').json())
        # A delayed legacy-style COVER writer cannot replace the stable contract.
        (run/'cover').mkdir()
        (run/'cover/preview.json').write_text(json.dumps(dict(assets=dict(glb=dict(transform=np.eye(4).ravel().tolist())),
            recommendation={'id': 'later'}, status='complete')))
        (run/'reconstruction/materials.json').write_text('{"status":"failed"}')
        self.assertEqual(self.client.get(url).json(), calibrated)
        asset = self.client.get('/viewforge/assets/published').json()
        self.assertEqual(asset['capabilities']['material_mode'], 'pbr')
        manifest = self.client.get(asset['manifest_url']).json()
        self.assertEqual(manifest['recommendation'], {'id': 'later'})
        self.assertEqual(manifest['assets']['glb'], base['assets']['glb'])
        self.assertEqual(preview_manifest(run)['assets'], base['assets'])
        # A published file regenerated whole stays served; a torn one hides the set, even if its
        # commit marker exists.
        (run/'reconstruction/result.glb').write_bytes(trimesh.creation.icosphere().export(file_type='glb'))
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], ['published'])
        (run/'reconstruction/result.glb').write_bytes(trimesh.creation.icosphere().export(file_type='glb')[:-8])
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], [])
        self.assertEqual(self.client.get(url).status_code, 409)

    def test_runs_from_before_publication_are_served_while_their_model_is_whole(self):
        for name, state in [('failed', '{"status": "failed"}'), ('interrupted', '{"status": "running"}'),
                            ('unreadable', '{"status": "comp')]:
            (self.model(name)/'result.json').write_text(state)
        torn = self.model('torn')
        (torn/'result.json').write_text('{"status": "failed"}')
        (torn/'reconstruction/result.glb').write_bytes((torn/'reconstruction/result.glb').read_bytes()[:-8])
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], ['unreadable', 'interrupted', 'failed'])
        self.assertEqual(self.client.get('/viewforge/assets/failed/result.glb').status_code, 200)
        self.assertEqual(self.client.get('/viewforge/assets/torn/result.glb').status_code, 409)

    def test_a_model_without_a_usable_camera_fit_is_still_published(self):
        run = self.prepare_publication()
        with patch('cover_scene.load_scene', side_effect=ValueError('DA3 camera rotation is not orthonormal')):
            data = publish_asset(run)
        self.assertTrue(data['assets']['glb']['transform'])
        self.assertEqual(self.client.get('/viewforge/assets/catalog').json()['runs'], ['published'])

    def test_failed_material_bake_cannot_publish_a_glb(self):
        run = self.prepare_publication()
        (run/'reconstruction/materials.json').write_text('{"status":"failed"}')
        with self.assertRaisesRegex(ValueError, 'material baking'):
            self.publish(run)
        self.assertFalse((run/'asset.json').exists())


if __name__ == '__main__':
    unittest.main()
