"""python3 -m unittest discover -s web/scripts"""
import hashlib
import io
import json
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import fetch_samples  # noqa: E402

MODELS = {'office': b'glTF office model', 'room3': b'glTF bedroom model, longer'}


class FetchSamples(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.entries = [{'path': f'samples/{name}/Room.glb', 'tag': 'sample-rooms', 'asset': f'{name}-Room.glb',
                         'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in MODELS.items()]
        (self.root / 'samples').mkdir()
        (self.root / 'samples/models.json').write_text(json.dumps({'repo': 'owner/repo', 'models': self.entries}))
        self.calls, self.lines = [], []

    def release(self, served=MODELS):
        def download(repo, entry, target):
            self.calls.append((repo, entry['tag'], entry['asset']))
            target.write_bytes(served[fetch_samples.room(entry)])
        return download

    def fetch(self, *rooms, **options):
        options.setdefault('ways', [self.release()])
        return fetch_samples.fetch(rooms, root=self.root, log=self.lines.append, **options)

    def files(self):
        return sorted(str(path.relative_to(self.root / 'samples')) for path in (self.root / 'samples').rglob('*') if path.is_file())

    def put(self, name, data):
        path = self.root / f'samples/{name}/Room.glb'
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(data)
        return path

    def test_a_missing_model_is_fetched_and_a_correct_one_left_alone(self):
        kept = self.put('office', MODELS['office'])
        before = kept.stat()
        self.assertEqual(self.fetch(), [])
        self.assertEqual(self.calls, [('owner/repo', 'sample-rooms', 'room3-Room.glb')])
        self.assertEqual((kept.stat().st_ino, kept.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertEqual((self.root / 'samples/room3/Room.glb').read_bytes(), MODELS['room3'])
        self.assertEqual(self.files(), ['models.json', 'office/Room.glb', 'room3/Room.glb'])  # no .part stays
        self.assertEqual(self.fetch(verify=True), [])
        self.assertEqual(len(self.calls), 1)

    def test_a_download_with_the_wrong_hash_or_size_is_rejected_and_leaves_nothing(self):
        same_size = MODELS['office'][:-1] + b'X'
        for served, reason in [(same_size, 'sha256 differs'), (b'glTF cut short', '14 bytes, expected 17')]:
            self.lines.clear()
            left = self.fetch('office', ways=[self.release({'office': served})])
            self.assertEqual([entry['path'] for entry in left], ['samples/office/Room.glb'])
            self.assertEqual(self.files(), ['models.json'])
            self.assertIn(reason, self.lines[1])

    def test_a_failed_download_keeps_the_file_that_was_there(self):
        old = self.put('office', b'an older model')
        def offline(repo, entry, target):
            target.write_bytes(b'half')
            raise fetch_samples.FetchError('gh: connection reset')
        left = self.fetch('office', ways=[offline])
        self.assertEqual(len(left), 1)
        self.assertEqual(old.read_bytes(), b'an older model')
        self.assertEqual(self.files(), ['models.json', 'office/Room.glb'])
        self.assertIn('samples/office/Room.glb: gh: connection reset', self.lines)

    def test_the_next_way_is_tried_when_one_fails(self):
        def failing(repo, entry, target):
            raise fetch_samples.FetchError('gh: release not found')
        self.assertEqual(self.fetch('office', ways=[failing, self.release()]), [])
        self.assertEqual(len(self.calls), 1)

    def test_the_hash_of_a_present_file_is_compared_only_when_asked(self):
        self.put('office', MODELS['office'][:-1] + b'X')
        with patch.object(fetch_samples, 'sha256', side_effect=AssertionError('hashed without --verify')):
            self.assertEqual(self.fetch('office'), [])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.fetch('office', verify=True), [])
        self.assertEqual((self.root / 'samples/office/Room.glb').read_bytes(), MODELS['office'])

    def test_only_the_named_rooms_are_fetched(self):
        self.assertEqual(self.fetch('room3'), [])
        self.assertEqual(self.files(), ['models.json', 'room3/Room.glb'])
        with self.assertRaisesRegex(ValueError, 'no sample model for: attic'):
            self.fetch('attic')

    def test_check_reports_and_downloads_nothing(self):
        self.put('office', MODELS['office'])
        self.put('room3', b'short')
        def never():
            raise AssertionError('--check looked for a way to download')
        output = io.StringIO()
        with patch.object(fetch_samples, 'ROOT', self.root), patch.object(fetch_samples, 'methods', never), redirect_stdout(output):
            self.assertEqual(fetch_samples.main(['--check']), 1)
            self.assertEqual(fetch_samples.main(['--check', 'office']), 0)
        self.assertIn('samples/room3/Room.glb: 5 bytes, expected 26', output.getvalue())
        self.assertNotIn('samples/office/Room.glb', output.getvalue())
        self.assertEqual((self.root / 'samples/room3/Room.glb').read_bytes(), b'short')

    def test_without_a_login_the_message_names_the_files_and_both_ways(self):
        self.put('office', MODELS['office'])
        output = io.StringIO()
        with patch.object(fetch_samples, 'ROOT', self.root), patch.object(fetch_samples, 'methods', lambda: []), redirect_stdout(output):
            self.assertEqual(fetch_samples.main([]), 1)
        text = output.getvalue()
        self.assertIn('samples/room3/Room.glb: no GitHub login (gh CLI or GH_TOKEN)\n', text)
        self.assertEqual(text.count('gh auth login'), 1)
        self.assertIn('https://github.com/owner/repo/releases/download/sample-rooms/room3-Room.glb  ->  samples/room3/Room.glb', text)
        self.assertNotIn('office', text)
        self.assertEqual(self.files(), ['models.json', 'office/Room.glb'])

    def test_start_up_fetches_what_is_missing_but_keeps_a_model_that_differs(self):
        mine = self.put('office', b'a model rebuilt here')
        self.assertEqual(self.fetch(missing_only=True), [])
        self.assertEqual(mine.read_bytes(), b'a model rebuilt here')
        self.assertEqual(self.calls, [('owner/repo', 'sample-rooms', 'room3-Room.glb')])
        self.assertIn('left as it is', self.lines[0])

    def test_gh_comes_first_and_only_when_logged_in_then_the_token(self):
        ran = []
        def gh(code):
            def run(command, **options):
                ran.append(command)
                return type('Done', (), {'returncode': code})()
            return run
        with patch.object(fetch_samples.shutil, 'which', return_value='/usr/bin/gh'):
            with patch.object(fetch_samples.subprocess, 'run', gh(0)):
                ways = fetch_samples.methods({'GITHUB_TOKEN': 'secret'})
            self.assertEqual((ways[0], len(ways)), (fetch_samples.gh_download, 2))
            with patch.object(fetch_samples.subprocess, 'run', gh(1)):
                self.assertEqual(fetch_samples.methods({}), [])
        self.assertEqual(ran[0][:3], ['gh', 'auth', 'token'])
        with patch.object(fetch_samples.shutil, 'which', return_value=None):
            self.assertEqual(len(fetch_samples.methods({'GH_TOKEN': 'secret'})), 1)
            self.assertEqual(fetch_samples.methods({}), [])

    def test_gh_downloads_the_named_asset_to_the_part_file(self):
        def gh(command, **options):
            self.calls.append(command)
            Path(command[command.index('-O') + 1]).write_bytes(MODELS['office'])
            return type('Done', (), {'returncode': 0, 'stderr': ''})()
        with patch.object(fetch_samples.subprocess, 'run', gh):
            self.assertEqual(self.fetch('office', ways=[fetch_samples.gh_download]), [])
        part = str(self.root / 'samples/office/Room.glb.part')
        self.assertEqual(self.calls, [['gh', 'release', 'download', 'sample-rooms', '-R', 'owner/repo', '-p', 'office-Room.glb', '-O', part, '--clobber']])
        self.assertEqual(self.files(), ['models.json', 'office/Room.glb'])


class GitHub(BaseHTTPRequestHandler):
    """The release API on 127.0.0.1; the asset redirects to the same server under another host name."""
    seen = []

    def do_GET(self):
        GitHub.seen.append((self.headers['Host'].split(':')[0], self.path, self.headers.get('Authorization'), self.headers.get('Accept')))
        if self.headers.get('Authorization') != 'Bearer secret-token' and not self.path.startswith('/storage/'):
            return self.send_error(404)
        if self.path == '/repos/owner/repo/releases/tags/sample-rooms':
            return self.answer(json.dumps({'assets': [{'name': 'room3-Room.glb', 'id': 6}, {'name': 'office-Room.glb', 'id': 7}]}).encode())
        if self.path == '/repos/owner/repo/releases/assets/7':
            self.send_response(302)
            self.send_header('Location', f'http://localhost:{self.server.server_port}/storage/office?sig=signed')
            self.send_header('Content-Length', '0')
            return self.end_headers()
        if self.path == '/storage/office?sig=signed':
            return self.answer(MODELS['office'])
        self.send_error(404)

    def answer(self, body):
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class TokenDownload(unittest.TestCase):
    def setUp(self):
        GitHub.seen = []
        server = ThreadingHTTPServer(('127.0.0.1', 0), GitHub)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        api = patch.object(fetch_samples, 'API', f'http://127.0.0.1:{server.server_port}')
        api.start()
        self.addCleanup(api.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.target = Path(directory.name) / 'Room.glb.part'
        self.entry = {'path': 'samples/office/Room.glb', 'tag': 'sample-rooms', 'asset': 'office-Room.glb'}

    def test_the_asset_is_found_by_name_and_the_token_stays_off_the_redirect(self):
        fetch_samples.api_download('owner/repo', self.entry, self.target, 'secret-token')
        self.assertEqual(self.target.read_bytes(), MODELS['office'])
        self.assertEqual(GitHub.seen, [
            ('127.0.0.1', '/repos/owner/repo/releases/tags/sample-rooms', 'Bearer secret-token', 'application/vnd.github+json'),
            ('127.0.0.1', '/repos/owner/repo/releases/assets/7', 'Bearer secret-token', 'application/octet-stream'),
            ('localhost', '/storage/office?sig=signed', None, 'application/octet-stream')])

    def test_errors_name_neither_the_token_nor_a_signed_url(self):
        for token, entry, message in [('wrong-token', self.entry, 'GitHub answered 404 for /repos/owner/repo/releases/tags/sample-rooms'),
                                      ('secret-token', {**self.entry, 'asset': 'attic-Room.glb'}, 'release sample-rooms has no asset attic-Room.glb')]:
            with self.assertRaises(fetch_samples.FetchError) as failure:
                fetch_samples.api_download('owner/repo', entry, self.target, token)
            self.assertEqual(str(failure.exception), message)
        self.assertFalse(self.target.exists())


class Manifest(unittest.TestCase):
    def test_every_listed_model_has_a_place_an_asset_and_a_checksum(self):
        repo, models = fetch_samples.load()
        self.assertRegex(repo, r'^[\w.-]+/[\w.-]+$')
        for entry in models:
            self.assertRegex(entry['path'], r'^samples/[\w.-]+/Room\.glb$')  # the path .gitignore keeps out of git
            self.assertTrue(entry['tag'] and entry['asset'])
            self.assertGreater(entry['bytes'], 0)
            self.assertRegex(entry['sha256'], r'^[0-9a-f]{64}$')
        for key in ('path', 'asset'):
            self.assertEqual(len({entry[key] for entry in models}), len(models))
        listed = {f'../{Path(entry["path"]).parent}' for entry in models}
        rooms = {room['dir'] for room in json.loads((ROOT / 'web/rooms.json').read_text())['rooms']}
        samples = {directory for directory in rooms if directory.startswith('../samples/') and directory.count('/') == 2}
        self.assertEqual(samples - listed, set(), 'a sample room of web/rooms.json has no model in samples/models.json')


if __name__ == '__main__':
    unittest.main()
