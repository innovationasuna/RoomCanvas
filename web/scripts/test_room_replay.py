"""Reconstruction replay: run directory -> timeline, condensation cache, file allowlist, service routes.
Synthetic runs only; no GPU, model or codex calls."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
import room_replay as replay
import room_service as service

T0 = 1_800_000_000.0


def write(path, data=b'x', t=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data if isinstance(data, bytes) else data.encode())
    if t:
        os.utime(path, (t, t))
    return path


def make_run(root):
    """A small run in the server layout: <root>/pipeline/demo/..."""
    scene = root / 'pipeline' / 'demo'
    trace = [
        {'t': T0, 'kind': 'scan_start'},
        {'t': T0 + 1, 'kind': 'stage', 'stage': 'extract_scene', 'status': 'done'},
        {'t': T0 + 2, 'kind': 'stage', 'stage': 'layout', 'status': 'done', 'moved': 2},
        {'t': T0 + 3, 'kind': 'stage', 'stage': 'crop_objects', 'status': 'done', 'n_objects': 2},
        {'t': T0 + 10, 'kind': 'image_generation', 'name': 'Storage0', 'status': 'ok'},
        {'t': T0 + 20, 'kind': 'scan_start'},  # a resumed run repeats this
        {'t': T0 + 30, 'kind': 'classify', 'procedural': 1, 'trellis': 1},
        {'t': T0 + 60, 'kind': 'agent_step', 'name': 'Storage0', 'step': 'Storage0:attempt1'},
        {'t': T0 + 70, 'kind': 'agent_step', 'name': 'Storage0', 'step': 'Storage0:attempt2'},
        {'t': T0 + 80, 'kind': 'procedural_physics', 'objects': 2, 'passed': 2},
        {'t': T0 + 85, 'kind': 'chair_qc', 'cluster': 'ChairCluster0', 'status': 'ok'},
        {'t': T0 + 99999, 'kind': 'materials_pass', 'status': 'start'},  # written later by other work
    ]
    write(scene / replay.TRACES / 'trace.jsonl', '\n'.join(json.dumps(r) for r in trace) + '\n')
    author = [
        {'seq': 1, 't': T0 + 200, 'kind': 'session_start'},
        {'seq': 2, 't': T0 + 210, 'kind': 'think', 'text': 'Read the room and photos.'},
        {'seq': 3, 't': T0 + 220, 'kind': 'tool', 'tool': 'Bash', 'hint': "/bin/bash -lc '# description: build the first pass\n python x'"},
        {'seq': 4, 't': T0 + 230, 'kind': 'images', 'saved': ['img/author_0004_a.jpg'], 'n_images': 1},
        {'seq': 5, 't': T0 + 600, 'kind': 'result', 'tool': 'critic', 'output': '{"score": 6.5}'},
        {'seq': 6, 't': T0 + 610, 'kind': 'result', 'tool': 'Bash', 'output': 'ok'},  # plain output: skipped
    ]
    write(scene / replay.TRACES / 'authoring_trace.author.jsonl', '\n'.join(json.dumps(r) for r in author) + '\n')
    write(scene / replay.TRACES / 'img/author_0004_a.jpg')
    write(scene / 'scene_init/obj_stage/object_init/input/scene_data/demo/layout_shell.json', json.dumps({'objects': {
        'Storage0': {'category': 'storage', 'center': [0, 1, 0.5], 'size': [1, 0.5, 2], 'yaw': 90},
        'Storage1': {'category': 'storage', 'center': [1, 1, 0.5], 'size': [1, 0.5, 2]}}}))
    write(scene / 'scene_init/obj_stage/object_init/input/scene_data/demo/layout_baseline.json', json.dumps({'shell': {
        'floor_z': -1.5, 'walls': {'Wall0': {'start': [0, 0], 'end': [3, 0], 'height': 2.4, 'thickness': 0.1}}}}))
    write(scene / 'scene_init/obj_stage/object_init/input/scan_geometry/demo/scene_points.obj', 'v 0 1 2\nv 3 4 5\n')
    write(scene / 'scene_init/obj_stage/reconstructed_objs/Storage0/previews/preview_front.png')
    write(scene / replay.SEED, t=T0 + 100)
    for k, score in enumerate([4.0, 7.5]):
        folder = scene / f'realism_authoring/acceptance/attempt-x/round_0{k}'
        issue = {'description': 'The bed is too bright.'} if k == 0 else {'defect': 'The curtains are too stiff.'}
        write(folder / 'visual_review.json', json.dumps({'pass': k == 1, 'score': score, 'issues': [issue, {'description': ' '}]}),
              t=T0 + 1000 + k * 100)
        write(folder / 'compare/pairs/pair_00000.png')
        write(folder / 'Room.glb', t=T0 + 990 + k * 100)
    write(scene / replay.FINAL, t=T0 + 1150)
    return scene


def next_session(scene, t, role='author', rows=None):
    """Start another session of the agent at time t: the trace writer first moves the current one to
    traces/history/authoring_trace.<role>.run_NNN.jsonl (its step numbers restart)."""
    traces = scene / replay.TRACES
    current = traces / f'authoring_trace.{role}.jsonl'
    if current.is_file():
        (traces / 'history').mkdir(exist_ok=True)
        n = len(list((traces / 'history').glob(f'authoring_trace.{role}.run_*.jsonl'))) + 1
        current.replace(traces / 'history' / f'authoring_trace.{role}.run_{n:03d}.jsonl')
    rows = rows or [{'seq': 1, 't': t, 'kind': 'session_start'}, {'seq': 2, 't': t + 10, 'kind': 'think', 'text': 'Go on.'},
                    {'seq': 3, 't': t + 20, 'kind': 'tool', 'tool': 'Bash', 'hint': 'python Room.py'}]
    write(current, ''.join(json.dumps(r) + '\n' for r in rows))


class Events(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scene = make_run(self.root / 'run')
        self.until = T0 + 1300

    def tearDown(self):
        self.tmp.cleanup()

    def test_pipeline_records_become_plain_events(self):
        events = replay.pipeline_events(self.scene, self.until)
        says = [e['say'] for e in events]
        self.assertEqual(says.count('收到房间扫描，开始重建'), 1)  # the resumed run is not repeated
        self.assertIn('整理好房间布局，校正了 2 个物品框的位置', says)
        self.assertIn('生成柜子1的清晰图', says)
        self.assertIn('做好柜子1的模型', says)
        self.assertIn('重做柜子1的模型', says)
        self.assertFalse(any('materials' in s for s in says))
        built = next(e for e in events if e['say'] == '做好柜子1的模型')
        self.assertEqual(built['show'], ['Storage0'])
        self.assertTrue(built['img'].endswith('preview_front.png'))
        chair = next(e for e in events if e['say'].startswith('做好椅子'))
        self.assertEqual(chair['show'], ['ChairCluster0'])

    def test_records_after_the_cutoff_are_ignored(self):
        events = replay.pipeline_events(self.scene, T0 + 65)
        self.assertNotIn('重做柜子1的模型', [e['say'] for e in events])
        self.assertEqual(replay.models(self.scene, T0 + 65), {})

    def test_reviews_and_models_in_order(self):
        reviews = replay.review_events(self.scene, self.until)
        self.assertEqual([e['stage'] for e in reviews], ['review', 'review2'])
        self.assertEqual(reviews[0]['say'], '检查房间没通过')
        self.assertTrue(reviews[1]['passed'])
        self.assertEqual([e['issues'] for e in reviews], [['The bed is too bright.'], ['The curtains are too stiff.']])
        self.assertEqual(list(replay.models(self.scene, self.until)), ['seed', 'round0', 'round1', 'final'])

    def test_a_later_pass_on_an_older_run_keeps_its_models(self):
        rows = [{'t': T0 + 5000, 'kind': 'pipeline_stage', 'stage': 'ingest', 'schema_version': 2, 'event_id': 'e1'},
                {'t': T0 + 5100, 'kind': 'artifact_published', 'path': replay.FINAL, 'schema_version': 2,
                 'event_id': 'e2', 'artifact_digest': 'other'},
                {'t': T0 + 5200, 'kind': 'model_saved', 'model': 'articulated', 'schema_version': 2, 'event_id': 'e3'}]
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))
        self.assertEqual(list(replay.models(self.scene, self.until)), ['seed', 'round0', 'round1', 'final'])

    def test_later_records_never_change_an_earlier_moment(self):
        def replayed():
            data = replay.timeline(self.root, 'completed', self.until)
            return data['models'], [(e['t'], e['say'], e.get('model')) for e in data['events']]
        before = replayed()
        rows = [{'t': T0 + 5000, 'kind': 'model_saved', 'model': 'seed', 'path': replay.SEED, 'run': 'attempt-02'},
                {'t': T0 + 5100, 'kind': 'model_saved', 'model': 'round', 'attempt': 'attempt-y', 'round': 0,
                 'schema_version': 2, 'event_id': 'r', 'run': 'attempt-02'},
                {'t': T0 + 5200, 'kind': 'review_done', 'attempt': 'attempt-y', 'round': 0, 'reviewed': True,
                 'folder': 'realism_authoring/acceptance/attempt-x/round_01', 'run': 'attempt-02'}]
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))
        self.assertEqual(replayed(), before)
        self.assertEqual(list(before[0]), ['seed', 'round0', 'round1', 'final'])

    def test_rows_with_a_damaged_sequence_are_read_like_the_writer_reads_them(self):
        # Damaged rows in a row keep the order they were written in, whatever their ids.
        rows = [{'t': T0 + 5, 'kind': 'trace_start', 'schema_version': 2, 'event_id': 'a', 'sequence': 1},
                {'t': T0 + 6, 'kind': 'trace_start', 'schema_version': 2, 'event_id': 'z', 'sequence': None},
                {'t': T0 + 7, 'kind': 'trace_start', 'schema_version': 2, 'event_id': None, 'sequence': '3'},
                {'t': T0 + 8, 'kind': 'trace_start', 'schema_version': 2, 'event_id': 'b', 'sequence': None},
                {'t': T0 + 9, 'kind': 'trace_start', 'schema_version': 2, 'event_id': 'd', 'sequence': 4}]
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))
        self.assertEqual([r['t'] for r in replay.trace_rows(self.scene) if r.get('schema_version') == 2],
                         [T0 + 5, T0 + 6, T0 + 7, T0 + 8, T0 + 9])
        self.assertEqual(list(replay.timeline(self.root, 'completed', self.until)['models'])[-1], 'final')

    def test_a_model_rewritten_after_its_record_is_still_shown(self):
        import hashlib
        row = {'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'path': replay.FINAL, 'schema_version': 2,
               'event_id': 'f', 'artifact_digest': hashlib.sha256(b'before').hexdigest()}
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(json.dumps(row) + '\n')
        evidence = replay.model_evidence(self.scene, replay.trace_rows(self.scene), 'final', replay.FINAL)
        self.assertEqual((evidence['time'], evidence['confidence']), (T0 + 1140, 'unknown'))
        self.assertIn('final', replay.models(self.scene, self.until))

    def test_only_allowlisted_files_are_served(self):
        self.assertIsNotNone(replay.scene_file(self.scene, replay.SEED))
        self.assertIsNotNone(replay.scene_file(self.scene, 'scene_init/obj_stage/traces/img/author_0004_a.jpg'))
        for rel in ['scene_init/obj_stage/traces/trace.jsonl', '../run/pipeline/demo/' + replay.SEED,
                    'scene_init/obj_stage/traces/img/../trace.jsonl', '/etc/passwd', '']:
            self.assertIsNone(replay.scene_file(self.scene, rel), rel)

    def test_agent_records_keep_descriptions_not_commands(self):
        records = replay.agent_records(self.scene, self.until)
        texts = [r['text'] for r in records]
        self.assertIn('Bash: build the first pass', texts)
        self.assertFalse(any(t.startswith('Bash result') for t in texts))
        self.assertEqual(next(r for r in records if r['kind'] == 'images')['img'], 'scene_init/obj_stage/traces/img/author_0004_a.jpg')

    def test_scaffold_converts_layout_to_the_model_frame(self):
        job = self.root / 'job'
        (job / 'run').mkdir(parents=True)
        (job / 'run' / 'pipeline').symlink_to(self.root / 'run' / 'pipeline')
        points, layout = replay.scaffold(job)
        self.assertEqual(points.stat().st_size, 2 * 12)
        data = json.loads(layout.read_text())
        self.assertEqual(data['boxes'][0]['center'], [0, 0.5, -1])
        self.assertEqual(data['boxes'][0]['size'], [1, 2, 0.5])
        self.assertAlmostEqual(data['boxes'][0]['yaw'], 3.14159265 / 2, places=5)
        self.assertEqual(data['walls'][0]['b'], [3, -0])

    def test_a_slim_copy_replays_the_same_without_the_bulk(self):
        bulk = 'scene_init/obj_stage/reconstructed_objs/Storage0/mesh.glb'
        write(self.scene / bulk, 'x' * 1000)
        next_session(self.scene, T0 + 2000)  # the first session is archived, with its raw log
        history = f'{replay.TRACES}/history/authoring_trace.author'
        write(self.scene / f'{history}.raw.run_001.jsonl', '{}\n')
        dest = self.root / 'slim'
        replay.slim(self.root / 'run', dest)
        self.assertFalse((dest / 'pipeline' / 'demo' / bulk).exists())
        self.assertTrue((dest / 'pipeline' / 'demo' / f'{history}.run_001.jsonl').is_file())
        self.assertFalse((dest / 'pipeline' / 'demo' / f'{history}.raw.run_001.jsonl').exists())
        self.assertEqual({r['session'] for r in replay.agent_records(dest / 'pipeline' / 'demo')}, {0, 1})

        def replayed(run):
            job = self.root / ('job-' + run.name)
            (job / 'run').mkdir(parents=True)
            (job / 'run' / 'pipeline').symlink_to(run / 'pipeline')
            return replay.timeline(job), replay.scaffold(job)
        (a, (pa, la)), (b, (pb, lb)) = replayed(self.root / 'run'), replayed(dest)
        self.assertEqual(a, b)
        self.assertEqual((pa.read_bytes(), la.read_text()), (pb.read_bytes(), lb.read_text()))

    def test_scan_points_take_their_colour_from_the_photos(self):
        try:
            import cv2
            import numpy as np
        except ImportError:
            self.skipTest('numpy / OpenCV not installed')
        job = self.root / 'job-colour'
        (job / 'run').mkdir(parents=True)
        (job / 'run' / 'pipeline').symlink_to(self.root / 'run' / 'pipeline')
        self.assertIsNone(replay.scaffold_colors(job))  # no photos yet: tried once, then remembered
        self.assertTrue((job / 'replay' / 'colors.none').is_file())
        (job / 'replay' / 'colors.none').unlink()
        # One camera at the origin looking along +z; the photo is twice the depth map's size and red.
        rgbd = self.scene / 'scene_init/obj_stage/object_init/input/rgbd/demo'
        for d in ('extrinsic', 'intrinsic', 'depth', 'image'):
            (rgbd / d).mkdir(parents=True, exist_ok=True)
        np.save(rgbd / 'extrinsic' / 'extrinsic_0.npy', np.eye(4))
        np.save(rgbd / 'intrinsic' / 'intrinsic_0.npy', np.array([[10, 0, 2], [0, 10, 2], [0, 0, 1]], float))
        depth = np.full((10, 10), 2000, np.uint16)  # 2 m everywhere: point (0, 1, 2) is seen at pixel (2, 7)
        cv2.imencode('.png', depth)[1].tofile(str(rgbd / 'depth' / 'frame_0.jpg'))
        photo = np.zeros((20, 20, 3), np.uint8)
        photo[:, :] = (0, 0, 255)
        cv2.imwrite(str(rgbd / 'image' / 'frame_0.jpg'), photo)
        colours = replay.scaffold_colors(job).read_bytes()
        self.assertEqual(len(colours), 2 * 3)
        red, unseen = colours[:3], colours[3:]  # (3, 4, 5) falls outside the picture
        self.assertGreater(red[0], 200)
        self.assertLess(red[1], 60)
        self.assertEqual(unseen, bytes([150, 150, 150]))
        # hidden behind something nearer: not painted
        (job / 'replay' / 'colors.bin').unlink()
        cv2.imencode('.png', np.full((10, 10), 1000, np.uint16))[1].tofile(str(rgbd / 'depth' / 'frame_0.jpg'))
        self.assertIsNone(replay.scaffold_colors(job))

    def test_a_stray_empty_scene_folder_is_ignored(self):
        job = self.root / 'job3'
        (job / 'run' / 'pipeline' / 'pipeline' / 'scene_init' / 'scene_stage' / 'room_init').mkdir(parents=True)
        (job / 'run' / 'pipeline' / 'demo').symlink_to(self.root / 'run' / 'pipeline' / 'demo')
        self.assertEqual(replay.find_scene(job).name, 'demo')

    def test_scaffold_requested_twice_at_once_is_built_once(self):
        from concurrent.futures import ThreadPoolExecutor
        job = self.root / 'job2'
        (job / 'run').mkdir(parents=True)
        (job / 'run' / 'pipeline').symlink_to(self.root / 'run' / 'pipeline')
        with ThreadPoolExecutor(8) as pool:
            results = list(pool.map(lambda _: replay.scaffold(job), range(8)))
        self.assertTrue(all(r and r[0].stat().st_size == 2 * 12 for r in results))


class TraceRecords(unittest.TestCase):
    """Runs that record object, model and review times in trace.jsonl are timed by them, not by file times."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.scene = make_run(Path(self.tmp.name) / 'run')
        rows = [
            {'t': T0 + 40, 'kind': 'object_done', 'name': 'Storage1', 'method': 'trellis', 'status': 'ok'},
            {'t': T0 + 40, 'kind': 'object_done', 'name': 'Storage1', 'method': 'trellis', 'status': 'ok', 'reused': True},
            {'t': T0 + 45, 'kind': 'object_done', 'name': 'Sofa0', 'method': 'trellis', 'status': 'failed'},
            {'t': T0 + 95, 'kind': 'model_saved', 'model': 'seed', 'path': replay.SEED},
            {'t': T0 + 400, 'kind': 'room_built', 'added': ['Curtain']},
            {'t': T0 + 980, 'kind': 'model_saved', 'model': 'round', 'attempt': 'attempt-x', 'round': 0},
            {'t': T0 + 985, 'kind': 'review_done', 'attempt': 'attempt-x', 'round': 0, 'reviewed': True,
             'folder': 'realism_authoring/acceptance/attempt-x/round_00', 'score': 4.0, 'passed': False},
            {'t': T0 + 1080, 'kind': 'model_saved', 'model': 'round', 'attempt': 'attempt-x', 'round': 1},
            {'t': T0 + 1085, 'kind': 'review_done', 'attempt': 'attempt-x', 'round': 1, 'reviewed': True,
             'folder': 'realism_authoring/acceptance/attempt-x/round_01', 'score': 7.5, 'passed': True},
            {'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'path': replay.FINAL},
        ]
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))

    def tearDown(self):
        self.tmp.cleanup()

    def test_each_ai_made_object_appears_at_its_own_time_once(self):
        events = replay.pipeline_events(self.scene, T0 + 1300)
        made = [e for e in events if e.get('show') == ['Storage1']]
        self.assertEqual([(e['t'], e['say']) for e in made], [(T0 + 40, '做好柜子2的模型')])
        self.assertFalse([e for e in events if e.get('show') == ['Sofa0']])  # failed: nothing to show

    def test_models_and_reviews_use_the_recorded_times(self):
        events = {e['id']: e for e in replay.pipeline_events(self.scene, T0 + 1300)}
        self.assertEqual(events['seed']['t'], T0 + 95)
        self.assertEqual(events['final']['t'], T0 + 1140)
        self.assertEqual([events['r0']['t'], events['r1']['t']], [T0 + 985, T0 + 1085])
        self.assertEqual(events['r1']['model'], 'round1')
        self.assertEqual(list(replay.models(self.scene, T0 + 1300)), ['seed', 'round0', 'round1', 'final'])
        self.assertEqual(list(replay.models(self.scene, T0 + 1000)), ['seed', 'round0'])

    def test_a_part_shows_from_the_first_build_that_has_it(self):
        glb(self.scene / replay.SEED, {'@roots': ['Floor0', 'Bed0']}, T0 + 100)
        glb(self.scene / replay.FINAL, {'@roots': ['Floor0', 'Bed0', 'Curtain', 'Lamp']}, T0 + 1150)
        times = {r['node']: r['t'] for r in replay.build_schedule(self.scene, T0 + 1300)['reveal']}
        self.assertEqual(times['Curtain'], T0 + 400)  # built, though the log never names it
        self.assertEqual(times['Lamp'], T0 + 610)  # no build record: falls back to the session end


