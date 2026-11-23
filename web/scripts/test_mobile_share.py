import hashlib
import io
import os
import json
import re
import struct
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import urljoin
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mobile_share import SnapshotStore, ShareHandler, LazyShareServer, SnapshotJanitor, lan_addresses, validate_glb
from unittest.mock import patch


def glb(external=False):
    document = {'asset': {'version': '2.0'}, 'nodes': [{'extras': {'roomcanvas': {
        'schema': 1, 'name': '测试房间', 'version': '12345678-1234-1234-1234-123456789abc',
        'createdAt': '2026-11-16T12:00:00Z', 'floorY': 0, 'units': 'm',
    }}}], 'buffers': [{'byteLength': 4}]}
    if external:
        document['images'] = [{'uri': '/source/private.png'}]
    raw = json.dumps(document).encode()
    raw += b' ' * (-len(raw) % 4)
    return struct.pack('<4sIIII', b'glTF', 2, 20 + len(raw) + 12, len(raw), 0x4e4f534a) + raw + struct.pack('<II', 4, 0x004e4942) + b'\0' * 4


class MobileShareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SnapshotStore(Path(self.temp.name) / 'shares')

    def tearDown(self):
        self.temp.cleanup()

    def test_expiry_uses_server_file_time_and_preserves_unrelated_files(self):
        data = glb()
        old = self.store.create(io.BytesIO(data), len(data))
        fresh = self.store.create(io.BytesIO(data), len(data))
        manifest = self.store.directory / old['id'] / 'manifest.json'
        stamp = time.time() - 8 * 86400
        os.utime(manifest, (stamp, stamp))
        unrelated = self.store.directory / 'notes'; unrelated.mkdir()
        alias = self.store.directory / ('a' * 32); alias.symlink_to(unrelated, target_is_directory=True)
        with (self.store.directory / old['id'] / 'room.glb').open('rb') as download:
            self.assertEqual(self.store.cleanup(), 1)
            self.assertEqual(download.read(), data, 'already-open downloads remain usable')
        self.assertTrue(unrelated.is_dir()); self.assertTrue(alias.is_symlink())
        self.assertTrue((self.store.directory / fresh['id']).is_dir())
        self.assertFalse(self.store.expired(fresh['id']), 'client createdAt does not expire new uploads')
        self.assertEqual(self.store.cleanup(), 0)

    def test_expired_links_are_unavailable_before_cleanup(self):
        data = glb(); share = self.store.create(io.BytesIO(data), len(data))
        manifest = self.store.directory / share['id'] / 'manifest.json'
        stamp = time.time() - 8 * 86400; os.utime(manifest, (stamp, stamp))
        lazy = LazyShareServer(self.store, '127.0.0.1', 0)
        port = lazy.ensure_started()
        try:
            for suffix in ['', 'manifest.json', 'room.glb']:
                for method in ['GET', 'HEAD']:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/s/{share['id']}/{suffix}", method=method))
                    self.assertEqual(error.exception.code, 410)
        finally:
            lazy.close()

    def test_retention_setting_and_publish_cleanup(self):
        data = glb(); old = self.store.create(io.BytesIO(data), len(data))
        stamp = time.time() - 2 * 86400
        os.utime(self.store.directory / old['id'] / 'manifest.json', (stamp, stamp))
        self.assertFalse(self.store.expired(old['id']))
        shorter = SnapshotStore(self.store.directory, retention_days=1)
        self.assertTrue(shorter.expired(old['id']))
        fresh = shorter.create(io.BytesIO(data), len(data))
        self.assertFalse((self.store.directory / old['id']).exists())
        self.assertTrue((self.store.directory / fresh['id']).exists())
        for days in [0, 366]:
            with self.assertRaises(ValueError): SnapshotStore(self.store.directory, days)
        with patch.object(shorter, 'cleanup', side_effect=OSError('unavailable')), self.assertLogs('mobile_share', level='WARNING'):
            kept = shorter.create(io.BytesIO(data), len(data))
        self.assertTrue((self.store.directory / kept['id'] / 'room.glb').is_file())

    def test_lazy_start_is_single_and_retries_a_busy_port(self):
        from concurrent.futures import ThreadPoolExecutor
        import socket
        with socket.socket() as occupied:
            occupied.bind(('127.0.0.1', 0)); occupied.listen()
            lazy = LazyShareServer(self.store, '127.0.0.1', occupied.getsockname()[1])
            self.assertIsNone(lazy.server)
            with self.assertRaises(OSError): lazy.ensure_started()
            self.assertIsNone(lazy.server)
        try:
            with ThreadPoolExecutor(max_workers=4) as pool:
                ports = list(pool.map(lambda _: lazy.ensure_started(), range(4)))
            self.assertEqual(len(set(ports)), 1)
        finally:
            lazy.close()
        with self.assertRaises(OSError): lazy.ensure_started()

    def test_periodic_cleanup_stops_cleanly(self):
        completed = threading.Event()
        calls = []
        def cleanup():
            calls.append(1)
            if len(calls) >= 2: completed.set()
        with patch.object(self.store, 'cleanup', side_effect=cleanup):
            janitor = SnapshotJanitor(self.store, interval=.01)
            janitor.start()
            try: self.assertTrue(completed.wait(2))
            finally: janitor.close()
            self.assertFalse(janitor.thread.is_alive())

    def test_lan_candidates_exclude_tunnels_and_non_rfc1918_ranges(self):
        interfaces = 'en0: flags\n\tinet 192.168.1.8\nen1: flags\n\tinet 10.1.2.3\nutun4: flags\n\tinet 10.9.0.1\ntun0: flags\n\tinet 198.18.0.1\nlo0: flags\n\tinet 127.0.0.1\n'
        dns = [(None, None, None, None, (host, 0)) for host in ['10.9.0.1', '198.18.0.2', '169.254.1.1', '8.8.8.8']]
        with patch('mobile_share.socket.getaddrinfo', return_value=dns), patch('mobile_share.subprocess.check_output', side_effect=[interfaces, '192.168.1.8\n']):
            self.assertEqual(lan_addresses(), ['192.168.1.8', '10.1.2.3'])

    def test_editor_config_is_passive_and_only_authorized_publish_starts_listener(self):
        from serve import Handler
        class Editor(Handler):
            snapshots = self.store
            sharing = LazyShareServer(self.store, '127.0.0.1', 0)
            def log_message(self, *args): pass
        sharing = Editor.sharing
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Editor, directory=self.temp.name))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        def publish(origin):
            return urllib.request.urlopen(urllib.request.Request(base + '/web/mobile-shares',
                data=glb(), headers={'Origin': origin, 'Content-Type': 'model/gltf-binary'}))
        try:
            with urllib.request.urlopen(base + '/web/mobile-shares/config') as response:
                self.assertTrue(json.load(response)['enabled'])
            self.assertIsNone(sharing.server)
            with self.assertRaises(urllib.error.HTTPError) as error: publish('https://other.example')
            self.assertEqual(error.exception.code, 403); self.assertIsNone(sharing.server)
            with publish(base) as response:
                result = json.load(response); self.assertEqual(response.status, 201)
            self.assertEqual(result['retentionDays'], 7)
            with urllib.request.urlopen(f"http://127.0.0.1:{result['port']}" + result['manifest']['model']['url']) as response:
                self.assertEqual(response.read(), glb())
            Editor.sharing = None
            with urllib.request.urlopen(base + '/web/mobile-shares/config') as response:
                self.assertFalse(json.load(response)['enabled'])
            with self.assertRaises(urllib.error.HTTPError) as error: publish(base)
            self.assertEqual(error.exception.code, 503)
        finally:
            server.shutdown(); server.server_close(); thread.join(); sharing.close()

    def test_atomic_immutable_snapshots_and_hash(self):
        data = glb()
        first = self.store.create(io.BytesIO(data), len(data))
        second = self.store.create(io.BytesIO(data), len(data))
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(first['model']['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual((self.store.directory / first['id'] / 'room.glb').read_bytes(), data)
        self.assertEqual(first['version'], second['version'])

    def test_incomplete_external_and_non_glb_uploads_leave_no_share(self):
        data = glb()
        for contents, length in [(data[:30], len(data)), (b'x' * 50, 50), (glb(True), len(glb(True)))]:
            with self.assertRaises(ValueError):
                self.store.create(io.BytesIO(contents), length)
            self.assertEqual(list(self.store.directory.iterdir()), [])

    def test_read_only_server_exposes_only_snapshot_and_viewer(self):
        data = glb()
        share = self.store.create(io.BytesIO(data), len(data))
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(ShareHandler, store=self.store))
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        base = f'http://127.0.0.1:{server.server_port}'
        try:
            for path in [f"/s/{share['id']}/", share['model']['url'], f"/s/{share['id']}/manifest.json", '/web/mobile/viewer.mjs', '/web/editor/walk.mjs',
                         '/web/mobile/room-visibility.mjs', '/web/editor/placement.mjs', '/web/editor/wall-visibility.mjs', '/web/editor/material-layers.mjs']:
                with urllib.request.urlopen(base + path) as response:
                    self.assertEqual(response.status, 200)
            # Follow the viewer's actual module graph: a new editor dependency must also
            # be reachable through the phone's read-only port, or startup silently stops.
            pending, visited = [base + '/web/mobile/viewer.mjs'], set()
            while pending:
                url = pending.pop()
                if url in visited:
                    continue
                visited.add(url)
                with urllib.request.urlopen(url) as response:
                    source = response.read().decode('utf-8')
                for spec in re.findall(r'''\b(?:from|import)\s*\(?\s*['"]((?:\.{1,2}/|three)[\w./-]*)['"]''', source):
                    if spec == 'three':
                        spec = '/web/vendor/build/three.module.js'
                    elif spec.startswith('three/addons/'):
                        spec = '/web/vendor/examples/jsm/' + spec[len('three/addons/'):]
                    pending.append(urljoin(url, spec))
            for path in ['/', '/.git/config', '/web/rooms.json', '/web/scripts/serve.py', '/web/mobile/../scripts/serve.py', '/s/../manifest.json', '/viewforge/assets/catalog', '/room-reconstruction/health']:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(base + path)
                self.assertEqual(error.exception.code, 404)
            for method in ['POST', 'DELETE', 'PUT', 'PATCH']:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(urllib.request.Request(base + share['model']['url'], data=b'x', method=method))
                self.assertEqual(error.exception.code, 405)
            with urllib.request.urlopen(urllib.request.Request(base + share['model']['url'], method='HEAD')) as response:
                self.assertEqual(int(response.headers['Content-Length']), len(data))
                self.assertEqual(response.read(), b'')
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
