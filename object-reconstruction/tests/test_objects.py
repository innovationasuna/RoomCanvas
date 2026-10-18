"""RoomCanvas's photos → object API: upload checks, masks, reconstruction gate, GPU queue."""
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from PIL import Image
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import objects
from objects import ObjectsMiddleware
from prepare_masks import prepare


def photo(kind='JPEG', size=(8, 6)):
    data = io.BytesIO()
    Image.new('RGB', size, (200, 80, 40)).save(data, format=kind)
    return data.getvalue()


def fake_infer(rows):
    for row in rows:
        with Image.open(row['image']) as image:
            mask = image.convert('RGBA')
        mask.putalpha(Image.new('L', mask.size, 255))
        mask.save(row['mask'])


class ObjectsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.env = patch.dict(os.environ, VIEWFORGE_GPU_LOCK=str(self.root/'cache/gpu.lock'))
        self.env.start()
        self.spawn = patch.object(objects.subprocess, 'run', side_effect=self.fake_run)
        self.spawn.start()
        self.poll = patch.object(objects, 'GPU_POLL_SECONDS', .01)
        self.poll.start()
        self.client = TestClient(Starlette(middleware=[Middleware(ObjectsMiddleware, root=self.root)]))
        self.commands = []

    def tearDown(self):
        self.spawn.stop()
        self.poll.stop()
        self.env.stop()
        self.temp.cleanup()

    def fake_run(self, command, **kwargs):
        """prepare_masks.py → the real prepare() with a fake BiRefNet; run.py → a finished run."""
        self.commands.append(command)
        args = command[2:]
        name = args[args.index('--object') + 1]
        images = args[args.index('--images') + 1:-1]
        if command[1].endswith('prepare_masks.py'):
            record = prepare(self.root, name, images, infer=fake_infer)
            return subprocess.CompletedProcess(command, 0, json.dumps(record))
        attempt = args[args.index('--attempt') + 1]
        run = self.root/'runs'/f'20261018_{name}_{attempt}'
        (run/'reconstruction').mkdir(parents=True)
        (run/'result.json').write_text(json.dumps(dict(status='complete')))
        return subprocess.CompletedProcess(command, 0, '')

    def create(self, name='chair', photos=3, kind='JPEG'):
        files = [('photos', (f'IMG_{i}.jpg', photo(kind), 'image/jpeg')) for i in range(photos)]
        return self.client.post('/viewforge/objects/create', data=dict(name=name), files=files)

    def wait(self, job):
        for _ in range(200):
            state = self.client.get(f'/viewforge/objects/jobs/{job}').json()
            if state['status'] in ('complete', 'failed'):
                return state
            time.sleep(.02)
        self.fail('job did not finish')

    def test_upload_checks_before_writing(self):
        self.assertIn('3–40', self.create(photos=2).json()['error'])
        self.assertIn('JPEG', self.create(kind='GIF').json()['error'])
        self.assertIn('名称', self.create(name='../x').json()['error'])
        self.assertFalse((self.root/'data/inputs').exists())
        created = self.create(name='我的椅子').json()
        self.assertEqual(created['images'], ['我的椅子_001', '我的椅子_002', '我的椅子_003'])
        self.assertEqual(len(list((self.root/'data/inputs/我的椅子/originals').iterdir())), 3)
        self.assertEqual(self.create(name='我的椅子').status_code, 400)
        self.assertEqual(list((self.root/'cache/uploads').iterdir()), [])

    def test_masks_then_reconstruction_of_the_kept_photos(self):
        images = self.create().json()['images']
        masks = self.wait(self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=images)).json()['id'])
        self.assertEqual(masks['status'], 'complete', masks)
        self.assertEqual([p['name'] for p in masks['previews']], images)
        self.assertEqual(self.client.get('/viewforge/objects/' + masks['previews'][0]['url']).headers['content-type'], 'image/png')
        self.assertIn('--wait-gpu', self.commands[0])
        # One photo was made after the preview: no reconstruction until it is previewed too.
        extra = self.root/'data/inputs/chair/images/chair_004.png'
        Image.new('RGB', (8, 6)).save(extra)
        refused = self.client.post('/viewforge/objects/reconstruct', json=dict(object='chair', images=images[:2] + ['chair_004'], masks=masks['id']))
        self.assertEqual(refused.status_code, 400)
        job = self.client.post('/viewforge/objects/reconstruct', json=dict(object='chair', images=images, masks=masks['id'])).json()
        state = self.wait(job['id'])
        self.assertEqual(state['status'], 'complete', state)
        self.assertTrue(state['run'].endswith('_chair_' + self.commands[-1][self.commands[-1].index('--attempt') + 1]))

    def test_changed_mask_needs_a_new_preview(self):
        images = self.create().json()['images']
        masks = self.wait(self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=images)).json()['id'])
        fake_infer([dict(image=str(self.root/'data/inputs/chair/images/chair_001.png'),
                         mask=str(self.root/'data/inputs/chair/masks/chair_001.png'))])
        os.utime(self.root/'data/inputs/chair/masks/chair_001.png', ns=(1, 1))
        response = self.client.post('/viewforge/objects/reconstruct', json=dict(object='chair', images=images, masks=masks['id']))
        self.assertIn('重新抠图', response.json()['error'])

    def test_jobs_wait_for_the_gpu(self):
        images = self.create().json()['images']
        lock = (self.root/'cache/gpu.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX)
        job = self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=images)).json()
        time.sleep(.1)
        self.assertEqual(self.client.get(f'/viewforge/objects/jobs/{job["id"]}').json()['status'], 'queued')
        self.assertEqual(self.commands, [])
        lock.close()
        self.assertEqual(self.wait(job['id'])['status'], 'complete')

    def test_other_sites_cannot_post(self):
        response = self.client.post('/viewforge/objects/masks', json={}, headers=dict(origin='http://evil.example'))
        self.assertIn('当前页面', response.json()['error'])
        self.assertEqual(self.client.get('/viewforge/objects/jobs/' + '0' * 32).status_code, 404)
        self.assertEqual(self.client.get('/viewforge/objects/previews/x/../../etc.png').status_code, 404)


if __name__ == '__main__':
    unittest.main()