class LiveRecords(unittest.TestCase):
    """A new run watched live: the final room is not shown early, a retry is marked, the repair and the
    openable-parts pass show, and objects / chairs report as they finish."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.scene = make_run(Path(self.tmp.name) / 'run')
        self.rows = [
            {'t': T0 + 5, 'kind': 'trace_start', 'run': 'attempt-01'},
            {'t': T0 + 6, 'kind': 'trace_start', 'run': 'attempt-01'},  # each stage process starts the trace
            {'t': T0 + 40, 'kind': 'object_done', 'name': 'Storage0', 'method': 'procedural', 'status': 'ok', 'run': 'attempt-01'},
            {'t': T0 + 86, 'kind': 'chair_qc_retry', 'cluster': 'ChairCluster0', 'attempt': 1, 'status': 'ok'},
            {'t': T0 + 95, 'kind': 'model_saved', 'model': 'seed', 'run': 'attempt-01'},
        ]
        self.append(self.rows)

    def append(self, rows):
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_final_room_is_not_shown_while_the_agent_still_builds_it(self):
        # make_run leaves realism_authoring/room_preview/Room.glb (rewritten by every agent build).
        events = {e['id']: e for e in replay.pipeline_events(self.scene, T0 + 1300)}
        self.assertNotIn('final', events)
        self.assertNotIn('final', replay.models(self.scene, T0 + 1300))
        self.append([{'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'run': 'attempt-01'}])
        self.assertEqual({e['id']: e for e in replay.pipeline_events(self.scene, T0 + 1300)}['final']['t'], T0 + 1140)

    def test_the_room_being_built_shows_until_the_final_one_is_saved(self):
        key = replay.draft_key(T0 + 1150)  # make_run's FINAL file time
        self.assertEqual(replay.models(self.scene, T0 + 1300)[key], replay.FINAL)
        events = {e['id']: e for e in replay.pipeline_events(self.scene, T0 + 1300)}
        self.assertEqual((events[key]['t'], events[key]['model']), (T0 + 1150, key))
        self.assertNotIn(key, replay.models(self.scene, T0 + 1100))  # not built yet at that time
        self.append([{'t': T0 + 1160, 'kind': 'model_saved', 'model': 'final', 'run': 'attempt-01'}])
        models = replay.models(self.scene, T0 + 1300)
        self.assertIn('final', models)
        self.assertFalse([k for k in models if k.startswith('draft')])

    def test_masks_and_texture_maps_are_not_shown_as_pictures(self):
        rows = [{'seq': 1, 't': T0 + 300, 'kind': 'images', 'n_images': 3,
                 'saved': ['img/author_0010_Wall9_stitched_unknown_mask.jpg', 'img/author_0010_oak_rough.jpg', 'img/author_0010_Wall9_stitched.jpg']},
                {'seq': 2, 't': T0 + 310, 'kind': 'images', 'n_images': 1, 'saved': ['img/author_0011_floor_normal.jpg']}]
        write(self.scene / replay.TRACES / 'authoring_trace.extra.jsonl', ''.join(json.dumps(r) + '\n' for r in rows))
        images = [r['img'] for r in replay.agent_records(self.scene) if r['key'].startswith('extra:')]
        self.assertEqual(images, [f'{replay.TRACES}/img/author_0010_Wall9_stitched.jpg', None])

    def test_a_clear_picture_does_not_show_the_model_made_after_it(self):
        def first(work):
            return next(e for e in replay.pipeline_events(self.scene, T0 + 1300) if e.get('work') == work)
        self.assertEqual((first('image')['object_id'], first('image')['img']), ('Storage0', None))
        self.assertEqual(first('model')['img'], 'scene_init/obj_stage/reconstructed_objs/Storage0/previews/preview_front.png')
        write(self.scene / 'scene_init/obj_stage/object_init/object_refs/storage/Storage0/reference_1024.png')
        self.assertEqual(first('image')['img'], 'scene_init/obj_stage/object_init/object_refs/storage/Storage0/reference_1024.png')

    def test_a_finished_object_is_said_once_and_retries_still_show(self):
        says = [e['say'] for e in sorted(replay.pipeline_events(self.scene, T0 + 1300), key=lambda e: e['t'])
                if e.get('show') == ['Storage0']]
        self.assertEqual(says, ['做好柜子1的模型', '重做柜子1的模型'])  # attempt1's agent_step is covered by object_done
        self.append([{'t': T0 + 75, 'kind': 'agent_step', 'name': 'Storage1', 'step': 'Storage1:attempt1', 'is_error': True}])
        failed = [e for e in replay.pipeline_events(self.scene, T0 + 1300) if e.get('show') == ['Storage1']]
        self.assertEqual([(e['kind'], e['say']) for e in failed], [('error', '柜子2的模型这次没做成')])
        chair = [e for e in replay.pipeline_events(self.scene, T0 + 1300) if e['say'].startswith('重新生成')]
        self.assertEqual(chair[0]['say'], '重新生成椅子（第 1 次），形状检查通过')

    def test_a_retried_run_is_marked_and_counts_its_own_checks(self):
        self.append([
            {'t': T0 + 990, 'kind': 'review_done', 'reviewed': True, 'passed': False, 'run': 'attempt-01',
             'folder': 'realism_authoring/acceptance/attempt-x/round_00'},
            {'t': T0 + 1050, 'kind': 'trace_start', 'run': 'attempt-02'},
            {'t': T0 + 1090, 'kind': 'review_done', 'reviewed': True, 'passed': True, 'run': 'attempt-02',
             'folder': 'realism_authoring/acceptance/attempt-x/round_01'},
        ])
        events = replay.pipeline_events(self.scene, T0 + 1300)
        self.assertEqual([e['say'] for e in events if e['kind'] == 'milestone' and e['say'].startswith('重新')],
                         ['重新开始重建，接着上次做好的部分继续'])
        self.assertEqual([e['say'] for e in events if e['kind'] == 'review'], ['检查房间没通过', '检查房间：通过'])

    def test_a_next_attempt_is_marked_only_after_one_that_did_not_finish(self):
        self.append([{'t': T0 + 1050, 'kind': 'trace_start', 'run': 'attempt-02'}])
        restarts = lambda: [e['t'] for e in replay.pipeline_events(self.scene, T0 + 1300) if e['say'].startswith('重新开始')]
        self.assertEqual(restarts(), [T0 + 1050])  # no exit file (older runs): marked as before
        write(self.scene.parent.parent / 'attempt-01' / 'exit', '0\n')
        self.assertEqual(restarts(), [])  # that phase finished: the next one just follows
        write(self.scene.parent.parent / 'attempt-01' / 'exit', '1\n')
        self.assertEqual(restarts(), [T0 + 1050])

    def test_a_web_retry_is_still_marked(self):
        job = self.scene.parent.parent.parent  # <job>/run/pipeline/demo, as the room service runs it
        write(job / 'run' / 'attempt-01' / 'exit', '2\n')
        self.append([{'t': T0 + 1050, 'kind': 'trace_start', 'run': 'attempt-02'}])
        says = [e['say'] for e in replay.timeline(job, 'running', T0 + 1300)['events']]
        self.assertIn('重新开始重建，接着上次做好的部分继续', says)

    def test_a_model_taken_over_from_an_earlier_reconstruction_reads_as_made_once(self):
        self.append([{'t': T0 + 41, 'kind': 'object_done', 'name': 'Storage1', 'method': 'provided', 'status': 'ok',
                      'source': '/runs/earlier/pipeline/demo', 'run': 'attempt-01'},
                     {'t': T0 + 1100, 'kind': 'object_done', 'name': 'Storage1', 'method': 'trellis', 'status': 'ok',
                      'reused': True, 'source': '/runs/earlier/pipeline/demo', 'run': 'attempt-02'}])
        shown = [e for e in replay.pipeline_events(self.scene, T0 + 1300) if e.get('show') == ['Storage1']]
        self.assertEqual([(e['t'], e['say']) for e in shown], [(T0 + 41, '做好柜子2的模型')])
        self.assertFalse([e for e in replay.pipeline_events(self.scene, T0 + 1300) if '沿用' in e['say']])

    def test_the_repair_session_shows_in_its_own_stage(self):
        self.append([{'t': T0 + 990, 'kind': 'review_done', 'reviewed': True, 'passed': False, 'run': 'attempt-01',
                      'folder': 'realism_authoring/acceptance/attempt-x/round_00'},
                     {'t': T0 + 995, 'kind': 'repair_start', 'run': 'attempt-01'}])
        repair = [{'seq': 1, 't': T0 + 1000, 'kind': 'session_start'},
                  {'seq': 2, 't': T0 + 1010, 'kind': 'tool', 'tool': 'Bash', 'hint': 'python Room.py'}]
        write(self.scene / replay.TRACES / 'authoring_trace.repair.jsonl', ''.join(json.dumps(r) + '\n' for r in repair))
        self.assertFalse([r for r in replay.agent_records(self.scene) if r['key'].startswith('repair:')])
        data = replay.timeline(self.scene.parent.parent.parent, 'running', T0 + 1300)
        repair_says = [(e['stage'], e['say']) for e in data['events'] if e['stage'] == 'review2']
        self.assertIn(('review2', '按检查出的问题开始修复房间'), repair_says)
        self.assertIn(('review2', '按检查意见修改房间'), repair_says)

    def test_the_openable_parts_room_is_the_last_model(self):
        run = self.scene.parent.parent
        write(run / replay.ARTICULATED, t=T0 + 1250)
        self.assertNotIn('articulated', replay.models(self.scene, T0 + 1300))  # not recorded yet
        self.append([{'t': T0 + 1200, 'kind': 'articulate_start', 'run': 'attempt-01'},
                     {'t': T0 + 1250, 'kind': 'articulate_done', 'status': 'ok', 'run': 'attempt-01'},
                     {'t': T0 + 1250, 'kind': 'model_saved', 'model': 'articulated', 'run': 'attempt-01'}])
        events = replay.pipeline_events(self.scene, T0 + 1300)
        self.assertEqual([(e['stage'], e.get('model')) for e in events if e['stage'] == 'articulate'],
                         [('articulate', None), ('articulate', 'articulated')])
        self.assertEqual(replay.models(self.scene, T0 + 1300)['articulated'], replay.ARTICULATED)
        self.assertEqual(replay.scene_file(self.scene, replay.ARTICULATED), (run / replay.ARTICULATED).resolve())
        self.assertIsNone(replay.scene_file(self.scene, '../../articulate/room_preview/Room.glb'))

    def test_an_openable_parts_try_a_later_attempt_followed_does_not_end_the_replay(self):
        self.append([{'t': T0 + 900, 'kind': 'articulate_start', 'run': 'attempt-01'},
                     {'t': T0 + 950, 'kind': 'trace_start', 'run': 'attempt-02'},
                     {'t': T0 + 1200, 'kind': 'articulate_start', 'run': 'attempt-02'}])
        data = replay.timeline(self.scene.parent.parent.parent, 'completed', T0 + 1300)
        starts = [e['t'] for e in data['events'] if e['say'].startswith('找出柜门')]
        self.assertEqual(starts, [T0 + 1200])
        self.assertEqual([e['stage'] for e in data['events'] if e['t'] < T0 + 1200].count('articulate'), 0)


# The agent's adjusting and self-checks count as building the room; a second check, as the repair. The openable
# parts come before the check; an older run that made them after publishing lists them last (OLD).
EIGHT = ['scan', 'layout', 'photos', 'plan', 'assemble', 'parts', 'review', 'review2']
OLD = ['scan', 'layout', 'photos', 'plan', 'assemble', 'review', 'review2', 'articulate']


def phased(run):
    """A run its operator launched in phases, each its own attempt: objects (one model taken over from an
    earlier reconstruction), author (whose own openable-parts try failed), small objects, openable parts."""
    scene = make_run(run)
    rows = [
        {'t': T0 + 5, 'kind': 'trace_start', 'run': 'attempt-01'},
        {'t': T0 + 40, 'kind': 'object_done', 'name': 'Storage1', 'method': 'provided', 'status': 'ok',
         'reused': True, 'source': '/runs/earlier/pipeline/demo', 'run': 'attempt-01'},
        {'t': T0 + 95, 'kind': 'model_saved', 'model': 'seed', 'run': 'attempt-01'},
        {'t': T0 + 150, 'kind': 'trace_start', 'run': 'attempt-02'},
        {'t': T0 + 1080, 'kind': 'model_saved', 'model': 'round', 'run': 'attempt-02'},
        {'t': T0 + 1085, 'kind': 'review_done', 'reviewed': True, 'passed': True, 'run': 'attempt-02',
         'folder': 'realism_authoring/acceptance/attempt-x/round_01'},
        {'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'run': 'attempt-02'},
        {'t': T0 + 1150, 'kind': 'articulate_start', 'run': 'attempt-02'},
        {'t': T0 + 1160, 'kind': 'articulate_done', 'status': 'failed', 'run': 'attempt-02'},
        {'t': T0 + 2000, 'kind': 'trace_start', 'run': 'attempt-03'},
        {'t': T0 + 2010, 'kind': 'small_objects_start', 'run': 'attempt-03'},
        {'t': T0 + 2200, 'kind': 'small_object_done', 'name': 'TissueBox0', 'method': 'trellis', 'status': 'ok', 'run': 'attempt-03'},
        {'t': T0 + 2300, 'kind': 'small_object_done', 'name': 'WaterBottle1', 'method': 'trellis', 'status': 'ok', 'run': 'attempt-03'},
        {'t': T0 + 2310, 'kind': 'small_object_done', 'name': 'Mug0', 'method': 'dropped', 'status': 'ok', 'run': 'attempt-03'},
        {'t': T0 + 2320, 'kind': 'small_object_done', 'name': 'Book0', 'method': 'kept', 'status': 'ok', 'run': 'attempt-03'},
        {'t': T0 + 2500, 'kind': 'small_objects_done', 'rebuilt': 2, 'dropped': 1, 'kept': 1, 'run': 'attempt-03'},
        {'t': T0 + 2510, 'kind': 'model_saved', 'model': 'small_objects', 'run': 'attempt-03',
         'path': str((run / replay.SMALL_OBJECTS).resolve())},
        {'t': T0 + 3000, 'kind': 'trace_start', 'run': 'attempt-04'},
        {'t': T0 + 3010, 'kind': 'articulate_start', 'run': 'attempt-04'},
        {'t': T0 + 3300, 'kind': 'articulate_done', 'status': 'ok', 'run': 'attempt-04'},
        {'t': T0 + 3300, 'kind': 'model_saved', 'model': 'articulated', 'run': 'attempt-04'},
    ]
    with (scene / replay.TRACES / 'trace.jsonl').open('a') as f:
        f.write(''.join(json.dumps(r) + '\n' for r in rows))
    for k in range(1, 5):
        write(run / f'attempt-0{k}' / 'exit', '0\n')
    write(run / replay.SMALL_OBJECTS, b'small', T0 + 2505)
    write(run / replay.ARTICULATED, b'articulated', T0 + 3290)
    return scene


class PhasedRun(unittest.TestCase):
    """A run launched in phases reads as one reconstruction, with the small-object pass before the openable parts."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.run = self.root / 'run'
        self.scene = phased(self.run)
        self.data = self.root / 'jobs'
        self.data.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_phases_read_as_one_reconstruction(self):
        job = self.data / replay.register(self.data, self.run, 'phased')  # the run through a symlink
        data = replay.timeline(job, 'completed', json.loads((job / 'job.json').read_text())['until'])
        events = data['events']
        self.assertFalse([e for e in events if e['say'].startswith('重新开始')])
        self.assertEqual([s['id'] for s in data['stages']], OLD[:-1] + ['small_objects', 'articulate'])
        self.assertEqual([e['stage'] for e in events if e['t'] > T0 + 1140], ['small_objects'] * 4 + ['articulate'] * 2)
        self.assertEqual([e['say'] for e in events if e['stage'] == 'small_objects'],
                         ['逐个看房间里的小物品，挑出需要按照片重做的', '纸巾盒换成了按照片重建的模型', '瓶子换成了按照片重建的模型',
                          '小物品处理好了：按照片重做 2 件，去掉 1 件，1 件保持原样'])
        self.assertEqual([e['model'] for e in events if e.get('model')], ['seed', 'round0', 'final', 'small_objects', 'articulated'])
        self.assertEqual(list(data['models']), ['seed', 'round0', 'final', 'small_objects', 'articulated'])
        self.assertEqual(data['models']['small_objects'], replay.SMALL_OBJECTS)
        self.assertIn('做好柜子2的模型', [e['say'] for e in events])
        self.assertEqual(data['model_evidence']['small_objects']['time'], T0 + 2510)

    def test_a_live_view_shows_the_pass_as_it_goes(self):
        data = replay.timeline(self.root, 'running', T0 + 2400)  # <root>/run/pipeline/demo
        self.assertEqual(data['stages'][-2]['id'], 'small_objects')
        self.assertEqual(data['events'][-1]['say'], '瓶子换成了按照片重建的模型')
        self.assertNotIn('small_objects', data['models'])
        summary = replay.timeline(self.root, 'running', T0 + 2505)['events'][-1]  # counted, the room not saved yet
        self.assertEqual((summary['t'], summary.get('model')), (T0 + 2500, None))

    def test_a_run_without_the_pass_is_unchanged(self):
        job = self.root / 'plain'
        make_run(job / 'run')
        data = replay.timeline(job, 'completed', T0 + 1300)
        self.assertEqual([s['id'] for s in data['stages']], EIGHT)
        self.assertEqual(list(data['models']), ['seed', 'round0', 'round1', 'final'])
        self.assertEqual(replay.timeline(self.root / 'none')['stages'], replay.stages_of([]))

    def test_a_later_pass_replaces_an_earlier_one(self):
        # The passes number their runs on their own: attempt-01 and attempt-02 again, as the main run did (whose
        # attempt-02 tried the openable parts itself and failed).
        rows = [
            {'t': T0 + 3900, 'kind': 'small_objects_start', 'through': 'evidence', 'run': 'attempt-01'},
            {'t': T0 + 4000, 'kind': 'small_objects_start', 'run': 'attempt-01'},
            {'t': T0 + 4100, 'kind': 'small_object_done', 'name': 'WaterBottle1', 'method': 'trellis', 'status': 'ok', 'run': 'attempt-01'},
            {'t': T0 + 4110, 'kind': 'small_object_done', 'name': 'TissueBox0', 'method': 'kept', 'status': 'ok', 'run': 'attempt-01'},
            {'t': T0 + 4200, 'kind': 'small_objects_done', 'rebuilt': 1, 'kept': 1, 'run': 'attempt-01'},
            {'t': T0 + 4210, 'kind': 'model_saved', 'model': 'small_objects', 'run': 'attempt-01'},
            {'t': T0 + 4500, 'kind': 'articulate_start', 'run': 'attempt-02'},
            {'t': T0 + 4800, 'kind': 'articulate_done', 'status': 'ok', 'run': 'attempt-02'},
            {'t': T0 + 4800, 'kind': 'model_saved', 'model': 'articulated', 'run': 'attempt-02'},
        ]
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))
        events = replay.timeline(self.root, 'completed', T0 + 5000)['events']
        self.assertEqual([(e['t'], e['stage'], e['say']) for e in events if e['t'] > T0 + 1140], [
            (T0 + 4000, 'small_objects', '逐个看房间里的小物品，挑出需要按照片重做的'),
            (T0 + 4100, 'small_objects', '瓶子换成了按照片重建的模型'),
            (T0 + 4210, 'small_objects', '小物品处理好了：按照片重做 1 件，1 件保持原样'),
            (T0 + 4500, 'articulate', '找出柜门、抽屉等能开合的部件，开始装转轴和滑轨'),
            (T0 + 4800, 'articulate', '装好可开合部件，这就是发布的房间')])
        # Before the openable parts are made again, the earlier openable-parts room does not end the replay.
        events = replay.timeline(self.root, 'running', T0 + 4150)['events']
        self.assertEqual([(e['t'], e['stage']) for e in events if e['t'] > T0 + 1140],
                         [(T0 + 4000, 'small_objects'), (T0 + 4100, 'small_objects')])
        # Only the evidence run so far: no line of the pass before it is left.
        events = replay.timeline(self.root, 'running', T0 + 3950)['events']
        self.assertEqual([(e['t'], e['say']) for e in events if e['stage'] == 'small_objects'],
                         [(T0 + 3900, '逐个看房间里的小物品，挑出需要按照片重做的')])

    def test_the_room_is_found_where_its_record_says(self):
        (self.run / replay.SMALL_OBJECTS).unlink()
        inside = write(self.scene / 'realism_authoring/small_objects/room_preview/Room.glb', b'small', T0 + 2505)
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(json.dumps({'t': T0 + 2510, 'kind': 'model_saved', 'model': 'small_objects', 'run': 'attempt-03',
                                'path': 'realism_authoring/small_objects/room_preview/Room.glb'}) + '\n')
        self.assertEqual(replay.scene_file(self.scene, replay.SMALL_OBJECTS), inside.resolve())
        outside = write(self.root / 'elsewhere/room_preview/Room.glb')
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(json.dumps({'t': T0 + 2520, 'kind': 'model_saved', 'model': 'small_objects', 'path': str(outside)}) + '\n')
        self.assertIsNone(replay.scene_file(self.scene, replay.SMALL_OBJECTS))  # outside the run: refused

    def test_a_rebuilt_item_shows_its_photo_and_once_applied_the_rebuilt_model(self):
        photo = write(self.run / 'small-objects/evidence/TissueBox0/view0.jpg', b'photo', T0 + 2050)
        write(self.run / 'small-objects/evidence/TissueBox0/pair_after.jpg', b'pair', T0 + 2505)
        write(self.run / 'small-objects/evidence/TissueBox0/decision_reply.txt')
        items = [e for e in replay.timeline(self.root, 'completed', T0 + 4000)['events'] if e.get('work') == 'small']
        self.assertEqual([(e['object_id'], e['object_name'], e['img']) for e in items],
                         [('TissueBox0', '纸巾盒', 'small-objects/evidence/TissueBox0/view0.jpg'), ('WaterBottle1', '瓶子', None)])
        self.assertEqual([m['role'] for m in items[0]['media']], ['photo', 'comparison'])
        self.assertGreater(items[0]['media'][1]['minute'], items[0]['minute'])  # rendered after the item was done
        live = [e for e in replay.timeline(self.root, 'running', T0 + 2400)['events'] if e.get('work') == 'small']
        self.assertEqual([m['role'] for m in live[0]['media']], ['photo'])
        self.assertEqual(replay.scene_file(self.scene, 'small-objects/evidence/TissueBox0/view0.jpg'), photo.resolve())
        for refused in ('small-objects/evidence/TissueBox0/decision_reply.txt', 'small-objects/evidence/../room_preview/Room.glb'):
            self.assertIsNone(replay.scene_file(self.scene, refused))
        replay.slim(self.run, self.root / 'slim')
        self.assertEqual((self.root / 'slim/small-objects/evidence/TissueBox0/view0.jpg').read_bytes(), b'photo')

    def test_an_item_made_from_a_premade_model_shows_that_models_reference(self):
        models = self.root / 'models'  # LR_SMALL_OBJECTS_MODELS, outside the run as premake leaves it
        write(models / 'TissueBox.glb')
        reference = write(models / 'work/TissueBox/reference.png', b'reference', T0 + 3000)
        write(models / 'work/WaterBottle/reference.png', b'later', T0 + 4500)  # made after the item was done
        write(self.run / 'small-objects/evidence/TissueBox0/view0.jpg', b'photo', T0 + 3950)
        rows = [{'t': T0 + 3900, 'kind': 'small_objects_start', 'run': 'attempt-05'},
                {'t': T0 + 4100, 'kind': 'small_object_done', 'name': 'TissueBox0', 'method': 'trellis', 'status': 'ok',
                 'source': str(models / 'TissueBox.glb'), 'run': 'attempt-05'},
                {'t': T0 + 4110, 'kind': 'small_object_done', 'name': 'WaterBottle1', 'method': 'trellis', 'status': 'ok',
                 'source': str(models / 'WaterBottle.glb'), 'run': 'attempt-05'}]
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))
        items = [e for e in replay.timeline(self.root, 'completed', T0 + 5000)['events'] if e.get('work') == 'small']
        self.assertEqual([(e['object_id'], e['img'], [m['role'] for m in e['media']]) for e in items],
                         [('TissueBox0', 'small-objects/reference/TissueBox0.png', ['reference', 'photo']), ('WaterBottle1', None, [])])
        self.assertEqual(replay.scene_file(self.scene, 'small-objects/reference/TissueBox0.png'), reference.resolve())
        for refused in ('small-objects/reference/WaterBottle0.png', 'small-objects/reference/../evidence.png'):
            self.assertIsNone(replay.scene_file(self.scene, refused))
        replay.slim(self.run, self.root / 'slim')
        self.assertEqual(replay.scene_file(self.root / 'slim/pipeline/demo', 'small-objects/reference/TissueBox0.png').read_bytes(), b'reference')

    def test_an_item_framed_with_its_whole_shelf_shows_its_own_part(self):
        camera = {'frame_index': 7, 'position': [0, 0, 0], 'forward': [0, 1, 0], 'up': [0, 0, 1],
                  'intrinsics': {'fx': 1000, 'fy': 1000, 'cx': 960, 'cy': 720}, 'resolution': [1920, 1440]}
        write(self.scene / 'realism_authoring/room_preview/room_layout.json', json.dumps({'cameras': [camera]}))
        box = {'bbox_min': [-0.05, 1.95, -0.05], 'bbox_max': [0.05, 2.05, 0.05]}  # about 50 px across, mid-frame
        items = [{'id': 'TissueBox0', **box, 'views': [{'frame': 7, 'rect': [0, 0, 1920, 1440], 'turns': 0}]},
                 {'id': 'WaterBottle1', **box, 'views': [{'frame': 7, 'rect': [880, 640, 1040, 800], 'turns': 0}]}]
        write(self.run / 'small-objects/items.json', json.dumps(items))
        # The whole frame was cropped: the item's own square (96 px at least); framed closely: none.
        self.assertEqual(replay.small_closeups(self.scene, ['TissueBox0', 'WaterBottle1']), {'TissueBox0': [0.475, 0.4667, 0.525, 0.5333]})
        items[0]['views'][0]['turns'] = 1  # the crop was turned a quarter to stand upright
        write(self.run / 'small-objects/items.json', json.dumps(items))
        write(self.run / 'small-objects/evidence/TissueBox0/view0.jpg', b'photo', T0 + 2050)
        item = next(e for e in replay.timeline(self.root, 'completed', T0 + 4000)['events'] if e.get('object_id') == 'TissueBox0')
        self.assertEqual(item['media'][0]['crop'], [0.4667, 0.475, 0.5333, 0.525])

    def test_rebuilt_items_sharing_a_name_are_numbered(self):
        self.assertEqual(replay.small_names({'WaterBottle1', 'WaterBottle0', 'ShelfC0R0B', 'Thing7', 'Thing8'}, lambda key: key),
                         {'WaterBottle0': '瓶子1', 'WaterBottle1': '瓶子2', 'ShelfC0R0B': '架上物品',
                          'Thing7': '小物品1', 'Thing8': '小物品2'})

    def test_a_slim_copy_keeps_the_pass_and_how_each_attempt_ended(self):
        dest = self.root / 'slim'
        replay.slim(self.run, dest)
        self.assertEqual((dest / 'attempt-02' / 'exit').read_text(), '0\n')
        self.assertEqual((dest / replay.SMALL_OBJECTS).read_bytes(), b'small')
        a = replay.timeline(self.data / replay.register(self.data, self.run, 'a'), 'completed', T0 + 4000)
        b = replay.timeline(self.data / replay.register(self.data, dest, 'b'), 'completed', T0 + 4000)
        self.assertEqual(a, b)
        self.assertFalse([e for e in b['events'] if e['say'].startswith('重新开始')])

    def test_the_replay_route_serves_the_pass(self):
        jobs = service.Jobs(self.data, Path.cwd(), runner='cli')
        identifier = replay.register(self.data, self.run, 'phased')
        handler = type('H', (service.Handler,), {'jobs': jobs, 'log_message': lambda *a: None})
        server = service.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            base = f'http://127.0.0.1:{server.server_port}/room-reconstruction/jobs'
            urlopen(base, timeout=10).close()  # picks up the registered run
            base += f'/{identifier}/replay'
            with urlopen(base, timeout=10) as response:
                data = json.loads(response.read())
            self.assertEqual(list(data['models'])[-2:], ['small_objects', 'articulated'])
            with urlopen(f'{base}/files/{data["models"]["small_objects"]}', timeout=10) as response:
                self.assertEqual(response.read(), b'small')
        finally:
            server.shutdown(); server.server_close()


