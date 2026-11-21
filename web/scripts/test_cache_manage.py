"""Local cache management never removes source data, server jobs, or files reached by symlinks."""
from contextlib import contextmanager
from functools import partial
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cache_manage import CacheBusy, CacheManager
import room_cache
import serve
from test_room_cache import FakeService

JOB = 'a' * 32


class LocalCache(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.cache = self.root / 'runs/room-cache'
        self.manager = CacheManager(self.root, self.cache)
        self.write('web/rooms.json', json.dumps({'rooms': [
            {'id': 'office', 'name': '办公室', 'dir': '../samples/office'},
            {'id': 'classroom', 'name': '教室', 'dir': '../samples/classroom', 'scan': JOB}]}))
        self.write('samples/models.json', json.dumps({'repo': 'unused', 'models': [
            {'path': 'samples/office/Room.glb'}, {'path': 'samples/classroom/Room.glb'}]}))
        self.write('samples/office/Room.glb', 'office')
        self.write('samples/classroom/Room.glb', 'classroom')
        self.write(f'runs/room-cache/assets/{JOB}/Room.glb', 'published')
        self.write(f'runs/room-cache/jobs/{JOB}/replay/files/round/Room.glb', 'replay')
        self.write('runs/room-cache/catalog/answer.json', '{"rooms": []}')
        self.protected = [
            'samples/office/room_objects.json', 'samples/office/thumbnail.jpg',
            'runs/web-room-jobs/' + JOB + '/input.zip', 'runs/other/results.glb',
            'runs/room-cache/do-not-delete.txt', 'samples/custom/Room.glb',
            '.roomcanvas/deleted-rooms.json', 'web/rooms.json', 'samples/models.json',
        ]
        for path in self.protected:
            if not (self.root / path).exists():
                self.write(path, 'keep')

    def write(self, relative, body):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        return path

    def test_inventory_groups_sample_and_replay_by_room_and_counts_bytes(self):
        data = self.manager.inventory()
        entries = {r['id']: r for r in data['entries']}
        self.assertEqual(set(entries), {'sample:office', 'scan:' + JOB, 'catalog'})
        self.assertEqual(entries['scan:' + JOB]['files'], 3)
        self.assertEqual(entries['scan:' + JOB]['bytes'], len('classroompublishedreplay'))
        self.assertEqual(data['total_files'], 5)

    def test_selected_clear_preserves_other_rooms_and_all_clear_preserves_sources(self):
        result = self.manager.clear(['scan:' + JOB])
        self.assertEqual((result['removed_files'], result['freed_bytes']), (3, len('classroompublishedreplay')))
        self.assertEqual({r['id'] for r in result['cache']['entries']}, {'sample:office', 'catalog'})
        self.assertTrue((self.root / 'samples/office/Room.glb').exists())
        self.assertTrue(CacheManager(self.root, self.cache).inventory()['background_paused'])
        self.assertEqual(self.manager.clear(all=True)['cache']['total_files'], 0)
        self.assertTrue(all((self.root / p).exists() for p in self.protected))
        self.assertEqual(self.manager.clear(all=True)['removed_files'], 0)

    def test_unknown_ids_and_invalid_requests_are_rejected_before_deleting_anything(self):
        before = self.manager.inventory()
        for ids, all in [([], False), ('sample:office', False), (['sample:office', '../web'], False),
                         (['sample:office'], True), (None, 'yes'), ([{}], False)]:
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.manager.clear(ids, all=all)
            self.assertEqual(self.manager.inventory(), before)

    def test_symlinks_and_parent_symlinks_are_not_followed(self):
        outside = self.write('original/source.glb', 'never delete')
        sample = self.root / 'samples/office/Room.glb'
        sample.unlink(); sample.symlink_to(outside)
        replay = self.cache / f'jobs/{JOB}/replay/files/linked'
        replay.symlink_to(outside.parent, target_is_directory=True)
        self.manager.clear(all=True)
        self.assertEqual(outside.read_text(), 'never delete')
        self.assertTrue(sample.is_symlink())
        self.assertTrue(replay.is_symlink())

    def test_corrupted_cached_list_does_not_prevent_cleanup(self):
        for body in ('broken', '[]', '{"jobs": null}', '{"jobs": [null]}'):
            self.write('runs/room-cache/jobs/answer.json', body)
            self.assertEqual(self.manager.inventory()['total_files'], 6)
        self.assertEqual(self.manager.clear(all=True)['cache']['total_files'], 0)

    def test_active_download_blocks_cleanup_across_processes_then_can_clear(self):
        script = '''
import sys
from cache_manage import CacheManager
with CacheManager(sys.argv[1]).download():
 print('locked', flush=True)
 sys.stdin.readline()
'''
        worker = subprocess.Popen([sys.executable, '-c', script, str(self.root)],
                                  cwd=Path(__file__).parent, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(worker.stdout.readline().strip(), 'locked')
            with self.assertRaises(CacheBusy):
                self.manager.clear(all=True)
            self.assertEqual(self.manager.inventory()['total_files'], 5)
        finally:
            worker.communicate('\n', timeout=5)
        self.assertEqual(self.manager.clear(all=True)['cache']['total_files'], 0)

    def test_clearing_pauses_both_background_downloaders_but_allows_demand(self):
        self.manager.clear(['sample:office'])
        with patch.object(serve.fetch_samples, 'fetch', side_effect=AssertionError('must not prefetch')):
            self.assertEqual(serve.fetch_sample_models(control=self.manager, log=lambda _: None), [])
        sync = room_cache.Sync('http://unused', self.cache, control=self.manager)
        with patch.object(sync, 'get', side_effect=AssertionError('must not prefetch')):
            sync.once()
        with self.manager.download() as allowed:
            self.assertTrue(allowed)
        self.manager.resume()
        with self.manager.download(background=True) as allowed:
            self.assertTrue(allowed)

    def test_cli_lists_and_clears_the_same_inventory(self):
        import cache_manage
        from io import StringIO
        with patch.object(cache_manage, 'CacheManager', return_value=self.manager), patch('sys.stdout', new_callable=StringIO) as out:
            self.assertEqual(cache_manage.main(['list', '--json']), 0)
            self.assertEqual(json.loads(out.getvalue())['total_files'], 5)
            self.assertEqual(cache_manage.main(['clear', 'sample:office']), 0)
            self.assertEqual(cache_manage.main(['clear', '--all']), 0)
        self.assertEqual(self.manager.inventory()['total_files'], 0)

    @contextmanager
    def server(self):
        test = self
        class Handler(serve.Handler):
            cache = test.cache
            def log_message(self, *args):
                pass
        with patch.object(serve, 'ROOT', self.root):
            server = serve.Server(('127.0.0.1', 0), partial(Handler, directory=str(self.root)))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                yield f'http://127.0.0.1:{server.server_port}', Handler
            finally:
                server.shutdown(); server.server_close(); thread.join()

    def request(self, base, data=None, headers=None):
        request = urllib.request.Request(base + ('/web/cache/clear' if data is not None else '/web/cache'),
                                         data=json.dumps(data).encode() if data is not None else None,
                                         headers={'Content-Type': 'application/json', **(headers or {})})
        try:
            with urllib.request.urlopen(request) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_http_list_clear_and_cross_origin_protection(self):
        with self.server() as (base, _):
            self.assertEqual(self.request(base)[1]['total_files'], 5)
            for headers, status in [({'Origin': 'https://other.example'}, 403),
                                    ({'Sec-Fetch-Site': 'cross-site'}, 403),
                                    ({'Content-Type': 'text/plain'}, 415)]:
                with self.subTest(headers=headers):
                    self.assertEqual(self.request(base, {'all': True}, headers)[0], status)
            self.assertEqual(self.request(base, {'ids': ['../samples']})[0], 400)
            self.assertEqual(self.request(base)[1]['total_files'], 5)
            with self.manager.download():
                self.assertEqual(self.request(base, {'all': True})[0], 409)
            status, result = self.request(base, {'ids': ['sample:office']}, {'Origin': base})
            self.assertEqual((status, result['removed_files']), (200, 1))
            self.assertEqual(self.request(base, {'all': True})[1]['cache']['total_files'], 0)

    def test_untrusted_host_cannot_clear_cache(self):
        from email.message import Message
        handler = object.__new__(serve.Handler)
        handler.headers = Message()
        handler.headers['Host'] = 'other.example'
        handler.room_json = lambda status, data: status
        self.assertEqual(handler.cache_clear(), 403)

    def test_background_sync_does_not_refill_after_cleanup_between_files(self):
        service = FakeService()
        self.addCleanup(service.close)
        def log(line):
            if line.startswith('房间缓存：1/'):
                self.manager.clear(all=True)
        sync = room_cache.Sync(service.url, self.cache, control=self.manager, log=log)
        sync.once()
        self.assertEqual(self.manager.inventory()['total_files'], 0)
        downloads = [p for p in service.asked if room_cache.is_file(p)]
        self.assertEqual(len(downloads), 1)

    def test_cleared_model_can_be_downloaded_on_demand_again(self):
        service = FakeService()
        self.addCleanup(service.close)
        self.write('samples/models.json', json.dumps({'repo': 'unused', 'models': [
            {'path': 'samples/classroom/Room.glb', 'bytes': 4, 'sha256': hashlib.sha256(b'room').hexdigest()}]}))
        self.manager.clear(['scan:' + JOB])
        with self.server() as (base, handler):
            handler.room_backend = service.url
            with urllib.request.urlopen(base + '/samples/classroom/Room.glb') as response:
                self.assertEqual(response.read(), b'room')
        self.assertEqual(service.asked, [f'/room-reconstruction/assets/{JOB}/Room.glb'])
        self.assertTrue(self.manager.inventory()['background_paused'])


if __name__ == '__main__':
    unittest.main()
