"""Offline API/worker integration. No GPU, agent CLI, credentials or real captures used."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
import shutil
from pathlib import Path
import stat
import struct
import sys
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import quote
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import room_service as service
import serve

CAMERA = json.dumps({"intrinsics": [1, 0, 0, 0, 1, 0, 0, 0, 1],
                     "cameraPoseARFrame": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                     "projectionMatrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}).encode()


def archive(extra=None, kind='zip', files=None):
    output = io.BytesIO()
    files = dict(files) if files is not None else {
        'scan/room.usdz': b'scan', 'scan/frame_00000.json': CAMERA,
        'scan/depth_00000.png': b'depth', 'scan/frame_00000.jpg': b'image'}
    files.update(extra or {})
    if kind == 'zip':
        with zipfile.ZipFile(output, 'w') as bundle:
            for name, data in files.items():
                bundle.writestr(name, data)
    else:
        with tarfile.open(fileobj=output, mode='w:gz' if kind == 'tar.gz' else 'w') as bundle:
            for name, data in files.items():
                item = tarfile.TarInfo(name)
                item.size = len(data)
                bundle.addfile(item, io.BytesIO(data))
    output.seek(0)
    return output


class ScanValidation(unittest.TestCase):
    def test_valid_capture_and_nested_roomplan(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(service.extract_scan(archive(), Path(root)).name, 'scan')

    def test_scanner_point_cloud_is_kept(self):  # LiteReality Scanner ships pointcloud.pcd; ingest prefers it
        with tempfile.TemporaryDirectory() as root:
            capture = service.extract_scan(archive({'scan/pointcloud.pcd': b'pcd'}), Path(root))
            self.assertTrue((capture / 'pointcloud.pcd').is_file())

    def test_reject_traversal_symlinks_scripts_and_multiple_rooms(self):
        for bad in [{'../outside.txt': b'no'}, {'/tmp/no.txt': b'no'}, {'scan/run.py': b'no'},
                    {'other/room.usdz': b'no'}, {'scan/scene.json': b'{}'}]:
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    service.extract_scan(archive(bad), Path(root))
        buf = archive()
        with zipfile.ZipFile(buf, 'a') as bundle:
            item = zipfile.ZipInfo('scan/link.txt'); item.external_attr = (stat.S_IFLNK | 0o777) << 16
            bundle.writestr(item, '/tmp/no')
        buf.seek(0)
        with tempfile.TemporaryDirectory() as root, self.assertRaises(ValueError):
            service.extract_scan(buf, Path(root))

    def test_the_scanner_tar_is_accepted_as_exported(self):
        """LiteReality Scanner exports a tar: ./ paths, roomplan/ and images/ folders, macOS ._ files."""
        def tar(files, mode='w', links=()):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode=mode) as bundle:
                for name, data in files.items():
                    info = tarfile.TarInfo(name); info.size = len(data)
                    bundle.addfile(info, io.BytesIO(data))
                for name, target in links:
                    info = tarfile.TarInfo(name); info.type = tarfile.SYMTYPE; info.linkname = target
                    bundle.addfile(info)
            output.seek(0)
            return output
        usdz = io.BytesIO()  # a .usdz is a ZIP: a tar ending with one must still be read as a tar
        with zipfile.ZipFile(usdz, 'w') as inner:
            inner.writestr('room.usdc', b'usd')
        files = {'./roomplan/room.usdz': b'scan', './frame_00000.json': CAMERA,
                 './depth_00000.png': b'depth', './images/frame_00000.jpg': b'image', './pointcloud.pcd': b'pcd',
                 './._frame_00000.json': b'mac', './room.usdz': usdz.getvalue()}
        for mode in ('w', 'w:gz'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                capture = service.extract_scan(tar(files, mode), Path(root))
                self.assertEqual(capture, Path(root))
                self.assertTrue((capture / 'images/frame_00000.jpg').is_file())
                self.assertFalse((capture / '._frame_00000.json').exists())
        for bad, links in [({'../outside.json': b'{}'}, ()), ({}, [('./link.json', '/etc/passwd')])]:
            with self.subTest(bad=bad, links=links), tempfile.TemporaryDirectory() as root:
                with self.assertRaises(ValueError):
                    service.extract_scan(tar({**files, **bad}, links=links), Path(root))

    def test_missing_capture_and_limits(self):
        for data in [b'not a zip', archive({'scan/frame_00000.json': CAMERA}).getvalue()]:
            with tempfile.TemporaryDirectory() as root:
                if data == b'not a zip':
                    with self.assertRaisesRegex(ValueError, 'ZIP 或 tar'): service.extract_scan(io.BytesIO(data), Path(root))
                else:
                    with patch.object(service, 'MAX_EXPANDED', 1), self.assertRaises(ValueError):
                        service.extract_scan(io.BytesIO(data), Path(root))

    def test_incomplete_camera_matrices_are_rejected_before_queueing(self):
        with tempfile.TemporaryDirectory() as root, self.assertRaisesRegex(ValueError, 'frame_00000.json'):
            service.extract_scan(archive({'scan/frame_00000.json': b'{}'}), Path(root))

    def test_tar_and_gzip_preserve_scan_data_with_nested_layouts(self):
        for kind in ['tar', 'tar.gz']:
            for prefix in ['', './扫描房间/']:
                files = {prefix + 'roomplan/room.usdz': b'scan', prefix + 'images/frame_00000.json': CAMERA,
                         prefix + 'images/depth_00000.png': b'depth', prefix + 'images/frame_00000.jpg': b'image',
                         prefix + '._room.usdz': b'mac metadata', '__MACOSX/._room.usdz': b'mac metadata'}
                with self.subTest(kind=kind, prefix=prefix), tempfile.TemporaryDirectory() as root:
                    capture = service.extract_scan(archive(kind=kind, files=files), Path(root))
                    self.assertEqual((capture / 'roomplan/room.usdz').read_bytes(), b'scan')
                    self.assertEqual((capture / 'images/depth_00000.png').read_bytes(), b'depth')
                    self.assertFalse((capture / '._room.usdz').exists())

    def test_tar_rejects_invalid_contents_and_duplicate_paths(self):
        for kind in ['tar', 'tar.gz']:
            for extra in [{'../outside.txt': b'no'}, {'/tmp/no.txt': b'no'}, {'scan\\bad.txt': b'no'},
                          {'C:/bad.txt': b'no'}, {'scan/run.py': b'no'}, {'other/room.usdz': b'no'},
                          {'scan/scene.json': b'{}'}, {'./scan/room.usdz': b'duplicate'},
                          {'scan/ROOM.usdz': b'case duplicate'}]:
                with self.subTest(kind=kind, extra=extra), tempfile.TemporaryDirectory() as root:
                    with self.assertRaises(ValueError):
                        service.extract_scan(archive(extra, kind=kind), Path(root))

    def test_tar_rejects_links_and_special_files_even_in_metadata(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            for name in ['scan/link.txt', '__MACOSX/._link.txt']:
                buf = archive(kind='tar')
                with tarfile.open(fileobj=buf, mode='a') as bundle:
                    item = tarfile.TarInfo(name); item.type = kind; item.linkname = 'scan/room.usdz'
                    bundle.addfile(item)
                buf.seek(0)
                with self.subTest(kind=kind, name=name), tempfile.TemporaryDirectory() as root:
                    with self.assertRaisesRegex(ValueError, '链接、特殊文件'):
                        service.extract_scan(buf, Path(root))

    def test_tar_limits_and_missing_scan_files(self):
        for kind in ['tar', 'tar.gz']:
            for limit, value in [('MAX_EXPANDED', 1), ('MAX_ENTRIES', 3)]:
                with self.subTest(kind=kind, limit=limit), tempfile.TemporaryDirectory() as root:
                    with patch.object(service, limit, value), self.assertRaisesRegex(ValueError, '过大'):
                        service.extract_scan(archive(kind=kind), Path(root))
            for files in [{}, {'room.usdz': b'scan'}, {'room.usdz': b'scan', 'frame_00000.json': CAMERA, 'depth_00000.png': b'depth'}]:
                with self.subTest(kind=kind, files=files), tempfile.TemporaryDirectory() as root:
                    with self.assertRaises(ValueError):
                        service.extract_scan(archive(kind=kind, files=files), Path(root))


class Preview(unittest.TestCase):
    """--preview (no GPU): health says so and new or retried reconstructions are refused."""
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        jobs = service.Jobs(Path(self.temp.name) / 'jobs', Path.cwd(), runner='cli')
        handler = type('PreviewHandler', (service.Handler,), {'jobs': jobs, 'preview': True, 'log_message': lambda *args: None})
        self.server = service.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}/room-reconstruction'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        self.temp.cleanup()

    def test_health_reports_preview_and_uploads_are_refused(self):
        with urlopen(self.base + '/health', timeout=10) as response:
            self.assertTrue(json.loads(response.read())['preview'])
        for path in ['/jobs', '/jobs/' + 'a' * 32 + '/retry']:
            with self.assertRaises(HTTPError) as caught:
                urlopen(Request(self.base + path, data=b'x', headers={'X-Upload-ID': 'b' * 32, 'X-Room-Name': 'r'}), timeout=10)
            self.assertEqual(caught.exception.code, 503)
            self.assertIn('GPU', json.loads(caught.exception.read())['error'])


class APIIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.jobs = service.Jobs(self.root / 'jobs', Path.cwd(), runner='cli')
        worker_handler = type('WorkerHandler', (service.Handler,), {'jobs': self.jobs, 'log_message': lambda *args: None})
        self.worker = service.ThreadingHTTPServer(('127.0.0.1', 0), worker_handler)
        threading.Thread(target=self.worker.serve_forever, daemon=True).start()
        proxy_handler = type('ProxyHandler', (serve.Handler,), {
            'deletions': serve.RoomDeletions(self.root / 'deleted-rooms.json'),
            'room_backend': f'http://127.0.0.1:{self.worker.server_port}', 'cache': self.root / 'room-cache',
            'log_message': lambda *args: None})
        self.proxy = serve.Server(('127.0.0.1', 0), proxy_handler)
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.proxy.server_port}'
        self.identifier = 'a' * 32

    def tearDown(self):
        for server in (self.proxy, self.worker):
            server.shutdown(); server.server_close()
        self.temp.cleanup()

    def request(self, path, data=None, headers=None):
        with urlopen(Request(self.base + path, data=data, headers=headers or {}), timeout=10) as response:
            return json.load(response)

    def submit(self, kind='zip'):
        return self.request('/room-reconstruction/jobs', archive(kind=kind).getvalue(),
                            {'X-Upload-ID': self.identifier, 'X-Room-Name': quote('测试客厅'),
                             'Content-Type': 'application/zip' if kind == 'zip' else 'application/octet-stream'})

    def fake_pipeline(self, args, log):
        if 'litereality' not in args:
            return self.original_execute(args, log)  # Real room_objects.py validates the generated fixture.
        self.assertIn('--through', args)
        self.assertEqual(args[-1], 'publish')
        out = Path(args[args.index('--output-root') + 1]) / 'scan'
        preview = out / 'realism_authoring/room_preview'
        preview.mkdir(parents=True)
        layout = {'objects': [{'id': 'Floor', 'category': 'floor', 'bbox_min': [0, 0, 0], 'bbox_max': [4, 4, .1]}]}
        (preview / 'room_layout.json').write_text(json.dumps(layout))
        doc = json.dumps({'asset': {'version': '2.0'}, 'nodes': [{'name': 'Floor'}]}).encode()
        doc += b' ' * (-len(doc) % 4)
        (preview / 'Room.glb').write_bytes(struct.pack('<4sIIII', b'glTF', 2, 20 + len(doc), len(doc), 0x4e4f534a) + doc)
        state = out / '.litereality/pipeline.json'; state.parent.mkdir()
        state.write_text(json.dumps({'stages': {name: {'status': 'completed'} for name in service.STAGES}}))

    def test_upload_queue_publish_manifest_and_asset_access(self):
        self.assertTrue(self.request('/room-reconstruction/health')['ok'])
        self.assertEqual(self.submit()['status'], 'queued')
        self.submit()  # Same upload ID cannot launch a duplicate job.
        self.assertEqual(len(self.request('/room-reconstruction/jobs')['jobs']), 1)
        self.original_execute = self.jobs.execute
        with patch.object(self.jobs, 'execute', side_effect=self.fake_pipeline):
            self.jobs.run_one(self.identifier)
        job = self.request('/room-reconstruction/jobs/' + self.identifier)
        self.assertEqual(job['status'], 'completed', job)
        timing = self.jobs.records[self.identifier]['timing']
        self.assertGreaterEqual(timing['queue_seconds'], 0)
        self.assertGreater(timing['execution_seconds'], 0)
        self.assertEqual(len(job['stages']), 5)
        catalog = self.request('/web/rooms.json')['rooms']
        self.assertTrue(any(r['name'] == '测试客厅' for r in catalog))
        objects = self.request(job['room']['dir'] + '/room_objects.json')
        self.assertEqual(objects['floor'], 'Floor')
        with urlopen(self.base + job['room']['dir'] + '/Room.glb') as response:
            self.assertEqual(response.read(4), b'glTF')
        with self.assertRaises(HTTPError) as error:
            self.request(job['room']['dir'] + '/task.log')
        self.assertEqual(error.exception.code, 404)

    def test_status_and_duplicate_upload_during_extraction(self):
        entered, release = threading.Event(), threading.Event()
        extract = service.extract_scan

        def pause(archive, destination):
            entered.set()
            if not release.wait(10):
                raise RuntimeError('stalled upload')
            return extract(archive, destination)

        with patch.object(service, 'extract_scan', side_effect=pause) as unpack, ThreadPoolExecutor(4) as pool:
            first = pool.submit(self.submit)
            try:
                self.assertTrue(entered.wait(5))
                duplicate = pool.submit(self.submit)
                self.assertTrue(pool.submit(self.request, '/room-reconstruction/health').result(3)['ok'])
                self.assertEqual(pool.submit(self.request, '/room-reconstruction/jobs').result(3)['jobs'], [])
            finally:
                release.set()
            self.assertEqual(first.result()['id'], duplicate.result()['id'])
            unpack.assert_called_once()
        self.assertEqual(self.jobs.pending.qsize(), 1)
        self.assertEqual(list(self.jobs.root.iterdir()), [self.jobs.root / self.identifier])

    def test_failure_retry_and_restart(self):
        self.submit()
        with patch.object(self.jobs, 'execute', side_effect=RuntimeError('测试失败')):
            self.jobs.run_one(self.identifier)
        self.assertEqual(self.request('/room-reconstruction/jobs')['jobs'][0]['status'], 'failed')
        self.assertEqual(self.request('/room-reconstruction/jobs/' + self.identifier + '/retry', b'')['status'], 'queued')
        os.close(self.jobs.owner)  # the service stops
        restored = service.Jobs(self.jobs.root, Path.cwd())
        self.assertEqual(restored.pending.get_nowait(), self.identifier)
        record = restored.records[self.identifier]; record['status'] = 'running'; restored.save(record)
        os.close(restored.owner)
        restarted = service.Jobs(self.jobs.root, Path.cwd())
        self.assertEqual(restarted.records[self.identifier]['status'], 'failed')

    def test_a_second_service_on_the_same_directory_does_not_start(self):
        entered, release = threading.Event(), threading.Event()
        extract = service.extract_scan

        def pause(archive, destination):
            unpacked = extract(archive, destination)
            entered.set()
            release.wait(10)
            return unpacked

        with patch.object(service, 'extract_scan', side_effect=pause), ThreadPoolExecutor(1) as pool:
            upload = pool.submit(self.submit)
            self.assertTrue(entered.wait(5))
            with self.assertRaisesRegex(RuntimeError, '正在使用'):
                service.Jobs(self.jobs.root, Path.cwd())  # a second start while this one still serves
            release.set()
            self.assertEqual(upload.result()['status'], 'queued')
        (self.jobs.root / '.upload-x' / 'capture').mkdir(parents=True)
        os.close(self.jobs.owner)  # the first service stops
        service.Jobs(self.jobs.root, Path.cwd())
        self.assertEqual(list(self.jobs.root.iterdir()), [self.jobs.root / self.identifier])

    def test_only_a_failure_of_the_input_refuses_a_retry(self):
        self.submit()
        state = self.jobs.root / self.identifier / 'output/scan/.litereality/pipeline.json'
        state.parent.mkdir(parents=True)
        retry = '/room-reconstruction/jobs/' + self.identifier + '/retry'
        for category, allowed in [('execution', True), ('input', False)]:
            self.jobs.records[self.identifier]['status'] = 'failed'
            state.write_text(json.dumps({'stages': {'author': {
                'status': 'failed', 'error': 'command exited 1', 'error_category': category, 'retryable': False}}}))
            if allowed:
                self.assertEqual(self.request(retry, b'')['status'], 'queued')
            else:
                with self.assertRaises(HTTPError) as error:
                    self.request(retry, b'')
                self.assertEqual(error.exception.code, 409)

    def test_optional_enhancement_failure_preserves_a_valid_published_room(self):
        self.jobs.runner = 'server'
        self.submit()
        self.original_execute = self.jobs.execute
        def failed_enhancement(args, log):
            if not args[1].endswith('server/run_room.py'):
                return self.original_execute(args, log)
            run = Path(args[3])
            self.fake_pipeline(['litereality', '--output-root', str(run / 'pipeline'), '--through', 'publish'], log)
            attempt = run / 'attempt-01'
            attempt.mkdir()
            (attempt / 'exit').write_text('0')
            (attempt / 'articulate-exit').write_text('1')
            raise RuntimeError('articulation failed')
        with patch.object(self.jobs, 'execute', side_effect=failed_enhancement):
            self.jobs.run_one(self.identifier)
        job = self.jobs.public(self.jobs.records[self.identifier])
        self.assertEqual(job['status'], 'completed')
        self.assertTrue(job['usable'])
        self.assertEqual(job['enhancement']['status'], 'failed')
        self.assertEqual(job['stages'][-1]['status'], 'failed')
        self.assertTrue(job['warnings'])
        old_summary = self.jobs.root / self.identifier / 'run/articulate/summary.json'
        old_summary.parent.mkdir(parents=True)
        old_summary.write_text(json.dumps({'attempt_id': 'attempt-00', 'added': 17, 'failed': 0}))
        self.assertNotIn('added', self.jobs.public(self.jobs.records[self.identifier])['enhancement'])

    def test_a_failed_launch_never_reuses_an_old_successful_attempt(self):
        self.jobs.runner = 'server'
        self.submit()
        folder = self.jobs.root / self.identifier / 'run'
        old = folder / 'attempt-01'
        old.mkdir(parents=True)
        (old / 'exit').write_text('0')
        (old / 'articulate-exit').write_text('0')
        with patch.object(self.jobs, 'execute', side_effect=RuntimeError('launch failed')):
            self.jobs.run_one(self.identifier)
        self.assertEqual(self.jobs.records[self.identifier]['status'], 'failed')

    def test_tar_uploads_through_proxy_and_publishes(self):
        self.original_execute = self.jobs.execute
        for index, kind in enumerate(['tar', 'tar.gz']):
            self.identifier = str(index + 1) * 32
            with self.subTest(kind=kind):
                self.assertEqual(self.submit(kind)['status'], 'queued')
                self.submit(kind)
                capture = Path(self.jobs.records[self.identifier]['capture'])
                self.assertEqual((capture / 'frame_00000.jpg').read_bytes(), b'image')
                with patch.object(self.jobs, 'execute', side_effect=self.fake_pipeline):
                    self.jobs.run_one(self.identifier)
                job = self.request('/room-reconstruction/jobs/' + self.identifier)
                self.assertEqual(job['status'], 'completed', job)
                self.assertEqual(self.request(job['room']['dir'] + '/room_objects.json')['floor'], 'Floor')
        self.assertEqual(len(self.jobs.records), 2, 'repeat uploads never duplicate jobs')

    def test_invalid_archives_return_400_and_leave_no_job(self):
        truncated = archive(kind='tar').getvalue()[:600]
        for body in [b'not an archive', truncated, archive(kind='tar.gz').getvalue()[:30]]:
            with self.subTest(size=len(body)), self.assertRaises(HTTPError) as caught:
                self.request('/room-reconstruction/jobs', body,
                             {'X-Upload-ID': self.identifier, 'X-Room-Name': 'test', 'Content-Type': 'application/octet-stream'})
            self.assertEqual(caught.exception.code, 400)
            self.assertIn('error', json.loads(caught.exception.read()))
            self.assertFalse((self.jobs.root / self.identifier).exists())
            self.assertEqual(self.jobs.records, {})
            self.assertTrue(self.jobs.pending.empty())

    def test_server_runner_keeps_gpu_launcher_and_checks_its_exit_records(self):
        self.jobs.runner = 'server'
        self.submit()
        def failed_server(args, log):
            self.assertTrue(args[1].endswith('server/run_room.py'))
            attempt = Path(args[3]) / 'attempt-01'
            attempt.mkdir(parents=True)
            (attempt / 'exit').write_text('1\n')
        with patch.object(self.jobs, 'execute', side_effect=failed_server):
            self.jobs.run_one(self.identifier)
        self.assertEqual(self.jobs.records[self.identifier]['status'], 'failed')
        self.assertIn('可动部件', self.jobs.records[self.identifier]['error'])

    def test_server_runner_says_when_the_time_limit_stopped_it(self):
        self.jobs.runner = 'server'
        self.submit()
        def timed_out(args, log):
            (Path(args[3]) / 'attempt-01').mkdir(parents=True)
            raise RuntimeError('任务超过运行时限，请检查服务器日志后重试。')
        with patch.object(self.jobs, 'execute', side_effect=timed_out):
            self.jobs.run_one(self.identifier)
        self.assertIn('运行时限', self.jobs.records[self.identifier]['error'])

    def test_server_runner_publishes_articulated_result(self):
        self.jobs.runner = 'server'
        self.submit()
        self.original_execute = self.jobs.execute
        def successful_server(args, log):
            if not args[1].endswith('server/run_room.py'):
                return self.original_execute(args, log)
            run = Path(args[3])
            self.fake_pipeline(['litereality', '--output-root', str(run / 'pipeline'), '--through', 'publish'], log)
            shutil.copytree(run / 'pipeline/scan/realism_authoring/room_preview', run / 'articulate/room_preview')
            attempt = run / 'attempt-01'; attempt.mkdir()
            for name in ('exit', 'articulate-exit'):
                (attempt / name).write_text('0\n')
        with patch.object(self.jobs, 'execute', side_effect=successful_server):
            self.jobs.run_one(self.identifier)
        job = self.request('/room-reconstruction/jobs/' + self.identifier)
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['stages'][-1], {'name': 'articulate', 'status': 'completed'})

    def test_server_runner_publishes_the_room_author_completed(self):
        # The author stage adds the openable parts before its check; publish says how that pass ended.
        self.jobs.runner = 'server'
        self.submit()
        self.original_execute = self.jobs.execute
        def successful_server(args, log):
            if not args[1].endswith('server/run_room.py'):
                return self.original_execute(args, log)
            run = Path(args[3])
            self.fake_pipeline(['litereality', '--output-root', str(run / 'pipeline'), '--through', 'publish'], log)
            authoring = run / 'pipeline/scan/realism_authoring'
            (authoring / 'room_preview/acceptance.json').write_text(json.dumps(
                {'accepted': True, 'passes': {'small_objects': 'ok', 'articulate': 'ok'}}))
            (authoring / 'articulate').mkdir()
            (authoring / 'articulate/summary.json').write_text(json.dumps({'attempt_id': 'attempt-01', 'added': 2, 'existing': 1}))
            attempt = run / 'attempt-01'; attempt.mkdir()
            (attempt / 'exit').write_text('0\n')
        with patch.object(self.jobs, 'execute', side_effect=successful_server):
            self.jobs.run_one(self.identifier)
        job = self.request('/room-reconstruction/jobs/' + self.identifier)
        self.assertEqual(job['status'], 'completed', job)
        self.assertEqual(job['stages'][-1], {'name': 'articulate', 'status': 'completed'})
        self.assertEqual((job['enhancement']['status'], job['enhancement']['added']), ('completed', 2))
        self.assertEqual(self.request(job['room']['dir'] + '/room_objects.json')['floor'], 'Floor')

    def test_cross_origin_and_offline_fallback(self):
        with self.assertRaises(HTTPError) as error:
            self.request('/room-reconstruction/jobs', b'zip', {'Origin': 'https://unrelated.example'})
        self.assertEqual(error.exception.code, 403)
        self.proxy.RequestHandlerClass.room_backend = 'http://127.0.0.1:1'
        self.assertGreaterEqual(len(self.request('/web/rooms.json')['rooms']), 2)
        with self.assertRaises(HTTPError) as error:
            self.request('/room-reconstruction/health')
        self.assertEqual(error.exception.code, 503)

    def test_a_tunnel_with_nothing_behind_it_reports_offline(self):
        # An SSH forward accepts the connection, then resets it when the remote service is down.
        import socket
        listener = socket.socket(); listener.bind(('127.0.0.1', 0)); listener.listen()
        def reset():
            while True:
                try:
                    connection, _ = listener.accept()
                except OSError:
                    return
                connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, b'\x01\x00\x00\x00\x00\x00\x00\x00')
                connection.close()
        threading.Thread(target=reset, daemon=True).start()
        try:
            port = listener.getsockname()[1]
            self.proxy.RequestHandlerClass.room_backend = f'http://127.0.0.1:{port}'
            self.proxy.RequestHandlerClass.viewforge = f'http://127.0.0.1:{port}'
            for path, code in [('/room-reconstruction/health', 503), ('/viewforge/assets/catalog', 502)]:
                with self.assertRaises(HTTPError) as error:
                    self.request(path)
                self.assertEqual(error.exception.code, code, (path, error.exception.read().decode(errors='replace')))
        finally:
            listener.close()

    def test_route_allowlist(self):
        for path in ['/room-reconstruction/assets/' + self.identifier + '/../../secret',
                     '/room-reconstruction/assets/' + self.identifier + '/%2e%2e', '/room-reconstruction/admin']:
            self.assertIsNone(serve.room_forwarded(path))


if __name__ == '__main__':
    unittest.main()