def before_the_check(run):
    """A run of the current flow: the author stage does the small objects and openable parts on the room it
    built, checks that room, repairs it and does both passes again on the repaired room."""
    scene = make_run(run)
    small, parts = 'realism_authoring/small_objects/room_preview/Room.glb', 'realism_authoring/articulate/room_preview/Room.glb'
    inside = {'stage': 'author', 'run': 'attempt-01'}
    rows = [
        {'t': T0 + 100, 'kind': 'model_saved', 'model': 'seed', 'run': 'attempt-01'},
        {'t': T0 + 700, 'kind': 'small_objects_start', **inside},
        {'t': T0 + 760, 'kind': 'small_object_done', 'name': 'TissueBox0', 'method': 'trellis', 'status': 'ok',
         'reused': False, **inside},
        {'t': T0 + 770, 'kind': 'small_object_done', 'name': 'Mug0', 'method': 'dropped', 'status': 'ok', **inside},
        {'t': T0 + 780, 'kind': 'small_objects_done', 'rebuilt': 1, 'dropped': 1, 'kept': 0, **inside},
        {'t': T0 + 790, 'kind': 'model_saved', 'model': 'small_objects', 'path': small, **inside},
        {'t': T0 + 800, 'kind': 'articulate_start', 'source': 'x', **inside},
        {'t': T0 + 900, 'kind': 'articulate_done', 'status': 'ok', 'exit': 0, **inside},
        {'t': T0 + 900, 'kind': 'model_saved', 'model': 'articulated', 'path': parts, **inside},
        {'t': T0 + 990, 'kind': 'model_saved', 'model': 'round', 'attempt': 'x', 'round': 0, **inside},
        {'t': T0 + 1000, 'kind': 'review_done', 'reviewed': True, 'passed': False, 'attempt': 'x', 'round': 0,
         'folder': 'realism_authoring/acceptance/attempt-x/round_00', **inside},
        {'t': T0 + 1010, 'kind': 'repair_start', **inside},
        {'t': T0 + 1050, 'kind': 'small_objects_start', **inside},
        {'t': T0 + 1060, 'kind': 'small_object_done', 'name': 'TissueBox0', 'method': 'trellis', 'status': 'ok',
         'reused': True, **inside},
        {'t': T0 + 1065, 'kind': 'small_object_done', 'name': 'WaterBottle1', 'method': 'trellis', 'status': 'ok',
         'reused': False, **inside},
        {'t': T0 + 1080, 'kind': 'small_objects_done', 'rebuilt': 2, 'dropped': 1, 'kept': 0, **inside},
        {'t': T0 + 1085, 'kind': 'model_saved', 'model': 'small_objects', 'path': small, **inside},
        {'t': T0 + 1090, 'kind': 'articulate_start', 'source': 'x', **inside},
        {'t': T0 + 1120, 'kind': 'articulate_done', 'status': 'ok', 'exit': 0, **inside},
        {'t': T0 + 1120, 'kind': 'model_saved', 'model': 'articulated', 'path': parts, **inside},
        {'t': T0 + 1130, 'kind': 'repair_done', 'status': 'repaired', **inside},
        {'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'stage': 'publish', 'run': 'attempt-01'},
    ]
    with (scene / replay.TRACES / 'trace.jsonl').open('a') as f:
        f.write(''.join(json.dumps(r) + '\n' for r in rows))
    write(run / 'attempt-01' / 'exit', '0\n')
    write(scene / small, b'small', T0 + 1084)
    write(scene / parts, b'articulated', T0 + 1119)
    return scene


class PassesBeforeTheCheck(unittest.TestCase):
    """The author stage completes its room with the small objects and openable parts, then checks it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.scene = before_the_check(self.root / 'run')

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_passes_come_before_the_check_and_again_with_the_repair(self):
        data = replay.timeline(self.root, 'completed', T0 + 1300)
        self.assertEqual([s['id'] for s in data['stages']], EIGHT)
        events = [(e['t'] - T0, e['stage'], e['say'], e.get('model')) for e in data['events'] if e['t'] > T0 + 650]
        self.assertEqual(events, [
            (700, 'assemble', '逐个看房间里的小物品，挑出需要按照片重做的', None),
            (760, 'assemble', '纸巾盒换成了按照片重建的模型', None),
            (790, 'assemble', '小物品处理好了：按照片重做 1 件，去掉 1 件', None),
            (800, 'parts', '找出柜门、抽屉等能开合的部件，开始装转轴和滑轨', None),
            (900, 'parts', '装好可开合部件', None),
            (1000, 'review', '检查房间没通过', 'round0'),
            (1010, 'review2', '按检查出的问题开始修复房间', None),
            (1050, 'review2', '逐个看房间里的小物品，挑出需要按照片重做的', None),
            (1065, 'review2', '瓶子换成了按照片重建的模型', None),  # the tissue box was done already
            (1085, 'review2', '小物品处理好了：按照片重做 2 件，去掉 1 件', 'small_objects'),
            (1090, 'review2', '找出柜门、抽屉等能开合的部件，开始装转轴和滑轨', None),
            (1120, 'review2', '装好可开合部件', 'articulated'),
            (1130, 'review2', '按检查出的问题修好了房间', None),
            (1140, 'review2', '导出最终房间', 'final')])
        self.assertEqual(list(data['models']), ['seed', 'round0', 'final', 'small_objects', 'articulated'])
        self.assertEqual(replay.scene_file(self.scene, replay.ARTICULATED),
                         (self.scene / 'realism_authoring/articulate/room_preview/Room.glb').resolve())
        self.assertFalse([e for e in data['events'] if re.search('沿用|复用', e['say'])])

    def test_a_repair_that_changed_nothing_says_so_and_an_older_record_reads_as_before(self):
        rows = replay.trace_rows(self.scene)
        done = next(r for r in rows if r['kind'] == 'repair_done')
        self.assertNotIn('changed', done)  # this run's records are of the older kind
        says = [e['say'] for e in replay.review_events(self.scene) if e['id'].startswith('fix')]
        self.assertEqual(says, ['按检查出的问题修好了房间'])
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(json.dumps({'t': T0 + 1135, 'kind': 'repair_done', 'status': 'repaired', 'changed': False,
                                'stage': 'author', 'run': 'attempt-02'}) + '\n')
        says = [e['say'] for e in replay.review_events(self.scene) if e['id'].startswith('fix')]
        self.assertEqual(says, ['按检查出的问题修好了房间', '按检查意见尝试修改，房间没有变化'])

    def test_without_a_repair_the_rooms_of_the_passes_show_before_the_check(self):
        data = replay.timeline(self.root, 'running', T0 + 1005)
        self.assertEqual([(e['t'] - T0, e['stage'], e.get('model')) for e in data['events'] if e.get('kind') == 'milestone'
                          and e['t'] > T0 + 650], [(790, 'assemble', 'small_objects'), (900, 'parts', 'articulated')])
        self.assertEqual([s['id'] for s in data['stages']], EIGHT)


def glb(path, tree, t):
    """A GLB with only a JSON chunk: tree = {name: [child names]} for the scene's top-level nodes."""
    import struct
    nodes, roots = [], []

    def add(name, children):
        k = len(nodes)
        nodes.append({'name': name})
        kids = [add(c, tree.get(c, [])) for c in children]
        if kids:
            nodes[k]['children'] = kids
        return k
    roots = [add(name, tree.get(name, [])) for name in tree['@roots']]
    body = json.dumps({'scenes': [{'nodes': roots}], 'nodes': nodes}).encode()
    body += b' ' * (-len(body) % 4)
    data = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(body)) + struct.pack('<II', len(body), 0x4E4F534A) + body
    write(path, data, t)


