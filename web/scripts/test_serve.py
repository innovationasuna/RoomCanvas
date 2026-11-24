"""python3 -m unittest discover -s web/scripts"""
import sys
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import Handler, RoomDeletions, Tunnel as SSHTunnel, forwarded, open_tunnel, room_forwarded, tunnel_command  # noqa: E402


class ScriptLoading(unittest.TestCase):
    def test_run_path_without_preconfigured_script_directory(self):
        import subprocess
        import tempfile
        script = Path(__file__).resolve().with_name('serve.py')
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, '-I', '-c',
                 'import runpy, sys; runpy.run_path(sys.argv[1])', str(script)],
                cwd=directory, capture_output=True, text=True, timeout=10,
            )
        self.assertEqual(result.returncode, 0, result.stderr)


class RoomDeletion(unittest.TestCase):
    def test_removal_persists_and_is_idempotent(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state/deleted.json'
            store = RoomDeletions(path)
            self.assertEqual(store.read(), set())
            store.remove('office')
            store.remove('office')
            store.remove('scan-' + 'a' * 32)
            self.assertEqual(RoomDeletions(path).read(), {'office', 'scan-' + 'a' * 32})
            store.restore('office')
            store.restore('office')
            self.assertEqual(RoomDeletions(path).read(), {'scan-' + 'a' * 32})

    def test_http_delete_filters_manifest_and_rejects_cross_origin(self):
        import tempfile
        import threading
        import json
        import urllib.request
        import urllib.error
        from http.server import ThreadingHTTPServer
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            class LocalHandler(Handler):
                deletions = RoomDeletions(Path(directory) / 'deleted.json')
                cache = Path(directory) / 'room-cache'
                def log_message(self, *args):
                    pass
            server = ThreadingHTTPServer(('127.0.0.1', 0), LocalHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                request = urllib.request.Request(base + '/web/rooms/office', method='DELETE')
                with urllib.request.urlopen(request) as response:
                    self.assertEqual(json.load(response), {'deleted': 'office'})
                # Simulate an unavailable reconstruction service; static rooms still work.
                original = urllib.request.urlopen
                def offline_backend(request, *args, **kwargs):
                    if isinstance(request, str) and '/room-reconstruction/' in request:
                        raise OSError('offline')
                    return original(request, *args, **kwargs)
                with patch('serve.urllib.request.urlopen', side_effect=offline_backend):
                    with original(base + '/web/rooms.json') as response:
                        data = json.load(response)
                    with original(base + '/web/rooms/trash') as response:
                        trash = json.load(response)['rooms']
                self.assertEqual([room['name'] for room in trash], ['办公室'])
                self.assertEqual(trash[0]['dir'], '../samples/office')
                self.assertNotIn('office', [room['id'] for room in data['rooms']])
                self.assertIn('room3', [room['id'] for room in data['rooms']])
                self.assertEqual(data['deleted'], ['office'])
                for path, headers, code in [('/web/rooms/room3', {'Origin': 'https://other.test'}, 403),
                                             ('/web/rooms/../README.md', {}, 404)]:
                    with self.assertRaises(urllib.error.HTTPError) as failure:
                        original(urllib.request.Request(base + path, method='DELETE', headers=headers))
                    self.assertEqual(failure.exception.code, code)
                self.assertEqual(LocalHandler.deletions.read(), {'office'})
                with self.assertRaises(urllib.error.HTTPError) as failure:
                    original(urllib.request.Request(base + '/web/rooms/office/restore', method='POST',
                                                   headers={'Origin': 'https://other.test'}))
                self.assertEqual(failure.exception.code, 403)
                self.assertEqual(LocalHandler.deletions.read(), {'office'})
                with original(urllib.request.Request(base + '/web/rooms/office/restore', method='POST')) as response:
                    self.assertEqual(json.load(response), {'restored': 'office'})
                with patch('serve.urllib.request.urlopen', side_effect=offline_backend):
                    with original(base + '/web/rooms.json') as response:
                        self.assertIn('office', [room['id'] for room in json.load(response)['rooms']])
                    with original(base + '/web/rooms/trash') as response:
                        self.assertEqual(json.load(response), {'rooms': []})
                    # Existing scan IDs remain recoverable even when their service is offline.
                    scan = 'scan-' + 'a' * 32
                    LocalHandler.deletions.remove(scan)
                    with original(base + '/web/rooms/trash') as response:
                        offline = json.load(response)['rooms']
                    self.assertEqual([room['id'] for room in offline], [scan])
                # A running scan has a name and status even before it has a catalog entry.
                from io import BytesIO
                def live_backend(request, *args, **kwargs):
                    if isinstance(request, str) and request.endswith('/room-reconstruction/jobs'):
                        return BytesIO(json.dumps({'jobs': [{'id': 'a' * 32, 'name': '我的客厅', 'status': 'running'}]}).encode())
                    return offline_backend(request, *args, **kwargs)
                with patch('serve.urllib.request.urlopen', side_effect=live_backend):
                    with original(base + '/web/rooms/trash') as response:
                        running = json.load(response)['rooms']
                self.assertEqual(running[0]['name'], '我的客厅')
                self.assertEqual(running[0]['status'], 'running')
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


class Forwarding(unittest.TestCase):
    def test_only_the_editor_reads_go_to_viewforge(self):
        run = '20260926_sofa_web_114146_561893'
        for path in ['/viewforge/assets/catalog', f'/viewforge/assets/{run}',
                     f'/viewforge/assets/{run}/result.glb', f'/viewforge/assets/{run}/preview.glb?x=1',
                     f'/viewforge/assets/{run}/collision.glb',
                     f'/viewforge/assets/{run}/result.ply', f'/viewforge/assets/{run}/preview.json',
                     '/viewforge/layouts/catalog', f'/viewforge/layouts/assets/{run}',
                     f'/viewforge/layouts/assets/{run}/result.glb', f'/viewforge/layouts/assets/{run}/preview.glb?x=1']:
            self.assertEqual(forwarded(path), path.split('?')[0])
        for path in ['/web/', '/viewforge/layouts/save', '/viewforge/layouts/viewer', '/viewforge/layouts/rooms/office.glb',
                     '/viewforge/layouts/assets/../secret', f'/viewforge/layouts/assets/{run}/other.glb',
                     '/viewforge/assets/../secret', f'/viewforge/assets/{run}/other.glb', '/gradio_api/file=/etc/passwd']:
            self.assertIsNone(forwarded(path))

    def test_adding_an_object_goes_to_viewforge(self):
        job, chair = 'a' * 32, quote('20261018_我的椅子_web_101010_000001')
        for path in [f'/viewforge/objects/jobs/{job}', f'/viewforge/objects/previews/20261018_101010_ab12cd34/{quote("我的椅子_001")}.png',
                     f'/viewforge/assets/{chair}', f'/viewforge/assets/{chair}/result.glb', f'/viewforge/assets/{chair}/preview.json']:
            self.assertEqual(forwarded(path), path)
        for path in ['/viewforge/objects/create', '/viewforge/objects/capture', '/viewforge/objects/masks', '/viewforge/objects/reconstruct', f'/viewforge/dimensions/{chair}']:
            self.assertEqual(forwarded(path, 'POST'), path)
            self.assertIsNone(forwarded(path))
        for path in ['/viewforge/layouts/save', f'/viewforge/assets/{chair}', '/viewforge/objects/jobs', f'/viewforge/dimensions/{chair}/model.glb',
                     '/viewforge/dimensions/..', '/web/editor/index.html']:
            self.assertIsNone(forwarded(path, 'POST'))
        self.assertIsNone(forwarded('/viewforge/objects/previews/x/%2E%2E%2Fsecret.png'))


class RoomReplay(unittest.TestCase):
    def test_only_a_jobs_replay_reads_go_to_the_room_service(self):
        job = '0123456789abcdef0123456789abcdef'
        for path in [f'/room-reconstruction/jobs/{job}/replay', f'/room-reconstruction/jobs/{job}/replay/scaffold/points.bin',
                     f'/room-reconstruction/jobs/{job}/replay/scaffold/layout.json',
                     f'/room-reconstruction/jobs/{job}/replay/files/scene_init/obj_stage/traces/img/a_1.jpg']:
            self.assertEqual(room_forwarded(path), path)
        for path in [f'/room-reconstruction/jobs/{job}/replay/files/../job.json', f'/room-reconstruction/jobs/{job}/replay/files/a%2e%2e/b',
                     f'/room-reconstruction/jobs/{job}/replay/scaffold/secret', f'/room-reconstruction/jobs/{job}/replay/x',
                     '/room-reconstruction/jobs/xyz/replay']:
            self.assertIsNone(room_forwarded(path), path)
        self.assertIsNone(room_forwarded(f'/room-reconstruction/jobs/{job}/replay', 'POST'))


class Tunnel(unittest.TestCase):
    def test_ssh_uses_one_gateway_forward_unless_either_service_is_explicit(self):
        from unittest.mock import patch
        import serve
        for options, targets in [
            ([], ['127.0.0.1:7865:127.0.0.1:7870']),
            (['--remote', 'objects:9000'], ['127.0.0.1:7865:objects:9000', '127.0.0.1:7866:127.0.0.1:7866']),
            (['--room-remote', 'rooms:9010'], ['127.0.0.1:7865:127.0.0.1:7862', '127.0.0.1:7866:rooms:9010']),
        ]:
            class TestHandler(Handler):
                pass
            with self.subTest(options=options), patch.object(sys, 'argv', ['serve.py', '--ssh', 'test-host', *options]), \
                    patch.object(serve, 'Handler', TestHandler), patch.object(serve, 'CacheManager'), \
                    patch.object(serve, 'open_tunnel', side_effect=SystemExit) as opening:
                with self.assertRaises(SystemExit):
                    serve.main()
                command, _ = opening.call_args.args
                self.assertEqual([command[i + 1] for i, part in enumerate(command) if part == '-L'], targets)

    def test_command_forwards_the_local_port_to_the_remote_service(self):
        command = tunnel_command('gpu-box', [(7865, '172.18.0.2:7862')])
        self.assertEqual(command[0], 'ssh')
        self.assertIn('-N', command)
        self.assertIn('ExitOnForwardFailure=yes', command)
        self.assertIn('ControlPath=none', command)
        self.assertEqual(command[command.index('-L') + 1], '127.0.0.1:7865:172.18.0.2:7862')
        self.assertEqual(command[-1], 'gpu-box')

    def test_one_connection_forwards_objects_and_rooms(self):
        command = tunnel_command('gpu-box', [(7865, '172.18.0.2:7862'), (7866, '127.0.0.1:7866')])
        forwards = [command[i + 1] for i, part in enumerate(command) if part == '-L']
        self.assertEqual(forwards, ['127.0.0.1:7865:172.18.0.2:7862', '127.0.0.1:7866:127.0.0.1:7866'])
        self.assertEqual(command[-1], 'gpu-box')

    def test_cpa_is_forwarded_back_from_the_server(self):
        command = tunnel_command('autodl', [(7865, '127.0.0.1:7870')], [8317])
        self.assertEqual(command[command.index('-R') + 1], '127.0.0.1:8317:127.0.0.1:8317')
        self.assertEqual(command[-1], 'autodl')
        self.assertNotIn('-R', tunnel_command('autodl', [(7865, '127.0.0.1:7870')]))

    def test_a_dropped_tunnel_is_started_again(self):
        import subprocess
        import tempfile
        import time
        with tempfile.TemporaryDirectory() as folder:
            starts = Path(folder) / 'starts'
            # each "ssh" records a start and exits at once, like a connection the gateway drops
            command = [sys.executable, '-c', f'open({str(starts)!r}, "a").write("x")']
            tunnel = SSHTunnel(command, subprocess.Popen(command), check=0.1)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and len(starts.read_text() if starts.exists() else '') < 2:
                time.sleep(0.1)
            tunnel.close()
            self.assertGreaterEqual(len(starts.read_text()), 2)

    def test_remote_must_be_address_and_port(self):
        for remote in ['172.18.0.2', '7862', 'a b:1', 'host:port']:
            with self.assertRaises(ValueError):
                tunnel_command('gpu-box', [(7865, '127.0.0.1:7862'), (7866, remote)])

    def test_a_tunnel_that_exits_stops_the_server_with_a_message(self):
        with self.assertRaises(SystemExit) as stop:
            open_tunnel([sys.executable, '-c', 'raise SystemExit(255)'], [1], wait=5)
        self.assertIn('SSH tunnel failed (exit 255)', str(stop.exception.code))

    def test_a_port_already_in_use_is_refused_before_starting_ssh(self):
        import socket
        with socket.socket() as busy:
            busy.bind(('127.0.0.1', 0))
            busy.listen()
            port = busy.getsockname()[1]
            with self.assertRaises(SystemExit) as stop:
                open_tunnel([sys.executable, '-c', 'raise SystemExit("ssh must not start")'], [1, port], wait=5)
        self.assertIn(f'Port {port} is already in use', str(stop.exception.code))


class SampleModels(unittest.TestCase):
    def test_start_up_fetches_only_missing_models_and_never_stops_the_server(self):
        from unittest.mock import patch
        import serve
        lines = []
        with patch.object(serve.fetch_samples, 'fetch', return_value=[]) as fetch:
            serve.fetch_sample_models(log=lines.append)
            serve.fetch_sample_models(download=False, log=lines.append)  # --no-download
        self.assertEqual([call.kwargs for call in fetch.call_args_list],
                         [{'check': False, 'missing_only': True, 'log': lines.append, 'cache': None}])
        self.assertEqual(len(lines), 1)
        self.assertIn('后台模型下载已关闭', lines[0])
        lines.clear()
        started = []  # continue with room prefetch even if the sample check failed
        with patch.object(serve.fetch_samples, 'fetch', side_effect=FileNotFoundError('samples/models.json')):
            self.assertIsNone(serve.fetch_sample_models(log=lines.append, then=lambda: started.append(1)))
        self.assertEqual(lines, ['Sample models not checked (samples/models.json): samples/models.json'])
        self.assertEqual(started, [1])


if __name__ == '__main__':
    unittest.main()
