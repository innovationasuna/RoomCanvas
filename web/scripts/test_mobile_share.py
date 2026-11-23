import hashlib
import io
import json
import re
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from urllib.parse import urljoin
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mobile_share import SnapshotStore, ShareHandler, validate_glb


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
