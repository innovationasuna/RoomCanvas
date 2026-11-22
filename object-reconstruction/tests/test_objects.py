"""RoomCanvas's photos → object API: upload checks, masks, reconstruction gate, GPU queue."""
from concurrent.futures import ThreadPoolExecutor
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
import import_photos
import objects
import roomcanvas_gpu
from objects import ObjectsMiddleware
from prepare_masks import prepare


def photo(kind='JPEG', size=(8, 6)):
    data = io.BytesIO()
    Image.new('RGB', size, (200, 80, 40)).save(data, format=kind)
    return data.getvalue()


def mpo_photo():
    """A JPEG primary plus a smaller grayscale auxiliary image, as in HDR photos."""
    data = io.BytesIO()
    exif = Image.Exif()
    exif[274] = 6  # Rotate the primary image 90 degrees clockwise on import.
    with Image.new('RGB', (8, 6), (200, 80, 40)) as primary, Image.new('L', (4, 3), 128) as auxiliary:
        primary.save(data, format='MPO', save_all=True, append_images=[auxiliary], exif=exif)
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
        self.env = patch.dict(os.environ, VIEWFORGE_GPU_LOCK=str(self.root/'cache/gpu.lock'),
                              CUDA_VISIBLE_DEVICES='GPU-00000000-0000-0000-0000-000000000001', ROOMCANVAS_GPU_LOCK_DIR=str(self.root/'locks'))
        self.env.start()
        self.spawn = patch.object(objects.subprocess, 'run', side_effect=self.fake_run)
        self.spawn.start()
        self.poll = patch.object(roomcanvas_gpu, 'POLL_SECONDS', .01)
        self.poll.start()
        self.client = TestClient(Starlette(middleware=[Middleware(ObjectsMiddleware, root=self.root)]))
        self.commands, self.inferred = [], []

    def tearDown(self):
        self.spawn.stop()
        self.poll.stop()
        self.env.stop()
        self.temp.cleanup()

    def fake_run(self, command, **kwargs):
        """prepare_masks.py → the real prepare() with a fake BiRefNet; run.py → a finished run."""
        self.commands.append(command)
        args = command[2:]
        lock_fd = int(args[args.index('--lock-fd') + 1]) if '--lock-fd' in args else None
        name = args[args.index('--object') + 1]
        images = args[args.index('--images') + 1:-1]
        if command[1].endswith('prepare_masks.py'):
            record = prepare(self.root, name, images, lock_fd=lock_fd,
                             infer=lambda rows: (self.inferred.extend(r['name'] for r in rows), fake_infer(rows)))
            return subprocess.CompletedProcess(command, 0, json.dumps(record))
        attempt = args[args.index('--attempt') + 1]
        run = self.root/'runs'/f'20261018_{name}_{attempt}'
        (run/'reconstruction').mkdir(parents=True)
        (run/'reconstruction/result.glb').write_bytes(b'glTF')
        rows = [dict(name=f'{i:06d}', source_name=image) for i, image in enumerate(images, 1)]
        (run/'inputs.json').write_text(json.dumps(dict(object=name, input_dir=str(run/'input'), images=rows)))
        (run/'result.json').write_text(json.dumps(dict(status='complete')))
        return subprocess.CompletedProcess(command, 0, '')

    def create(self, name='chair', photos=3, kind='JPEG'):
        files = [('photos', (f'IMG_{i}.jpg', photo(kind), 'image/jpeg')) for i in range(photos)]
        return self.client.post('/viewforge/objects/create', data=dict(name=name), files=files)

    def capture(self, run, photos=2):
        files = [('photos', (f'NEW_{i}.jpg', photo(), 'image/jpeg')) for i in range(photos)]
        return self.client.post('/viewforge/objects/capture', data=dict(run=run), files=files)

    def build(self, images, name='chair', parent=None):
        masks = self.wait(self.client.post('/viewforge/objects/masks', json=dict(object=name, images=images)).json()['id'])
        body = dict(object=name, images=images, masks=masks['id'], **(dict(parent=parent) if parent else {}))
        return self.wait(self.client.post('/viewforge/objects/reconstruct', json=body).json()['id'])

    def wait(self, job):
        for _ in range(200):
            state = self.client.get(f'/viewforge/objects/jobs/{job}').json()
            if state['status'] in ('complete', 'failed'):
                return state
            time.sleep(.02)
        self.fail('job did not finish')

    def test_upload_checks_before_writing(self):
        self.assertIn('1–40', self.create(photos=0).json()['error'])
        self.assertIn('JPEG', self.create(kind='GIF').json()['error'])
        self.assertIn('名称', self.create(name='../x').json()['error'])
        self.assertFalse((self.root/'data/inputs').exists())
        created = self.create(name='我的椅子').json()
        self.assertEqual(created['images'], ['我的椅子_001', '我的椅子_002', '我的椅子_003'])
        self.assertEqual(len(list((self.root/'data/inputs/我的椅子/originals').iterdir())), 3)
        self.assertEqual(self.create(name='我的椅子').status_code, 400)
        self.assertEqual(list((self.root/'cache/uploads').glob('*')), [])

    def test_truncated_jpeg_can_retry_and_mixed_batch_keeps_only_valid_photos(self):
        truncated = photo()[:-7]  # Has a JPEG header but fails when Pillow loads its pixels.
        rejected = [('photos', ('broken.jpg', truncated, 'image/jpeg'))]
        response = self.client.post('/viewforge/objects/create', data={'name': 'chair'}, files=rejected)
        self.assertEqual(response.status_code, 400)
        self.assertIn('broken.jpg', response.json()['error'])
        self.assertFalse((self.root/'data/inputs/chair').exists())
        self.assertEqual(list((self.root/'data').rglob('.import-*')), [])
        mixed = rejected + [('photos', ('ok.jpg', photo(), 'image/jpeg'))]
        result = self.client.post('/viewforge/objects/create', data={'name': 'chair'}, files=mixed).json()
        self.assertEqual(result['images'], ['chair_002'])
        self.assertEqual([row['filename'] for row in result['errors']], ['broken.jpg'])
        inputs = self.root/'data/inputs/chair'
        self.assertEqual({p.name for p in inputs.rglob('*') if p.is_file()},
                         {'chair_002.json', 'chair_002.png', 'chair_002.jpg'})
        metadata = json.loads((inputs/'imports/chair_002.json').read_text())
        self.assertEqual(metadata['original_filename'], 'ok.jpg')
        self.assertEqual(Path(metadata['original']).read_bytes(), photo())

    def test_mpo_jpeg_imports_primary_with_orientation_and_preserves_original(self):
        data = mpo_photo()
        with Image.open(io.BytesIO(data)) as source:
            self.assertEqual(source.format, 'MPO')
            self.assertEqual(source.n_frames, 2)
            expected = source.transpose(Image.Transpose.ROTATE_270).tobytes()
        for suffix in ('jpg', 'jpeg'):
            with self.subTest(suffix=suffix):
                name = f'hdr_{suffix}'
                filename = f'phone.{suffix}'
                response = self.client.post('/viewforge/objects/create', data={'name': name},
                                            files=[('photos', (filename, data, 'image/jpeg'))])
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['images'], [name])
                self.assertEqual(response.json()['errors'], [])
                directory = self.root/'data/inputs'/name
                metadata = json.loads((directory/'imports'/f'{name}.json').read_text())
                self.assertEqual(metadata['original_filename'], filename)
                self.assertEqual(Path(metadata['original']).suffix, '.jpg')
                self.assertEqual(Path(metadata['original']).read_bytes(), data)
                with Image.open(metadata['image']) as normalized:
                    self.assertEqual(normalized.format, 'PNG')
                    self.assertEqual(normalized.mode, 'RGB')
                    self.assertEqual(normalized.size, (6, 8))
                    self.assertEqual(normalized.tobytes(), expected)
                    self.assertNotIn(274, normalized.getexif())

    def test_mpo_capture_keeps_existing_photos(self):
        created = self.create(photos=1).json()
        built = self.build(created['images'])
        response = self.client.post('/viewforge/objects/capture', data={'run': built['run']},
                                    files=[('photos', ('phone.jpeg', mpo_photo(), 'image/jpeg'))])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['kept'], created['images'])
        self.assertEqual(len(response.json()['added']), 1)
        self.assertEqual(response.json()['errors'], [])

    def test_mpo_with_truncated_primary_is_rejected_without_publishing(self):
        data = mpo_photo()
        truncated = data[:data.index(b'\xff\xd9') - 7]
        with Image.open(io.BytesIO(truncated)) as source:
            self.assertEqual(source.format, 'MPO')
        response = self.client.post('/viewforge/objects/create', data={'name': 'broken_hdr'},
                                    files=[('photos', ('broken.jpeg', truncated, 'image/jpeg'))])
        self.assertEqual(response.status_code, 400)
        self.assertIn('broken.jpeg', response.json()['error'])
        self.assertFalse((self.root/'data/inputs/broken_hdr').exists())
        self.assertEqual(list((self.root/'data').rglob('.import-*')), [])

    def test_streamed_upload_without_length_obeys_same_limit(self):
        with patch.object(objects, 'MAX_UPLOAD', 32):
            response = self.client.post('/viewforge/objects/create', content=iter([b'x' * 33]),
                                        headers={'Content-Type': 'multipart/form-data; boundary=test'})
        self.assertEqual(response.status_code, 400)
        self.assertIn('过大', response.json()['error'])
        self.assertFalse((self.root/'data').exists())

    def test_copy_does_not_block_job_queries_and_failed_write_releases_name(self):
        entered, release = threading.Event(), threading.Event()
        def stall(*args):
            entered.set()
            if not release.wait(8):
                raise RuntimeError('timed out waiting to release photo copy')
            raise OSError('disk full')

        with self.client, patch.object(import_photos.shutil, 'copyfileobj', side_effect=stall), ThreadPoolExecutor(2) as pool:
            upload = pool.submit(self.create, photos=1)
            try:
                self.assertTrue(entered.wait(4))
                query = pool.submit(self.client.get, '/viewforge/objects/jobs/' + 'a' * 32)
                self.assertEqual(query.result(2).status_code, 404)
            finally:
                release.set()
            self.assertEqual(upload.result().status_code, 500)
        self.assertFalse((self.root/'data/inputs/chair').exists())
        self.assertEqual(list((self.root/'data').rglob('.import-*')), [])
        self.assertEqual(self.create(photos=1).status_code, 200)

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

    def test_one_photo_is_enough(self):
        created = self.create(name='台灯', photos=1).json()
        self.assertEqual(created['images'], ['台灯'])
        state = self.build(created['images'], name='台灯')
        self.assertEqual(state['status'], 'complete', state)

    def test_capture_rebuilds_on_top_of_a_run(self):
        first = self.build(self.create().json()['images'])
        kept = ['chair_001', 'chair_002', 'chair_003']
        captured = self.capture(first['run']).json()
        self.assertEqual((captured['object'], captured['parent'], captured['kept']), ('chair', first['run'], kept))
        self.assertEqual(captured['images'][:3], kept)
        self.assertEqual(len(captured['added']), 2)
        added = json.loads((self.root/'data/inputs/chair/imports'/f'{captured["added"][0]}.json').read_text())
        self.assertEqual(added['parent_run_id'], first['run'])
        # The old photos keep their masks; only the new ones go to BiRefNet.
        masks = self.wait(self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=captured['images'])).json()['id'])
        self.assertEqual(self.inferred, kept + captured['added'])
        # Dropping an old photo is refused; keeping them all rebuilds with --parent-run.
        dropped = self.client.post('/viewforge/objects/reconstruct', json=dict(object='chair', images=captured['images'][1:], masks=masks['id'], parent=first['run']))
        self.assertIn('原来的照片', dropped.json()['error'])
        job = self.client.post('/viewforge/objects/reconstruct', json=dict(object='chair', images=captured['images'], masks=masks['id'], parent=first['run'])).json()
        self.assertEqual(job['parent'], first['run'])
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        command = self.commands[-1]
        self.assertEqual(command[command.index('--parent-run') + 1], first['run'])

    def test_failed_capture_publish_preserves_previous_object(self):
        parent = self.build(self.create(photos=1).json()['images'])['run']
        directory = self.root/'data/inputs/chair'
        before = {p.relative_to(directory): p.read_bytes() for p in directory.rglob('*') if p.is_file()}
        link = os.link
        def fail_publishing_image(source, target):
            if target.parent.name == 'images':
                raise OSError('disk full')
            link(source, target)

        with patch.object(import_photos.os, 'link', side_effect=fail_publishing_image):
            response = self.capture(parent)
        self.assertEqual(response.status_code, 500)
        self.assertEqual({p.relative_to(directory): p.read_bytes() for p in directory.rglob('*') if p.is_file()}, before)
        self.assertEqual(list(directory.glob('.import-*')), [])
        self.assertEqual(len(self.capture(parent, photos=1).json()['added']), 1)

    def test_capture_needs_a_finished_run(self):
        self.assertIn('不能补拍', self.capture('20261018_chair_nothing').json()['error'])
        self.assertIn('不能补拍', self.capture('../x').json()['error'])
        first = self.build(self.create().json()['images'])
        self.assertIn('1–37', self.capture(first['run'], photos=38).json()['error'])
        self.assertIn('1–37', self.capture(first['run'], photos=0).json()['error'])

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
        (self.root/'cache').mkdir(exist_ok=True)
        lock = (self.root/'cache/gpu.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX)
        job = self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=images)).json()
        time.sleep(.1)
        self.assertEqual(self.client.get(f'/viewforge/objects/jobs/{job["id"]}').json()['status'], 'queued')
        self.assertEqual(self.commands, [])
        lock.close()
        self.assertEqual(self.wait(job['id'])['status'], 'complete')
        # One wait, here: the script runs on the lease the job already holds.
        self.assertIn('--lock-fd', self.commands[0])

    def test_gpu_wait_is_bounded_while_the_job_shows_queued(self):
        images = self.create().json()['images']
        (self.root/'cache').mkdir(exist_ok=True)
        lock = (self.root/'cache/gpu.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            with patch.object(roomcanvas_gpu, 'WAIT_SECONDS', .2):
                job = self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=images)).json()
                state = self.wait(job['id'])
        finally:
            lock.close()
        self.assertEqual(state['status'], 'failed')
        self.assertIn('GPU 被其他任务占用', state['error'])
        self.assertEqual(self.commands, [])

    def test_longest_name_can_still_be_captured(self):
        # Ids built from the name (photo <name>_001, run <date>_<name>_web_<time>) stay valid.
        name = '椅' * objects.MAX_NAME
        self.assertIn(f'1–{objects.MAX_NAME}', self.create(name=name + '椅').json()['error'])
        first = self.build(self.create(name=name, photos=2).json()['images'], name=name)
        self.assertEqual(first['status'], 'complete', first)
        captured = self.capture(first['run']).json()
        self.assertEqual(captured['parent'], first['run'], captured)

    def test_same_name_at_once_gets_one_object(self):
        results, barrier = [], threading.Barrier(2)
        upload = [('IMG.jpg', self.root/'IMG.jpg')]
        upload[0][1].write_bytes(photo())
        def create():
            barrier.wait()
            try:
                results.append(objects.create_object(self.root, 'chair', upload)['object'])
            except ValueError as exc:
                results.append(str(exc))
        threads = [threading.Thread(target=create) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), ['chair', '这个名称已经有了，换一个'])

    def test_previewing_existing_masks_does_not_wait_for_the_gpu(self):
        images = self.create().json()['images']
        self.assertEqual(self.build(images)['status'], 'complete')
        (self.root/'cache').mkdir(exist_ok=True)
        lock = (self.root/'cache/gpu.lock').open('a')
        fcntl.flock(lock, fcntl.LOCK_EX)  # a reconstruction is running
        try:
            job = self.client.post('/viewforge/objects/masks', json=dict(object='chair', images=images)).json()
            self.assertEqual(self.wait(job['id'])['status'], 'complete')
        finally:
            lock.close()

    def test_other_sites_cannot_post(self):
        response = self.client.post('/viewforge/objects/masks', json={}, headers=dict(origin='http://evil.example'))
        self.assertIn('当前页面', response.json()['error'])
        self.assertEqual(self.client.get('/viewforge/objects/jobs/' + '0' * 32).status_code, 404)
        self.assertEqual(self.client.get('/viewforge/objects/previews/x/../../etc.png').status_code, 404)


if __name__ == '__main__':
    unittest.main()
