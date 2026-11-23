"""python3 -m unittest discover -s web/scripts"""
import hashlib
import http.client
import json
import socket
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import room_cache  # noqa: E402
from serve import ROOT, Handler, RoomDeletions, Server, room_forwarded, tunnel_command  # noqa: E402

DONE, RUNNING = 'a' * 32, 'b' * 32
P = '/room-reconstruction/'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class FakeService:
    """A room service with one finished job (also a room) and one running job. A HEAD for a file gives its
    sha256, as room_service.py does; `digests=False` is an older service, which answers a HEAD with 501."""

    def __init__(self, digests=True):
        self.updated = 1.0
        self.errors = {}
        self.asked = []  # the GETs
        self.digests, self.wrong = digests, set()  # `wrong`: files whose HEAD gives another sha256
        self.lengths = {}
        self.files = {
            f'{P}jobs/{DONE}/replay/scaffold/points.bin': b'pts', f'{P}jobs/{DONE}/replay/scaffold/layout.json': b'{}',
            f'{P}jobs/{DONE}/replay/files/room_preview/Room.glb': b'final', f'{P}jobs/{DONE}/replay/files/seed/Room.glb': b'seed',
            f'{P}jobs/{DONE}/replay/files/img/a.jpg': b'jpg', f'{P}assets/{DONE}/Room.glb': b'room',
            f'{P}assets/{DONE}/room_objects.json': b'{"groups": []}',
        }
        service = self

        class Answer(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_HEAD(self):
                if not service.digests:
                    return self.send_error(501)
                if self.path not in service.files:
                    return self.send_error(404)
                data = service.files[self.path]
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.send_header(room_cache.DIGEST, hashlib.sha256(b'other' if self.path in service.wrong else data).hexdigest())
                self.end_headers()

            def do_GET(self):
                service.asked.append(self.path)
                if self.path in service.errors:
                    return self.send_error(service.errors[self.path])
                answers = {
                    f'{P}jobs': {'jobs': [{'id': DONE, 'status': 'completed', 'updated': service.updated},
                                          {'id': RUNNING, 'status': 'running', 'updated': 2.0}]},
                    f'{P}catalog': {'rooms': [{'id': f'scan-{DONE}', 'dir': f'{P}assets/{DONE}'}]},
                    f'{P}jobs/{DONE}/replay': {'models': {'final': 'room_preview/Room.glb', 'seed': 'seed/Room.glb'},
                                               'events': [{'img': 'img/a.jpg'}, {'img': None}, {'img': 'img/a.jpg'}]},
                }
                if self.path in answers:
                    body, kind = json.dumps(answers[self.path]).encode(), 'application/json'
                elif self.path in service.files:
                    body, kind = service.files[self.path], 'application/octet-stream'
                else:
                    return self.send_error(404)
                self.send_response(200)
                self.send_header('Content-Type', kind)
                self.send_header('Content-Length', str(service.lengths.get(self.path, len(body))))
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Answer)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Paths(unittest.TestCase):
    def request(self, handler, path, method='GET'):
        handler.path, handler.command, handler.wfile = path, method, BytesIO()
        handler.send_response, handler.send_header, handler.end_headers = Mock(), Mock(), Mock()
        getattr(handler, 'do_' + method)()
        return handler.send_response.call_args.args[0], handler.wfile.getvalue()

    def test_refreshing_only_the_timeline_reuses_matching_legacy_pictures_offline(self):
        base = f'{P}jobs/{DONE}/replay'
        version = hashlib.sha256(b'current').hexdigest()
        timeline = {'events': [{'img': src, 'img_version': version} for src in ('preview.jpg', 'second.png')]}
        with tempfile.TemporaryDirectory() as folder:
            handler = object.__new__(Handler)
            handler.cache = Path(folder)
            for src, data in [('preview.jpg', b'current'), ('second.png', b'expired')]:
                room_cache.save(room_cache.local(handler.cache, f'{base}/files/{src}'), data)
            response = BytesIO(json.dumps(timeline).encode())
            response.status, response.headers = 200, {'Content-Type': 'application/json'}
            handler.open_backend = Mock(return_value=response)
            self.assertEqual(self.request(handler, base)[0], 200)

            handler.open_backend = Mock(side_effect=ConnectionRefusedError)
            status, body = self.request(handler, base)
            self.assertEqual((status, json.loads(body)), (200, timeline))
            match, mismatch = room_cache.job_files(DONE, json.loads(body))[2]
            handler.open_backend.reset_mock()
            self.assertEqual(self.request(handler, f'{base}/files/preview.jpg'), (200, b'current'))
            self.assertEqual(self.request(handler, match), (200, b'current'))
            self.assertEqual(self.request(handler, match, 'HEAD'), (200, b''))
            handler.send_header.assert_any_call('Content-Length', '7')
            handler.open_backend.assert_not_called()
            self.assertEqual(self.request(handler, mismatch)[0], 503)
            self.assertEqual(handler.open_backend.call_args.args[0].full_url, handler.room_backend + mismatch)

    def test_a_new_picture_version_bypasses_older_files_and_synced_versions_open_offline(self):
        rel = 'small-objects/reference/TissueBox0.png'
        base = f'{P}jobs/{DONE}/replay'
        path = f'{base}/files/{rel}'
        files = {path + '?v=A': b'first', path + '?v=B': b'redrawn'}
        answers = {P + 'jobs': {'jobs': [{'id': DONE, 'status': 'failed', 'updated': 1}]},
                   P + 'catalog': {'rooms': []}}
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder)
            sync = room_cache.Sync('http://unused', cache, log=lambda _: None)
            sync.identity = lambda p: None
            sync.get = lambda p, timeout=60: json.dumps(answers[p]).encode() if p in answers else files.get(p, b'scaffold')
            handler = object.__new__(Handler)
            handler.cache = cache
            handler.send_kept = Path.read_bytes
            requests = []

            def relay(request, timeout, room):
                requests.append(request.full_url)
                return files[request.full_url.removeprefix(handler.room_backend)]

            handler.relay = relay
            room_cache.save(room_cache.local(cache, path), b'legacy')
            for version in ('A', 'B'):
                url = path + '?v=' + version
                self.assertEqual(handler.room_get(room_forwarded(url)), files[url])
                self.assertEqual(requests.pop(), handler.room_backend + url)
                answers[base] = {'events': [{'img': rel, 'media': [{'src': rel, 'version': version}]}]}
                sync.once()
                self.assertEqual(handler.room_get(room_forwarded(url)), files[url])
                self.assertFalse(requests)
            self.assertEqual(handler.room_get(room_forwarded(path + '?v=A')), b'first')
            self.assertEqual(handler.room_get(room_forwarded(path)), b'legacy')
            self.assertFalse(requests)

    def test_files_keep_their_path_and_answers_sit_beside_them(self):
        cache = Path('/c')
        self.assertEqual(room_cache.local(cache, f'{P}assets/{DONE}/Room.glb'), cache / f'assets/{DONE}/Room.glb')
        self.assertEqual(room_cache.local(cache, f'{P}jobs/{DONE}/replay/files/x/Room.glb'), cache / f'jobs/{DONE}/replay/files/x/Room.glb')
        self.assertEqual(room_cache.local(cache, f'{P}jobs/{DONE}/replay'), cache / f'jobs/{DONE}/replay/answer.json')
        self.assertEqual(room_cache.local(cache, f'{P}jobs'), cache / 'jobs/answer.json')
        self.assertIsNone(room_cache.local(cache, f'{P}health'))
        self.assertIsNone(room_cache.local(cache, f'{P}jobs/{DONE}/replay/files/../../x'))

    def test_versioned_model_uses_the_local_file_only_for_matching_bytes(self):
        path = f'{P}jobs/{DONE}/replay/files/articulate/room_preview/Room.glb'
        with tempfile.TemporaryDirectory() as folder:
            handler = object.__new__(Handler)
            handler.cache, handler.room_backend = Path(folder), 'http://localhost'
            handler.relay, handler.send_kept = Mock(), Mock()
            kept = room_cache.local(handler.cache, path)
            room_cache.save(kept, b'old')
            for content in (b'old', b'new'):
                handler.path = path + '?sha256=' + hashlib.sha256(content).hexdigest()
                handler.do_GET()
            handler.send_kept.assert_called_once_with(kept)
            handler.relay.assert_called_once()
            self.assertEqual(handler.relay.call_args.args[0].full_url, handler.room_backend + path)

    def test_resaved_articulated_model_opens_offline_without_a_job_timestamp_change(self):
        base = f'{P}jobs/{DONE}/replay'
        rel = 'articulate/room_preview/Room.glb'
        path = f'{base}/files/{rel}'
        old, new = b'first model', b'later model'
        digest = hashlib.sha256(new).hexdigest()
        event = {'model': 'articulated', 'artifact_digest': hashlib.sha256(old).hexdigest()}
        answers = {P + 'jobs': {'jobs': [{'id': DONE, 'status': 'completed', 'updated': 1}]},
                   P + 'catalog': {'rooms': []},
                   base: {'models': {'articulated': rel}, 'events': [event]}}
        with tempfile.TemporaryDirectory() as folder:
            handler = object.__new__(Handler)
            handler.cache = Path(folder)
            sync = room_cache.Sync('http://unused', handler.cache, log=lambda _: None)
            files = {path: old}
            sync.identity = lambda p: None
            sync.get = lambda p, timeout=60: json.dumps(answers[p]).encode() if p in answers else files.get(p, b'scaffold')
            sync.once()
            kept = room_cache.local(handler.cache, path)
            self.assertEqual(kept.read_bytes(), old)

            answers[base]['events'].append({'model': 'articulated', 'artifact_digest': digest})
            self.assertIn(path, sync.missing())
            sync.once()  # GET still returns old bytes, and the older service gives no HEAD digest.
            self.assertEqual(kept.read_bytes(), old)
            files[path] = b'third model'
            sync.identity = lambda p: (len(files[p]), hashlib.sha256(files[p]).hexdigest())
            sync.once()  # Even matching HEAD and GET bytes must agree with the timeline.
            self.assertEqual(kept.read_bytes(), old)
            files[path] = new
            with kept.open('rb') as earlier:
                sync.once()
                self.assertEqual(earlier.read(), old)
            self.assertNotIn(path, sync.missing())

            handler.open_backend = Mock(side_effect=ConnectionRefusedError)
            status, body = self.request(handler, base)
            self.assertEqual(status, 200)
            saved = json.loads(body)['events'][-1]['artifact_digest']
            self.assertEqual(saved, digest)
            handler.open_backend.reset_mock()
            self.assertEqual(self.request(handler, path + '?sha256=' + saved), (200, new))
            handler.open_backend.assert_not_called()

    def test_slow_earlier_request_cannot_replace_a_newer_successful_answer(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'answer.json'
            with room_cache.answer_writer(target) as first:
                with room_cache.answer_writer(target) as second:
                    second(b'{"version":2}')
                first(b'{"version":1}')
            self.assertEqual(json.loads(target.read_bytes()), {'version': 2})
            self.assertEqual(list(target.parent.iterdir()), [target])

    def test_newer_failed_request_does_not_block_an_older_success(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'answer.json'
            with room_cache.answer_writer(target) as first:
                with room_cache.answer_writer(target):
                    pass  # the second fetch failed and published nothing
                first(b'{}')
            self.assertEqual(target.read_bytes(), b'{}')

    def test_a_replay_needs_its_scaffold_models_seed_first_and_each_picture_once(self):
        first, models, pictures = room_cache.job_files(DONE, {'models': {'round0': 'r0.glb', 'final': 'f.glb', 'seed': 's.glb'},
                                                               'events': [{'img': 'a.jpg'}, {}, {'img': 'a.jpg'}, {'img': 'b.jpg', 'media': [{'src': 'b.jpg'}, {'src': 'c.jpg'}]}]})
        base = f'{P}jobs/{DONE}/replay'
        self.assertEqual(first, [f'{base}/scaffold/points.bin', f'{base}/scaffold/layout.json', f'{base}/scaffold/colors.bin'])
        self.assertEqual(models, [f'{base}/files/s.glb', f'{base}/files/f.glb', f'{base}/files/r0.glb'])
        self.assertEqual(pictures, [f'{base}/files/a.jpg', f'{base}/files/b.jpg', f'{base}/files/c.jpg'])
        chosen = {'img': 'chosen.jpg', 'img_version': 'a', 'media': [{'src': 'other.jpg', 'version': 'b'}]}
        self.assertEqual(room_cache.job_files(DONE, {'events': [chosen]})[2],
                         [f'{base}/files/chosen.jpg?v=a', f'{base}/files/other.jpg?v=b'])


class Download(unittest.TestCase):
    def setUp(self):
        self.service = FakeService()
        self.folder = tempfile.TemporaryDirectory()
        self.cache = Path(self.folder.name)
        self.sync = room_cache.Sync(self.service.url, self.cache, log=lambda line: None)

    def tearDown(self):
        self.service.close()
        self.folder.cleanup()

    def test_finished_jobs_and_rooms_are_copied_running_ones_are_not(self):
        self.sync.once()
        for path, data in self.service.files.items():
            self.assertEqual(room_cache.local(self.cache, path).read_bytes(), data, path)
        self.assertFalse((self.cache / f'jobs/{RUNNING}/replay').exists())
        self.service.asked.clear()
        self.sync.once()  # nothing missing: only the answers are asked again
        self.assertFalse([p for p in self.service.asked if room_cache.is_file(p)])

    def test_a_dropped_connection_is_tried_again(self):
        calls = []
        def once():
            calls.append(1)
            if len(calls) == 1:
                raise http.client.IncompleteRead(b'', 10)
            self.sync.stop()
        self.sync.once = once
        self.sync.stopped.wait = lambda seconds: self.sync.stopped.is_set()
        self.sync.run()
        self.assertEqual(len(calls), 2)

    def test_a_retried_job_is_downloaded_again(self):
        self.sync.once()
        thumbnail = f'{P}assets/{DONE}/thumbnail.jpg'
        self.assertIn(thumbnail, self.sync.absent)
        self.service.files[thumbnail] = b'new thumbnail'
        kept = room_cache.local(self.cache, f'{P}assets/{DONE}/Room.glb')
        self.service.files[f'{P}assets/{DONE}/Room.glb'] = b'new room'
        self.service.updated = 5.0
        self.sync.once()
        self.assertEqual(kept.read_bytes(), b'new room')
        self.assertEqual(room_cache.local(self.cache, thumbnail).read_bytes(), b'new thumbnail')


class SameContent(unittest.TestCase):
    """A file whose content is already here (another path in the cache, a sample room) is linked, not downloaded."""

    def setUp(self):
        self.service = FakeService()
        self.final = f'{P}jobs/{DONE}/replay/files/room_preview/Room.glb'
        self.seed = f'{P}jobs/{DONE}/replay/files/seed/Room.glb'
        self.room = f'{P}assets/{DONE}/Room.glb'
        self.service.files[self.room] = self.service.files[self.final]  # the published room is the last version
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.addCleanup(self.service.close)
        self.cache, self.samples = Path(folder.name) / 'cache', Path(folder.name) / 'samples'
        self.sample = self.samples / 'demo/Room.glb'
        self.sample.parent.mkdir(parents=True)
        self.sample.write_bytes(b'seed')  # a sample room that is this job's first version
        self.tracked = self.samples / 'demo/room_objects.json'  # in git: never linked, though the same
        self.tracked.write_bytes(self.service.files[f'{P}assets/{DONE}/room_objects.json'])
        self.lines = []
        self.sync = room_cache.Sync(self.service.url, self.cache, log=self.lines.append, also=[self.sample])

    def kept(self, path):
        return room_cache.local(self.cache, path)

    def test_each_content_is_downloaded_once(self):
        self.sync.once()
        for path, data in self.service.files.items():
            self.assertEqual(self.kept(path).read_bytes(), data, path)
        self.assertNotIn(self.seed, self.service.asked)
        self.assertNotIn(self.room, self.service.asked)
        self.assertIn(self.final, self.service.asked)
        self.assertTrue(self.kept(self.seed).samefile(self.sample))  # hard links: no second copy on disk
        self.assertTrue(self.kept(self.room).samefile(self.kept(self.final)))
        self.assertFalse(self.kept(f'{P}assets/{DONE}/room_objects.json').samefile(self.tracked))
        self.assertEqual(sum('MB，本机已有相同文件' in line for line in self.lines), 2)
        self.assertIn('其中 2 个本机已有相同文件，未下载', self.lines[-1])
        self.assertIn(f'{P}assets/{DONE}/thumbnail.jpg', self.sync.absent)  # a HEAD's 404 counts like a GET's
        self.assertFalse(list(self.cache.rglob('*.part')))

    def test_a_download_that_does_not_have_the_given_sha256_is_not_kept(self):
        self.service.wrong.add(self.final)
        self.sync.once()
        self.assertFalse(self.kept(self.final).exists())
        self.assertNotIn(self.final, self.sync.absent)
        self.assertTrue(any('sha256 不符，未保存' in line for line in self.lines))
        self.service.wrong.clear()
        self.sync.once()  # tried again
        self.assertEqual(self.kept(self.final).read_bytes(), b'final')

    def test_an_older_service_without_sha256_is_downloaded_from_as_before(self):
        self.service.digests = False
        self.sync.once()
        for path, data in self.service.files.items():
            self.assertEqual(self.kept(path).read_bytes(), data, path)
            self.assertIn(path, self.service.asked)
        self.assertFalse(self.kept(self.seed).samefile(self.sample))

    def test_a_retried_job_loses_its_copies_but_the_sample_room_stays(self):
        self.sync.once()
        self.assertTrue(self.kept(self.seed).samefile(self.sample))
        self.service.files[self.seed] = b'new seed'
        self.service.updated = 5.0
        self.sync.once()
        self.assertEqual(self.sample.read_bytes(), b'seed')
        self.assertEqual(self.kept(self.seed).read_bytes(), b'new seed')
        self.assertIn(self.seed, self.service.asked)


class Serving(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.cache = Path(self.folder.name)
        self.service = None
        self.backend(f'http://127.0.0.1:{free_port()}')  # nothing listens: the server is off
        self.page = Server(('127.0.0.1', 0), partial(Quiet, directory=str(ROOT)))
        threading.Thread(target=self.page.serve_forever, daemon=True).start()

    def backend(self, url):
        Quiet.room_backend, Quiet.cache = url, self.cache

    def tearDown(self):
        self.page.shutdown()
        self.page.server_close()
        if self.service:
            self.service.close()
        self.folder.cleanup()

    def get(self, path, method='GET'):
        request = urllib.request.Request(f'http://127.0.0.1:{self.page.server_port}{path}', method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def test_with_the_server_off_kept_rooms_and_replays_still_open(self):
        room_cache.save(self.cache / f'assets/{DONE}/Room.glb', b'room')
        room_cache.save(self.cache / f'jobs/{DONE}/replay/answer.json', b'{"events": []}')
        room_cache.save(self.cache / 'catalog/answer.json', json.dumps({'rooms': [{'id': 'scan-x', 'dir': 'd'}]}).encode())
        status, body, headers = self.get(f'{P}assets/{DONE}/Room.glb?v=1')
        self.assertEqual((status, body), (200, b'room'))
        self.assertTrue(headers['Last-Modified'])
        self.assertEqual(self.get(f'{P}assets/{DONE}/Room.glb', 'HEAD')[0], 200)
        self.assertEqual(self.get(f'{P}jobs/{DONE}/replay')[:2], (200, b'{"events": []}'))
        rooms = json.loads(self.get('/web/rooms.json')[1])['rooms']
        self.assertIn('scan-x', [room['id'] for room in rooms])
        self.assertEqual(self.get(f'{P}jobs/{RUNNING}/replay')[0], 503)  # never kept
        self.assertEqual(self.get(f'{P}assets/{RUNNING}/Room.glb')[0], 503)

    def test_answers_are_asked_live_and_kept(self):
        self.service = FakeService()
        self.backend(self.service.url)
        status, body, _ = self.get(f'{P}jobs')
        self.assertEqual(status, 200)
        self.assertEqual(json.loads((self.cache / 'jobs/answer.json').read_bytes()), json.loads(body))
        self.assertEqual(self.get(f'{P}jobs/{DONE}/replay/files/seed/Room.glb')[:2], (200, b'seed'))  # not kept yet: asked
        self.assertEqual(self.get(f'{P}jobs/{DONE}/replay/files/nothing.glb')[0], 404)

    def test_gateway_failure_uses_only_existing_answers_then_recovers(self):
        self.service = FakeService()
        self.backend(self.service.url)
        path = f'{P}jobs'
        status, original, headers = self.get(path)
        self.assertEqual(status, 200)
        self.assertNotIn('X-RoomCanvas-Cache', headers)
        for code in (502, 503, 504):
            with self.subTest(code=code):
                self.service.errors[path] = code
                status, body, headers = self.get(path)
                self.assertEqual((status, body, headers['X-RoomCanvas-Cache']), (200, original, 'stale'))
        for code in (400, 403, 404, 500):
            with self.subTest(code=code):
                self.service.errors[path] = code
                self.assertEqual(self.get(path)[0], code)
        self.service.errors[f'{P}catalog'] = 502
        self.assertEqual(self.get(f'{P}catalog')[0], 502)
        self.service.errors.clear()
        self.service.updated += 1
        status, updated, headers = self.get(path)
        self.assertEqual(status, 200)
        self.assertNotEqual(updated, original)
        self.assertNotIn('X-RoomCanvas-Cache', headers)
        self.assertEqual(room_cache.local(self.cache, path).read_bytes(), updated)


class Quiet(Handler):
    def log_message(self, *args):
        pass


class SampleServing(unittest.TestCase):
    """Opening a missing sample fetches only its pinned model, without background sync or GitHub."""

    def setUp(self):
        import hashlib
        from unittest.mock import patch
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.target = self.root / 'samples/classroom/Room.glb'
        self.path = '/samples/classroom/Room.glb'
        self.source = f'{P}assets/{DONE}/Room.glb'
        self.target.parent.mkdir(parents=True)
        (self.root / 'web').mkdir()
        (self.root / 'web/rooms.json').write_text(json.dumps({'rooms': [
            {'id': 'classroom', 'name': 'Classroom', 'dir': '../samples/classroom', 'scan': DONE}]}))
        (self.root / 'samples/models.json').write_text(json.dumps({'repo': 'unused', 'models': [
            {'path': self.path[1:], 'bytes': 4, 'sha256': hashlib.sha256(b'room').hexdigest()}]}))
        root_patch = patch('serve.ROOT', self.root)
        root_patch.start(); self.addCleanup(root_patch.stop)
        auth_patch = patch('serve.fetch_samples.methods', side_effect=AssertionError('GitHub must not be used'))
        self.methods = auth_patch.start(); self.addCleanup(auth_patch.stop)
        self.service = FakeService()
        self.addCleanup(self.service.close)
        class SampleHandler(Quiet):
            room_backend = self.service.url
            cache = self.root / 'cache'
            deletions = RoomDeletions(self.root / 'deleted.json')
        self.page = Server(('127.0.0.1', 0), partial(SampleHandler, directory=str(self.root)))
        self.addCleanup(self.page.server_close)
        self.addCleanup(self.page.shutdown)
        threading.Thread(target=self.page.serve_forever, daemon=True).start()

    def get(self, path=None, method='GET'):
        request = urllib.request.Request(f'http://127.0.0.1:{self.page.server_port}{path or self.path}', method=method)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read(), response.headers
        except urllib.error.HTTPError as error:
            return error.code, error.read(), error.headers

    def test_listing_and_head_do_not_download_get_is_cached_and_works_offline(self):
        self.assertEqual(self.get('/web/rooms.json')[0], 200)
        self.assertEqual(self.service.asked, [f'{P}catalog'])
        self.service.asked.clear()
        status, body, headers = self.get(method='HEAD')
        self.assertEqual((status, body, headers['Content-Length']), (200, b'', '4'))
        self.assertEqual(self.service.asked, [])
        self.assertFalse(self.target.exists())
        self.assertEqual(self.get(self.path + '?v=1')[:2], (200, b'room'))
        self.assertEqual(self.target.read_bytes(), b'room')
        self.assertEqual(self.service.asked, [self.source])
        self.service.errors[self.source] = 503
        self.assertEqual(self.get()[:2], (200, b'room'))
        self.assertEqual(self.service.asked, [self.source])

    def test_concurrent_opens_download_once(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(lambda _: self.get()[:2], range(3)))
        self.assertEqual(results, [(200, b'room')] * 3)
        self.assertEqual(self.service.asked, [self.source])

    def test_missing_sample_reuses_identical_cached_model_without_network(self):
        cache = self.root / f'cache/assets/{DONE}/Room.glb'
        room_cache.save(cache, b'room')
        self.service.errors[self.source] = 503
        self.assertEqual(self.get()[:2], (200, b'room'))
        self.assertEqual(self.service.asked, [])
        self.assertEqual(self.target.stat().st_ino, cache.stat().st_ino)

    def test_wrong_version_is_not_published_and_refresh_can_retry(self):
        for wrong in (b'older', b'xxxx'):
            self.service.files[self.source] = wrong
            self.assertEqual(self.get()[0], 502)
            self.assertFalse(self.target.exists())
            self.assertEqual(list(self.target.parent.iterdir()), [])
        self.service.files[self.source] = b'room'
        self.assertEqual(self.get()[:2], (200, b'room'))

    def test_unavailable_backend_can_retry_without_leaving_a_partial_model(self):
        self.service.errors[self.source] = 503
        self.assertEqual(self.get()[0], 503)
        self.assertEqual(list(self.target.parent.iterdir()), [])
        self.service.errors.clear()
        self.assertEqual(self.get()[:2], (200, b'room'))

    def test_interrupted_transfer_is_discarded_and_can_be_retried(self):
        from unittest.mock import patch
        observed = []
        original = Handler.room_json
        def reply(handler, *args, **kwargs):
            observed.append(list(self.target.parent.iterdir()))
            return original(handler, *args, **kwargs)
        self.service.files[self.source] = b'ro'
        self.service.lengths[self.source] = 4
        with patch.object(Handler, 'room_json', reply):
            self.assertIn(self.get()[0], (502, 503))
        self.assertEqual(observed, [[]], 'clean up before sending the error response')
        self.assertEqual(list(self.target.parent.iterdir()), [])
        self.service.files[self.source] = b'room'
        self.assertEqual(self.get()[:2], (200, b'room'))

    def test_unlisted_path_cannot_trigger_a_download(self):
        for path in ('/samples/unknown/Room.glb', '/samples/classroom/../Room.glb', '/samples/classroom/Room.glb/extra'):
            self.assertEqual(self.get(path)[0], 404)
        self.assertEqual(self.service.asked, [])


class UnlinkedSampleServing(SampleServing):
    """The same on-demand guarantees apply to samples without a reconstruction job."""

    def setUp(self):
        super().setUp()
        self.path = '/samples/office/Room.glb'
        self.target = self.root / self.path[1:]
        self.target.parent.mkdir()
        self.source = f'{P}samples/office/Room.glb'
        self.service.files[self.source] = b'room'
        self.methods.side_effect = None
        self.methods.return_value = []
        self.entry = {'path': self.path[1:], 'bytes': 4, 'sha256': hashlib.sha256(b'room').hexdigest(),
                      'tag': 'sample-rooms', 'asset': 'office-Room.glb'}
        (self.root / 'samples/models.json').write_text(json.dumps({'repo': 'owner/repo', 'models': [
            self.entry, {**self.entry, 'path': 'samples/room3/Room.glb', 'asset': 'room3-Room.glb'}]}))
        (self.root / 'web/rooms.json').write_text(json.dumps({'rooms': [
            {'id': 'office', 'name': 'Office', 'dir': '../samples/office'},
            {'id': 'room3', 'name': 'Bedroom', 'dir': '../samples/room3'}]}))

    def test_cleanup_stays_paused_and_only_the_reopened_room_is_fetched(self):
        from cache_manage import CacheManager
        from serve import fetch_sample_models
        control = CacheManager(self.root, self.root / 'cache')
        self.target.write_bytes(b'room')
        control.clear(['sample:office'])
        fetch_sample_models(control=control, log=lambda _: None)
        self.methods.assert_not_called()
        self.assertEqual(self.get()[:2], (200, b'room'))
        self.assertEqual(self.service.asked, [self.source])
        self.assertTrue(control.inventory()['background_paused'])
        self.assertFalse((self.root / 'samples/room3/Room.glb').exists())
        self.methods.assert_not_called()

    def test_configured_github_downloads_only_the_requested_sample_once(self):
        from concurrent.futures import ThreadPoolExecutor
        self.service.errors[self.source] = 404  # an older server, or one without samples
        downloaded = []
        def release(repo, entry, target):
            downloaded.append((repo, entry['asset']))
            target.write_bytes(b'room')
        self.methods.return_value = [release]
        with ThreadPoolExecutor(max_workers=3) as pool:
            replies = list(pool.map(lambda _: self.get()[:2], range(3)))
        self.assertEqual(replies, [(200, b'room')] * 3)
        self.assertEqual(downloaded, [('owner/repo', 'office-Room.glb')])
        self.assertFalse((self.root / 'samples/room3/Room.glb').exists())
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    def test_no_source_returns_actionable_error_and_can_retry(self):
        self.service.errors[self.source] = 404
        status, body, _ = self.get()
        self.assertEqual(status, 503)
        self.assertIn('GitHub', json.loads(body)['error'])
        self.assertIn('当前房间', json.loads(body)['error'])
        self.assertEqual(list(self.target.parent.iterdir()), [])
        self.service.errors.clear()
        self.assertEqual(self.get()[:2], (200, b'room'))

    def test_bad_release_is_discarded_before_responding_and_can_retry(self):
        self.service.errors[self.source] = 404
        self.methods.return_value = [lambda repo, entry, target: target.write_bytes(b'xxxx')]
        self.assertEqual(self.get()[0], 503)
        self.assertEqual(list(self.target.parent.iterdir()), [])
        self.methods.return_value = [lambda repo, entry, target: target.write_bytes(b'room')]
        self.assertEqual(self.get()[:2], (200, b'room'))


class StartServer(unittest.TestCase):
    def test_the_same_connection_starts_the_services_and_stays_open(self):
        command = tunnel_command('autodl', [(7865, '127.0.0.1:7870')], [], "/root/my rooms/RoomCanvas")
        self.assertNotIn('-N', command)
        self.assertEqual(command[-2], 'autodl')
        self.assertEqual(command[-1], "cd '/root/my rooms/RoomCanvas' && bash scripts/start_server.sh; exec cat > /dev/null")
        self.assertIn('-N', tunnel_command('autodl', [(7865, '127.0.0.1:7870')]))


if __name__ == '__main__':
    unittest.main()
