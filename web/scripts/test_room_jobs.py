"""Recovery of damaged records without starting a service or GPU task."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import room_jobs
import room_replay


class Recovery(unittest.TestCase):
    def test_bad_records_do_not_hide_valid_jobs_and_can_be_repaired(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def write(index, data):
                identifier = f'{index:032x}'
                path = root / identifier / 'job.json'
                path.parent.mkdir(exist_ok=True)
                path.write_text(data)
                return path
            bad = ['{"id":', '[]', 'null', '{}', json.dumps({'id': '../outside'}),
                   json.dumps({'id': f'{6:032x}', 'status': 'completed', 'name': 'bad', 'created': 'yesterday'})]
            paths = [write(i, data) for i, data in enumerate(bad, 1)]
            valid = {'id': f'{20:032x}', 'name': 'room', 'status': 'queued', 'created': 1}
            write(20, json.dumps(valid))
            with self.assertLogs('room_jobs', level='WARNING') as logs:
                jobs = room_jobs.Jobs(root, root, extract=None)
            self.addCleanup(os.close, jobs.owner)
            self.assertEqual(len(logs.output), len(bad))
            self.assertEqual(jobs.records, {valid['id']: valid})
            self.assertEqual(jobs.pending.get_nowait(), valid['id'])
            self.assertEqual([p.read_text() for p in paths], bad)
            with self.assertNoLogs('room_jobs', level='WARNING'):  # said once, not on every rescan
                jobs.load_new()
            fixed = dict(valid, id=paths[0].parent.name, status='completed', replay_only=True)
            paths[0].write_text(json.dumps(fixed))
            with self.assertNoLogs('room_jobs', level='WARNING'):
                jobs.load_new()
            self.assertEqual(jobs.records[fixed['id']], fixed)
            paths[1].write_text('{"id": "changed again"')  # a new version of a damaged file is said again
            with self.assertLogs('room_jobs', level='WARNING'):
                jobs.load_new()

    def test_unreadable_record_is_skipped(self):
        with patch.object(Path, 'read_text', side_effect=PermissionError('unreadable')):
            with self.assertLogs('room_jobs', level='WARNING'):
                self.assertIsNone(room_jobs.read_record(Path('/jobs/' + 'a' * 32 + '/job.json')))

    def test_failed_registration_never_exposes_partial_job_json(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            run = root / 'run'
            (run / 'pipeline/scene/scene_init/obj_stage').mkdir(parents=True)
            original = Path.write_text
            def interrupted(path, data, *args, **kwargs):
                if path.name in ('job.json', 'job.tmp'):
                    original(path, data[:10])
                    raise OSError('disk full')
                return original(path, data, *args, **kwargs)
            with patch.object(Path, 'write_text', interrupted), self.assertRaises(OSError):
                room_replay.register(root / 'jobs', run, 'room', until=100)
            self.assertEqual(list((root / 'jobs').glob('*/job.json')), [])
            self.assertEqual(list((root / 'jobs').glob('*/job.tmp')), [])
            identifier = room_replay.register(root / 'jobs', run, 'room', until=100)
            self.assertEqual(json.loads((root / 'jobs' / identifier / 'job.json').read_text())['id'], identifier)