class BuildSchedule(unittest.TestCase):
    def test_agent_added_parts_appear_when_first_named(self):
        with tempfile.TemporaryDirectory() as tmp:
            scene = make_run(Path(tmp) / 'run')
            glb(scene / replay.SEED, {'@roots': ['Floor0', 'Bed0'], 'Bed0': []}, T0 + 100)
            glb(scene / replay.FINAL, {'@roots': ['Floor0', 'Bed0', 'Curtain', 'Ceiling0'], 'Bed0': ['Sheet'], 'Curtain': ['Rod']},
                T0 + 1150)
            trace = scene / replay.TRACES / 'authoring_trace.author.jsonl'
            with trace.open('a') as f:
                f.write(json.dumps({'seq': 7, 't': T0 + 300, 'kind': 'tool', 'tool': 'Bash', 'hint': 'add Curtain and CurtainRail'}) + '\n')
            schedule = replay.build_schedule(scene, T0 + 1300)
            times = {r['node']: r['t'] for r in schedule['reveal']}
            self.assertEqual(set(times), {'Curtain', 'Ceiling0', 'Sheet'})  # Rod comes with Curtain
            self.assertEqual(times['Curtain'], T0 + 300)
            self.assertEqual(times['Sheet'], T0 + 610)  # never named: when the session ends
            self.assertEqual(schedule['base'], T0 + 300)
            self.assertIsNone(replay.build_schedule(scene, T0 + 1100))  # final model not there yet

    def test_parts_named_in_an_earlier_session_appear_then(self):
        with tempfile.TemporaryDirectory() as tmp:
            scene = make_run(Path(tmp) / 'run')
            glb(scene / replay.SEED, {'@roots': ['Floor0']}, T0 + 100)
            glb(scene / replay.FINAL, {'@roots': ['Floor0', 'Curtain', 'Lamp']}, T0 + 1150)
            with (scene / replay.TRACES / 'authoring_trace.author.jsonl').open('a') as f:
                f.write(json.dumps({'seq': 7, 't': T0 + 300, 'kind': 'tool', 'tool': 'Bash', 'hint': 'add Curtain'}) + '\n')
            next_session(scene, T0 + 2000, rows=[{'seq': 1, 't': T0 + 2010, 'kind': 'tool', 'tool': 'Bash', 'hint': 'add Lamp'}])
            times = {r['node']: r['t'] for r in replay.build_schedule(scene, T0 + 3000)['reveal']}
            self.assertEqual(times, {'Curtain': T0 + 300, 'Lamp': T0 + 2010})  # Curtain is named by the archived session


