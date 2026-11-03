"""Offline API/worker integration. No GPU, agent CLI, credentials or real captures used."""
import io
import json
import shutil
from pathlib import Path
import stat
import struct
import sys
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


def archive(extra=None):
    output = io.BytesIO()
    files = {'scan/room.usdz': b'scan', 'scan/frame_00000.json': b'{}',
             'scan/depth_00000.png': b'depth', 'scan/frame_00000.jpg': b'image'}
    files.update(extra or {})
    with zipfile.ZipFile(output, 'w') as bundle:
        for name, data in files.items():
            bundle.writestr(name, data)
    output.seek(0)
    return output


class ScanValidation(unittest.TestCase):
    def test_valid_capture_and_nested_roomplan(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(service.extract_scan(archive(), Path(root)).name, 'scan')

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

    def test_missing_capture_and_limits(self):
        for data in [b'not a zip', archive({'scan/frame_00000.json': b'{}'}).getvalue()]:
            with tempfile.TemporaryDirectory() as root:
                if data == b'not a zip':
                    with self.assertRaises(zipfile.BadZipFile): service.extract_scan(io.BytesIO(data), Path(root))
                else:
                    with patch.object(service, 'MAX_EXPANDED', 1), self.assertRaises(ValueError):
                        service.extract_scan(io.BytesIO(data), Path(root))


class APIIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.jobs = service.Jobs(self.root / 'jobs', Path.cwd(), runner='cli')
        worker_handler = type('WorkerHandler', (service.Handler,), {'jobs': self.jobs, 'log_message': lambda *args: None})
        self.worker = service.ThreadingHTTPServer(('127.0.0.1', 0), worker_handler)
        threading.Thread(target=self.worker.serve_forever, daemon=True).start()
        proxy_handler = type('ProxyHandler', (serve.Handler,), {
            'room_backend': f'http://127.0.0.1:{self.worker.server_port}', 'log_message': lambda *args: None})
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

    def submit(self):
        return self.request('/room-reconstruction/jobs', archive().getvalue(),
                            {'X-Upload-ID': self.identifier, 'X-Room-Name': quote('测试客厅'), 'Content-Type': 'application/zip'})

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

    def test_failure_retry_and_restart(self):
        self.submit()
        with patch.object(self.jobs, 'execute', side_effect=RuntimeError('测试失败')):
            self.jobs.run_one(self.identifier)
        self.assertEqual(self.request('/room-reconstruction/jobs')['jobs'][0]['status'], 'failed')
        self.assertEqual(self.request('/room-reconstruction/jobs/' + self.identifier + '/retry', b'')['status'], 'queued')
        restored = service.Jobs(self.jobs.root, Path.cwd())
        self.assertEqual(restored.pending.get_nowait(), self.identifier)
        record = restored.records[self.identifier]; record['status'] = 'running'; restored.save(record)
        restarted = service.Jobs(self.jobs.root, Path.cwd())
        self.assertEqual(restarted.records[self.identifier]['status'], 'failed')

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
                self.assertEqual(error.exception.code, code, path)
        finally:
            listener.close()

    def test_route_allowlist(self):
        for path in ['/room-reconstruction/assets/' + self.identifier + '/../../secret',
                     '/room-reconstruction/assets/' + self.identifier + '/%2e%2e', '/room-reconstruction/admin']:
            self.assertIsNone(serve.room_forwarded(path))


if __name__ == '__main__':
    unittest.main()
