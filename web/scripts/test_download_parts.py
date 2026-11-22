"""Interrupted writers leave recoverable files; live writers keep their files."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import download_parts
from cache_manage import CacheManager


class Parts(unittest.TestCase):
    def test_crashed_process_parts_are_reclaimed_but_live_parts_are_not(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            code = """
import sys, time
from pathlib import Path
import download_parts
with download_parts.temporary(Path(sys.argv[1]) / 'Room.glb') as part:
    part.write_bytes(b'partial model')
    print(part, flush=True)
    time.sleep(60)
"""
            env = {**os.environ, 'PYTHONPATH': str(Path(download_parts.__file__).parent)}
            process = subprocess.Popen([sys.executable, '-B', '-c', code, temp], stdout=subprocess.PIPE, text=True, env=env)
            try:
                part = Path(process.stdout.readline().strip())
                self.assertTrue(part.is_file())
                self.assertEqual(download_parts.cleanup(root), (0, 0))
                self.assertTrue(part.is_file())
                process.kill(); process.wait(timeout=5)
                self.assertEqual(download_parts.cleanup(root), (len(b'partial model'), 1))
                self.assertFalse(part.exists())
            finally:
                if process.poll() is None:
                    process.kill(); process.wait(timeout=5)
                process.stdout.close()

    def test_cleanup_all_covers_legacy_parts_but_keeps_other_files_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sample = root / 'samples/room'
            cache = root / 'runs/room-cache'
            sample.mkdir(parents=True); cache.mkdir(parents=True)
            for name in ('.Room-abcd.part', '.Room.glb-abcd.part'):
                (sample / name).write_bytes(b'old')
            (cache / 'tmpabcdefgh').write_bytes(b'old cache')
            kept = [sample / 'Room.glb', sample / 'notes.part', cache / 'notes.txt']
            for path in kept:
                path.write_bytes(b'keep')
            outside = root / 'outside'; outside.mkdir()
            protected = outside / '.Room-secret.part'; protected.write_bytes(b'keep')
            (sample / 'link').symlink_to(outside, target_is_directory=True)
            (cache / '.Room-link.part').symlink_to(protected)
            result = CacheManager(root, cache).clear(all=True)
            self.assertEqual(result['removed_files'], 3)
            self.assertEqual(result['freed_bytes'], 15)
            self.assertTrue(all(path.read_bytes() == b'keep' for path in [*kept, protected]))
            self.assertTrue((cache / '.Room-link.part').is_symlink())

    def test_successful_publication_and_failed_writer_leave_no_parts(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'Room.glb'
            with download_parts.temporary(target) as part:
                part.write_bytes(b'complete'); part.replace(target)
            with self.assertRaises(OSError):
                with download_parts.temporary(target) as part:
                    part.write_bytes(b'partial')
                    raise OSError('connection lost')
            self.assertEqual(list(Path(temp).iterdir()), [target])
            self.assertEqual(target.read_bytes(), b'complete')