class Condensing(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.job = Path(self.tmp.name) / 'job'
        make_run(self.job / 'run')
        self.scene = replay.find_scene(self.job)
        self.records = replay.agent_records(self.scene)
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def fake(self, answer):
        def run(prompt):
            self.calls.append(prompt)
            return answer
        return run

    def test_condensed_lines_replace_the_rule_wording_and_are_cached(self):
        last = self.records[-1]['seq']
        answer = json.dumps([{'from': 0, 'to': 2, 'stage': 'adjust', 'kind': 'think', 'say': '先看照片，再搭初稿', 'image_seq': 3},
                             {'from': 3, 'to': last, 'stage': 'assemble', 'kind': 'result', 'say': '自评 6.5 分', 'image_seq': None}])
        summary = replay.Summary(self.job)
        self.assertTrue(summary.condense(self.records, self.fake(answer), T0, final=True))
        items = summary.data['batches'][0]['items']
        self.assertEqual([i['stage'] for i in items], ['adjust', 'adjust'])  # never steps back
        self.assertIsNone(items[0]['img'])  # the picture it named is in the next line's records
        self.assertFalse(replay.Summary(self.job).condense(self.records, self.fake(answer), T0, final=True))
        self.assertEqual(len(self.calls), 1)  # cached, not asked again
        timeline = replay.timeline(self.job, 'completed', T0 + 1300)
        lines = {e['id']: e for e in timeline['events'] if e.get('session')}
        self.assertEqual([(k, e['img'], e['session']) for k, e in lines.items()],
                         [('a0', None, 'a0'), ('a3', 'scene_init/obj_stage/traces/img/author_0004_a.jpg', 'a0')])
        says = [e['say'] for e in timeline['events']]
        self.assertIn('自评 6.5 分', says)
        self.assertFalse([e for e in timeline['events'] if e.get('rule')])

    def test_the_repair_agent_is_condensed_like_the_modelling_agent(self):
        repair = [{'seq': 1, 't': T0 + 1000, 'kind': 'session_start'},
                  {'seq': 2, 't': T0 + 1010, 'kind': 'think', 'text': 'The floor is too cold; warm it up.'},
                  {'seq': 3, 't': T0 + 1020, 'kind': 'images', 'saved': ['img/repair_0003_floor.jpg'], 'n_images': 1}]
        write(self.scene / replay.TRACES / 'authoring_trace.repair.jsonl', ''.join(json.dumps(r) + '\n' for r in repair))
        write(self.scene / replay.TRACES / 'img/repair_0003_floor.jpg')
        records = replay.agent_records(self.scene, repair=True)
        summary = replay.Summary(self.job)
        answer = json.dumps([{'from': 0, 'to': 2, 'stage': 'check', 'kind': 'tool', 'say': '把地板调暖', 'image_seq': 2}])
        self.assertTrue(summary.condense(records, self.fake(answer), T0, final=True, repair=True))
        self.assertIn('修复 agent', self.calls[0])
        self.assertEqual(summary.data['batches'], [])  # the modelling agent's numbering is left alone
        lines = [e for e in replay.timeline(self.job, 'completed', T0 + 1300)['events'] if e['id'].startswith('m')]
        self.assertEqual([(e['say'], e['stage'], e['img'], e['session']) for e in lines],
                         [('把地板调暖', 'review2', f'{replay.TRACES}/img/repair_0003_floor.jpg', 'm0')])

    def test_lines_not_yet_condensed_say_what_was_worked_on(self):
        name = replay.object_names(self.scene)
        def say(texts, repair=False):
            return replay.rule_say([{'kind': kind, 'text': text} for kind, text in texts], repair, name)
        self.assertEqual(say([('tool', 'Bash: sed -n 1,80p Objects/Procedural/Storage0/object.py'),
                              ('think', 'The floor texture repeats; the curtain is too stiff.'),
                              ('result', 'critic result: {}'), ('images', 'looked at 2 images')], repair=True),
                         '按检查意见修改柜子1、地板、材质，对照照片自查、查看画面')
        self.assertEqual(say([('tool', 'Bash: python Room.py'), ('result', 'Bash result: Traceback')]), '继续搭建房间')
        self.assertEqual(say([('think', 'Move Storage1 a little to the left.')]), '继续搭建房间，处理柜子2')

    def test_a_live_job_waits_for_a_fuller_batch(self):
        summary = replay.Summary(self.job)
        fresh = self.records[-1]['t'] + 10
        self.assertFalse(summary.condense(self.records, self.fake('[]'), T0, final=False, now=fresh))
        self.assertEqual(self.calls, [])
        timeline = replay.timeline(self.job, 'running')
        self.assertTrue(timeline['live'])
        self.assertTrue([e for e in timeline['events'] if e.get('rule')])

    def test_a_failed_call_leaves_no_cache(self):
        summary = replay.Summary(self.job)
        with self.assertRaises(ValueError):
            summary.condense(self.records, self.fake('sorry'), T0, final=True)
        self.assertFalse((self.job / 'replay' / 'summary.json').exists())

    def test_review_issues_are_condensed_once(self):
        summary = replay.Summary(self.job)
        self.assertTrue(summary.review('r0', ['The bed is too bright.'], self.fake('床面太亮')))
        self.assertFalse(summary.review('r0', ['The bed is too bright.'], self.fake('again')))
        events = replay.timeline(self.job, 'completed', T0 + 1300)['events']
        self.assertIn('检查房间没通过：床面太亮', [e['say'] for e in events])

    def test_stages_follow_the_timeline_order(self):
        events = replay.timeline(self.job, 'completed', T0 + 1300)['events']
        order = [replay.STAGE_IDS.index(e['stage']) for e in events]
        self.assertEqual(order, sorted(order))
        self.assertEqual(events[0]['minute'], 0)


class Sessions(unittest.TestCase):
    """A room built in several sessions of the modelling agent (resumed; asked for changes after it was
    published): each session is replayed in order, with the cached condensation kept where it belongs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.job = Path(self.tmp.name) / 'job'
        self.scene = make_run(self.job / 'run')
        self.first = replay.agent_records(self.scene)  # seq 0..4
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def append(self, rows):
        with (self.scene / replay.TRACES / 'trace.jsonl').open('a') as f:
            f.write(''.join(json.dumps(r) + '\n' for r in rows))

    def run_(self, stage):
        """A condensation that sums up each batch in one line."""
        def run(prompt):
            self.calls.append(prompt)
            seqs = [int(n) for n in re.findall(r'"seq": (\d+)', prompt.split('本段记录：')[1])]
            return json.dumps([{'from': seqs[0], 'to': seqs[-1], 'stage': stage, 'kind': 'tool', 'say': f'第 {len(self.calls)} 段'}])
        return run

    def test_a_later_session_is_numbered_on_from_the_earlier_ones(self):
        next_session(self.scene, T0 + 2000)
        records = replay.agent_records(self.scene)
        same = lambda r: {k: v for k, v in r.items() if k != 'key'}
        self.assertEqual([same(r) for r in records[:5]], [same(r) for r in self.first])  # the first keeps its numbers
        self.assertEqual([(r['seq'], r['session'], r['session_t']) for r in records[5:]],
                         [(5, 1, T0 + 2000), (6, 1, T0 + 2000), (7, 1, T0 + 2000)])
        self.assertEqual(len({r['key'] for r in records}), len(records))
        next_session(self.scene, T0 + 3000)
        self.assertEqual([r['seq'] for r in replay.agent_records(self.scene) if r['session'] == 2], [8, 9, 10])

    def test_a_cached_condensation_stays_with_its_session(self):
        replay.Summary(self.job).condense(self.first, self.run_('adjust'), T0, final=True)  # while it was the only one
        next_session(self.scene, T0 + 2000)
        events = replay.timeline(self.job, 'completed', T0 + 2100)['events']
        self.assertEqual([(e['id'], e['say']) for e in events if e['id'].startswith('a')],
                         [('a0', '第 1 段'), ('a6', '继续搭建房间')])
        self.assertEqual(len({e['id'] for e in events}), len(events))
        self.assertNotIn('revise', [s['id'] for s in replay.timeline(self.job)['stages']])  # not published yet
        # The next batch is the new session's, and one batch never runs into the next session.
        next_session(self.scene, T0 + 3000)
        summary = replay.Summary(self.job)
        summary.condense(replay.agent_records(self.scene), self.run_('adjust'), T0, final=True)
        self.assertEqual([(b['from'], b['to']) for b in summary.data['batches']], [(0, 4), (5, 7), (8, 10)])

    def test_an_earlier_moment_replays_as_it_did_then(self):
        before = replay.timeline(self.job, 'completed', T0 + 1300)
        next_session(self.scene, T0 + 2000)
        next_session(self.scene, T0 + 2500, 'repair')
        next_session(self.scene, T0 + 2600, 'repair')
        self.assertEqual(replay.timeline(self.job, 'completed', T0 + 1300)['events'], before['events'])

    def test_a_picture_belongs_to_the_session_that_made_it(self):
        picture = f'{replay.TRACES}/img/author_0004_a.jpg'
        next_session(self.scene, T0 + 2000, rows=[{'seq': 4, 't': T0 + 2010, 'kind': 'images', 'saved': ['img/author_0004_a.jpg']}])
        self.assertEqual([r['img'] for r in replay.agent_records(self.scene) if r['kind'] == 'images'], [picture, picture])
        os.utime(self.scene / picture, (T0 + 2010, T0 + 2010))  # the second session wrote its own over it
        self.assertEqual([r['img'] for r in replay.agent_records(self.scene) if r['kind'] == 'images'], [None, picture])

    def test_finer_stages_the_records_name_show_as_one(self):
        # an older cache names the agent's own adjusting and self-checking; they read as building the room
        self.old_cache([{'from': 0, 'to': 4, 'items': [{'from': 0, 'to': 1, 't': T0 + 600, 'stage': 'adjust', 'kind': 'tool', 'say': '调整'},
                                                       {'from': 2, 'to': 4, 't': T0 + 700, 'stage': 'check', 'kind': 'tool', 'say': '自查'}]}])
        data = replay.timeline(self.job)
        self.assertEqual({e['stage'] for e in data['events'] if e['say'] in ('调整', '自查')}, {'assemble'})
        self.assertNotIn('adjust', [s['id'] for s in data['stages']])
        self.assertNotIn('check', [s['id'] for s in data['stages']])

    def test_a_session_on_the_published_room_is_its_own_stage(self):
        self.append([
            {'t': T0 + 985, 'kind': 'review_done', 'reviewed': True, 'run': 'attempt-01', 'attempt': 'x', 'round': 0,
             'folder': 'realism_authoring/acceptance/attempt-x/round_00'},
            {'t': T0 + 990, 'kind': 'repair_start', 'run': 'attempt-01'},
            {'t': T0 + 1100, 'kind': 'repair_done', 'status': 'repaired', 'run': 'attempt-01'},
            {'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'run': 'attempt-01'},
            # asked for changes: a new author session on the published room, checked, repaired, published again
            {'t': T0 + 2100, 'kind': 'review_done', 'reviewed': True, 'run': 'attempt-02', 'attempt': 'y', 'round': 0,
             'folder': 'realism_authoring/acceptance/attempt-x/round_01'},
            {'t': T0 + 2105, 'kind': 'repair_start', 'run': 'attempt-02'},
            {'t': T0 + 2150, 'kind': 'repair_done', 'status': 'repaired', 'run': 'attempt-02'},
            {'t': T0 + 2200, 'kind': 'model_saved', 'model': 'final', 'run': 'attempt-02'},
            {'t': T0 + 2300, 'kind': 'small_objects_start', 'run': 'attempt-01'},
        ])
        next_session(self.scene, T0 + 1000, 'repair')
        replay.Summary(self.job).condense(self.first, self.run_('check'), T0, final=True)
        next_session(self.scene, T0 + 2000)
        next_session(self.scene, T0 + 2110, 'repair')
        summary = replay.Summary(self.job)
        summary.condense(replay.agent_records(self.scene), self.run_('assemble'), T0, final=True)
        self.assertFalse([p for p in self.calls if 'revise' in p or 'small_objects' in p])  # not offered to the model
        data = replay.timeline(self.job, 'completed', T0 + 2400)
        self.assertEqual([s['id'] for s in data['stages']], OLD[:-1] + ['revise', 'small_objects', 'articulate'])
        # The new session's steps (condensed as 'assemble'), its check (still round1), repair and final room.
        self.assertEqual([(e['t'] - T0, e['stage'], e['say'], e.get('model')) for e in data['events'] if e['t'] > T0 + 900], [
            (985, 'review', '检查房间没通过', 'round0'), (990, 'review2', '按检查出的问题开始修复房间', None),
            (1020, 'review2', '按检查意见修改房间', None), (1100, 'review2', '按检查出的问题修好了房间', None),
            (2020, 'revise', '第 2 段', None), (2100, 'revise', '检查房间：通过', 'round1'),
            (2105, 'revise', '按检查出的问题开始修复房间', None), (2130, 'revise', '按检查意见修改房间', None),
            (2150, 'revise', '按检查出的问题修好了房间', None), (2200, 'revise', '导出最终房间', 'final'),
            (2300, 'small_objects', '逐个看房间里的小物品，挑出需要按照片重做的', None)])
        self.assertEqual([e['id'] for e in data['events'] if e['kind'] == 'review'], ['r0', 'r1'])
        self.assertEqual(len({e['id'] for e in data['events']}), len(data['events']))
        # The first session, before the room was published, keeps its stage.
        self.assertEqual([e['stage'] for e in data['events'] if e['id'] == 'a0'], ['assemble'])  # a self-check: building


    def test_passes_before_a_revision_are_replaced(self):
        run = self.job / 'run'
        write(run / replay.SMALL_OBJECTS, t=T0 + 1270)
        write(run / replay.ARTICULATED, t=T0 + 1400)
        self.append([
            {'t': T0 + 1140, 'kind': 'model_saved', 'model': 'final', 'run': 'attempt-01'},
            {'t': T0 + 1200, 'kind': 'small_objects_start', 'run': 'attempt-01'},
            {'t': T0 + 1250, 'kind': 'small_object_done', 'name': 'TissueBox0', 'method': 'trellis', 'status': 'ok', 'run': 'attempt-01'},
            {'t': T0 + 1270, 'kind': 'model_saved', 'model': 'small_objects', 'run': 'attempt-01'},
            {'t': T0 + 1300, 'kind': 'articulate_start', 'run': 'attempt-01'},
            {'t': T0 + 1400, 'kind': 'model_saved', 'model': 'articulated', 'run': 'attempt-01'},
        ])
        next_session(self.scene, T0 + 2000)  # asked for changes after the passes
        data = replay.timeline(self.job, 'running', T0 + 2050)
        self.assertEqual([(e['t'], e['stage']) for e in data['events'] if e['t'] > T0 + 1140], [(T0 + 2020, 'revise')])
        self.assertEqual([s['id'] for s in data['stages']][-2:], ['revise', 'articulate'])
        self.assertIn('articulated', data['models'])  # the earlier rooms stay listed; their lines go
        self.append([{'t': T0 + 2300, 'kind': 'small_objects_start', 'run': 'attempt-02'},
                     {'t': T0 + 2400, 'kind': 'articulate_start', 'run': 'attempt-02'},
                     {'t': T0 + 2500, 'kind': 'model_saved', 'model': 'articulated', 'run': 'attempt-02'}])
        data = replay.timeline(self.job, 'completed', T0 + 3000)
        self.assertEqual([(e['t'], e['stage']) for e in data['events'] if e['t'] > T0 + 1140],
                         [(T0 + 2020, 'revise'), (T0 + 2300, 'small_objects'), (T0 + 2400, 'articulate'), (T0 + 2500, 'articulate')])

    def old_cache(self, batches):
        """summary.json as the code before the sessions were numbered on wrote it (no 'numbering')."""
        write(self.job / 'replay' / 'summary.json', json.dumps({'version': replay.SUMMARY_VERSION, 'batches': batches, 'reviews': {}}))

    def test_an_old_cache_across_sessions_is_renumbered_by_time(self):
        # Session 1 (seq 0..4) condensed; then session 2 counted from 0 again, condensed only past 4.
        self.old_cache([{'from': 0, 'to': 4, 'items': [{'from': 0, 'to': 4, 't': T0 + 600, 'stage': 'adjust', 'kind': 'tool', 'say': '第一段'}]}])
        next_session(self.scene, T0 + 2000, rows=[{'seq': k + 1, 't': T0 + 2000 + 10 * k, 'kind': 'think', 'text': 'x'} for k in range(8)])
        summary = replay.Summary(self.job)
        summary.data['batches'].append({'from': 5, 'to': 7, 'items': [
            {'from': 5, 'to': 7, 't': T0 + 2070, 'stage': 'check', 'kind': 'tool', 'say': '第二段'}]})
        self.old_cache(summary.data['batches'])
        events = replay.timeline(self.job, 'completed')['events']
        self.assertEqual([(e['id'], e['t'], e['say']) for e in events if e['id'].startswith('a')],
                         [('a0', T0 + 600, '第一段'), ('a10', T0 + 2070, '第二段')])  # what it left out stays out
        self.assertEqual(len({e['id'] for e in events}), len(events))
        self.assertNotIn('numbering', json.loads((self.job / 'replay' / 'summary.json').read_text()))  # read only
        summary = replay.Summary(self.job)
        self.assertTrue(summary.align(self.scene))
        self.assertEqual([(b['from'], b['to']) for b in summary.data['batches']], [(0, 4), (10, 12)])
        self.assertFalse(summary.condense(replay.agent_records(self.scene), self.run_('check'), T0, final=True))
        self.assertEqual(self.calls, [])

    def test_an_old_cache_of_the_first_session_leaves_the_later_ones_pending(self):
        self.old_cache([{'from': 0, 'to': 4, 'items': [{'from': 0, 'to': 4, 't': T0 + 600, 'stage': 'adjust', 'kind': 'tool', 'say': '第一段'}]}])
        next_session(self.scene, T0 + 2000)
        events = replay.timeline(self.job, 'completed')['events']
        self.assertEqual([(e['id'], e['say']) for e in events if e['id'].startswith('a')],
                         [('a0', '第一段'), ('a6', '继续搭建房间')])
        summary = replay.Summary(self.job)
        summary.align(self.scene)
        summary.condense(replay.agent_records(self.scene), self.run_('check'), T0, final=True)
        self.assertEqual([(b['from'], b['to']) for b in summary.data['batches']], [(0, 4), (5, 7)])

    def test_a_cache_is_renumbered_once(self):
        next_session(self.scene, T0 + 2000)
        self.old_cache([{'from': 0, 'to': 2, 'items': [{'from': 0, 'to': 2, 't': T0 + 2020, 'stage': 'check', 'kind': 'tool', 'say': '第二段'}]}])
        summary = replay.Summary(self.job)
        self.assertTrue(summary.align(self.scene))
        self.assertFalse(summary.align(self.scene))
        summary.save()
        saved = json.loads((self.job / 'replay' / 'summary.json').read_text())
        self.assertEqual((saved['numbering'], saved['batches'][0]['from'], saved['batches'][0]['items'][0]['to']), ('sessions', 5, 7))
        summary = replay.Summary(self.job)
        self.assertFalse(summary.align(self.scene))  # marked: never moved again
        self.assertEqual(summary.data['batches'][0]['from'], 5)


class WorkingClock(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.run = Path(self.tmp.name) / 'run'
        self.scene = self.run / 'pipeline' / 'demo'
        self.scene.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def attempt(self, path, begun, ended=None):
        import datetime
        started = datetime.datetime.fromtimestamp(begun, datetime.timezone.utc).isoformat(timespec='seconds')
        write(self.run / path / 'run-config.json', json.dumps({'started': started}), begun)
        if ended:
            write(self.run / path / 'exit', '0\n', ended)

    def test_pauses_and_replaced_runs_are_idle(self):
        self.attempt('attempt-01', T0, T0 + 3600)                        # the build: an hour
        self.attempt('small-objects/attempt-01', T0 + 3700, T0 + 3760)   # a pass a later one replaced: shows nothing
        self.attempt('attempt-02', T0 + 30000, T0 + 32000)               # next day, after the operator's review
        self.attempt('small-objects/attempt-02', T0 + 32100, T0 + 32200)
        spans = replay.attempt_spans(self.scene)
        self.assertEqual([(round(a), round(b)) for a, b in spans],
                         [(T0, T0 + 3600), (T0 + 3700, T0 + 3760), (T0 + 30000, T0 + 32000), (T0 + 32100, T0 + 32200)])
        shown = [{'t': t} for t in (T0, T0 + 1800, T0 + 3600, T0 + 30010, T0 + 31900, T0 + 32150)]
        idle = replay.idle_spans(shown, spans, T0)
        # between the build and the next day nothing shown was worked on (the replaced pass included);
        # the 100 s before the last pass is shorter than a pause
        self.assertEqual(idle, [[60.0, 500.0]])
        self.assertEqual(replay.idle_spans(shown, [], T0), [])  # no attempt records: real time

    def test_a_running_attempt_works_until_its_log_was_last_written(self):
        self.attempt('attempt-01', T0)
        write(self.run / 'attempt-01' / 'pipeline.log', 'still going', T0 + 900)
        self.assertEqual([(round(a), round(b)) for a, b in replay.attempt_spans(self.scene)], [(T0, T0 + 900)])


class Service(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        make_run(root / 'old-run')
        self.data = root / 'jobs'
        self.data.mkdir()
        self.jobs = service.Jobs(self.data, Path.cwd(), runner='cli')
        self.identifier = replay.register(self.data, root / 'old-run', 'demo')
        handler = type('H', (service.Handler,), {'jobs': self.jobs, 'log_message': lambda *a: None})
        self.server = service.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'http://127.0.0.1:{self.server.server_port}/room-reconstruction'

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        self.tmp.cleanup()

    def get(self, path):
        with urlopen(self.base + path, timeout=10) as response:
            return response.read()

    def test_a_registered_run_is_listed_for_replay_but_not_as_a_room(self):
        jobs = json.loads(self.get('/jobs'))['jobs']  # picked up without a restart
        self.assertEqual([j['id'] for j in jobs], [self.identifier])
        self.assertTrue(jobs[0]['replay_only'])
        self.assertNotIn('room', jobs[0])
        self.assertEqual(json.loads(self.get('/catalog'))['rooms'], [])
        data = json.loads(self.get(f'/jobs/{self.identifier}/replay'))
        self.assertFalse(data['live'])
        self.assertEqual(data['name'], 'demo')
        self.assertIn('final', data['models'])
        self.assertEqual(len(self.get(f'/jobs/{self.identifier}/replay/scaffold/points.bin')), 24)
        self.assertEqual(self.get(f'/jobs/{self.identifier}/replay/files/{replay.SEED}'), b'x')

    def test_files_outside_the_allowlist_are_refused(self):
        self.get('/jobs')
        for rel in ['scene_init/obj_stage/traces/trace.jsonl', '..%2F..%2Fjob.json', 'x/../../job.json']:
            with self.assertRaises(HTTPError) as error:
                self.get(f'/jobs/{self.identifier}/replay/files/{rel}')
            self.assertEqual(error.exception.code, 404, rel)


if __name__ == '__main__':
    unittest.main()
