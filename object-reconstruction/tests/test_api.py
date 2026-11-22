"""正式入口只加载 API；旧界面未安装也能上传、重建、读取与标定。"""
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from starlette.testclient import TestClient
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import objects
from prepare_masks import prepare
from web import create_app


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.client = TestClient(create_app(self.root, token='a' * 64), headers={'Authorization': 'Bearer ' + 'a' * 64})
        self.addCleanup(self.client.close)

    def test_all_routes_require_credentials_before_uploads_or_jobs_are_created(self):
        with TestClient(create_app(self.root, token='a' * 64)) as anonymous:
            for method, path in [('GET', '/health'), ('GET', '/viewforge/assets/catalog'),
                                 ('HEAD', '/viewforge/assets/catalog'), ('POST', '/viewforge/objects/create'),
                                 ('POST', '/viewforge/objects/reconstruct'), ('POST', '/viewforge/dimensions/run')]:
                for headers in ({}, {'Authorization': 'Bearer wrong'}):
                    with self.subTest(method=method, path=path, headers=headers):
                        response = anonymous.request(method, path, headers=headers)
                        self.assertEqual(response.status_code, 401)
            self.assertFalse((self.root / 'data').exists())

    def test_service_loads_without_gradio_and_does_not_mount_legacy_ui(self):
        code = '''import importlib.abc, sys
class NoOldUI(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in ('gradio', 'gradio_client'):
            raise AssertionError('API attempted to load the deprecated UI')
sys.meta_path.insert(0, NoOldUI())
sys.path.insert(0, sys.argv[1])
from web import create_app
from starlette.testclient import TestClient
with TestClient(create_app(sys.argv[2], token='a' * 64), headers={'Authorization': 'Bearer ' + 'a' * 64}) as client:
    assert client.get('/health').json()['status'] == 'ok'
'''
        result = subprocess.run([sys.executable, '-c', code, str(Path(__file__).resolve().parents[1]/'scripts'), str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.client.get('/').json()['service'], 'roomcanvas-objects')
        for path in ['/config', '/viewforge/layouts/viewer', '/gradio_api/file=/etc/passwd', '/legacy/scripts/assets/cover-viewer.html']:
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_roomcanvas_workflow_through_the_real_service(self):
        photo = io.BytesIO(); Image.new('RGB', (8, 6), (50, 120, 80)).save(photo, format='JPEG')
        response = self.client.post('/viewforge/objects/create', data={'name': '我的物体'},
                                    files=[('photos', (f'{i}.jpg', photo.getvalue(), 'image/jpeg')) for i in range(3)])
        self.assertEqual(response.status_code, 200)
        images = response.json()['images']

        def infer(rows):
            for row in rows:
                with Image.open(row['image']) as image:
                    rgba = image.convert('RGBA'); rgba.putalpha(255); rgba.save(row['mask'])

        def finish(job):
            if job.kind == 'masks':
                record = prepare(self.root, job.object, job.images, infer=infer)
                job.finish(subprocess.CompletedProcess(job.command, 0, json.dumps(record)))
            else:
                run = self.root/'runs'/f'20261020_{job.object}_{job.attempt}'
                (run/'reconstruction').mkdir(parents=True)
                model = trimesh.creation.box(extents=[2, 3, 4]).export(file_type='glb')
                (run/'reconstruction/result.glb').write_bytes(model)
                (run/'result.json').write_text(json.dumps({'status': 'complete'}))
                job.finish(subprocess.CompletedProcess(job.command, 0, ''))

        def start(job):
            with objects.JOBS_LOCK:
                objects.JOBS[job.id] = job
            finish(job)
            return job.view()

        # Only replace GPU execution; request handling and job validation stay real.
        with patch.object(objects, 'start', start), patch.dict('os.environ', VIEWFORGE_GPU_LOCK=str(self.root/'cache/gpu.lock'),
                CUDA_VISIBLE_DEVICES='GPU-00000000-0000-0000-0000-000000000001', ROOMCANVAS_GPU_LOCK_DIR=str(self.root/'locks')):
            masks = self.client.post('/viewforge/objects/masks', json={'object': '我的物体', 'images': images}).json()
            self.assertEqual(self.client.get('/viewforge/objects/jobs/' + masks['id']).json()['status'], 'complete')
            preview = self.client.get('/viewforge/objects/jobs/' + masks['id']).json()['previews'][0]['url']
            self.assertEqual(self.client.get('/viewforge/objects/' + preview).status_code, 200)
            reconstructed = self.client.post('/viewforge/objects/reconstruct', json={'object': '我的物体', 'images': images, 'masks': masks['id']}).json()

        job = self.client.get('/viewforge/objects/jobs/' + reconstructed['id']).json()
        self.assertEqual(job['status'], 'complete')
        run = job['run']
        self.assertIn(run, self.client.get('/viewforge/assets/catalog').json()['runs'])
        for path in ['/viewforge/assets/' + run, '/viewforge/layouts/assets/' + run]:
            self.assertEqual(self.client.get(path + '/result.glb').content[:4], b'glTF')
        saved = self.client.post('/viewforge/dimensions/' + run, json={'axis': 'Z', 'value': .6, 'unit': 'm'})
        self.assertEqual(saved.status_code, 200)
        self.assertAlmostEqual(self.client.get('/viewforge/assets/' + run).json()['calibration']['dimensions_m']['Z'], .6)
        self.assertEqual(self.client.get('/viewforge/dimensions/' + run + '/model.glb').content[:4], b'glTF')


if __name__ == '__main__':
    unittest.main()
