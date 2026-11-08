"""Reconstruction replay: run directory -> timeline, condensation cache, file allowlist, service routes.
Synthetic runs only; no GPU, model or codex calls."""
import json
import os
from pathlib import Path
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
        self.assertEqual(reviews[0]['say'], '第 1 轮验收 4.0 分，没通过')
        self.assertTrue(reviews[1]['passed'])
        self.assertEqual([e['issues'] for e in reviews], [['The bed is too bright.'], ['The curtains are too stiff.']])
        self.assertEqual(list(replay.models(self.scene, self.until)), ['seed', 'round0', 'round1', 'final'])

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
        dest = self.root / 'slim'
        replay.slim(self.root / 'run', dest)
        self.assertFalse((dest / 'pipeline' / 'demo' / bulk).exists())

        def replayed(run):
            job = self.root / ('job-' + run.name)
            (job / 'run').mkdir(parents=True)
            (job / 'run' / 'pipeline').symlink_to(run / 'pipeline')
            return replay.timeline(job), replay.scaffold(job)
        (a, (pa, la)), (b, (pb, lb)) = replayed(self.root / 'run'), replayed(dest)
        self.assertEqual(a, b)
        self.assertEqual((pa.read_bytes(), la.read_text()), (pb.read_bytes(), lb.read_text()))

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
        self.assertEqual(items[0]['img'], 'scene_init/obj_stage/traces/img/author_0004_a.jpg')
        self.assertFalse(replay.Summary(self.job).condense(self.records, self.fake(answer), T0, final=True))
        self.assertEqual(len(self.calls), 1)  # cached, not asked again
        timeline = replay.timeline(self.job, 'completed', T0 + 1300)
        says = [e['say'] for e in timeline['events']]
        self.assertIn('自评 6.5 分', says)
        self.assertFalse(any(s.startswith('建模 agent 继续工作') for s in says))

    def test_a_live_job_waits_for_a_fuller_batch(self):
        summary = replay.Summary(self.job)
        fresh = self.records[-1]['t'] + 10
        self.assertFalse(summary.condense(self.records, self.fake('[]'), T0, final=False, now=fresh))
        self.assertEqual(self.calls, [])
        timeline = replay.timeline(self.job, 'running')
        self.assertTrue(timeline['live'])
        self.assertTrue(any(e['say'].startswith('建模 agent 继续工作') for e in timeline['events']))

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
        self.assertIn('第 1 轮验收 4.0 分，没通过：床面太亮', [e['say'] for e in events])

    def test_stages_follow_the_timeline_order(self):
        events = replay.timeline(self.job, 'completed', T0 + 1300)['events']
        order = [replay.STAGE_IDS.index(e['stage']) for e in events]
        self.assertEqual(order, sorted(order))
        self.assertEqual(events[0]['minute'], 0)


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
