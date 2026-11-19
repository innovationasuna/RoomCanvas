"""Persistent job state and queue, independent of HTTP transport."""
import fcntl
import json
import os
import queue
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path
import room_executor
import room_replay
import room_status
from room_contract import PREFIX, STAGES


class Jobs:
    def __init__(self, root, pipeline, uv='uv', timeout=21600, runner='server', python=sys.executable, *, extract):
        self.root, self.pipeline, self.uv, self.timeout = Path(root).resolve(), Path(pipeline).resolve(), uv, timeout
        self.runner, self.python, self.extract = runner, python, extract
        self.task_lock = None
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.upload_lock = threading.Lock()
        self.pending = queue.Queue()
        self.records = {}
        # One service owns the directory for as long as it runs; a second one would share its queue
        # and could clear the uploads it is unpacking. Only the owner clears a stopped one's leftovers.
        self.owner = os.open(self.root, os.O_RDONLY)
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.owner)
            raise RuntimeError(f'另一个房间重建服务正在使用 {self.root}，请先停止它或换一个数据目录。') from None
        for staged in self.root.glob('.upload-*'):
            shutil.rmtree(staged, ignore_errors=True)
        for path in sorted(self.root.glob('*/job.json')):
            record = json.loads(path.read_text())
            self.records[record['id']] = record
            if record['status'] in {'running', 'preparing'}:
                record.update(status='failed', error='服务曾重启。重试会检查上次进程是否结束，并复用已完成的阶段。')
                self.save(record)
            elif record['status'] == 'queued':
                self.pending.put(record['id'])

    def save(self, record, directory=None):
        record['updated'] = time.time()
        path = (directory or self.root / record['id']) / 'job.json'
        temp = path.with_suffix('.tmp')
        temp.write_text(json.dumps(record, ensure_ascii=False))
        temp.replace(path)

    def public(self, record):
        result = {key: record[key] for key in ('id', 'name', 'status', 'created', 'updated', 'error') if key in record}
        result['stages'] = []
        state = {}
        folder = self.root / record['id']
        try:
            output = folder / 'run/pipeline' if record.get('runner', 'cli') == 'server' else folder / 'output'
            paths = list(output.glob('*/.litereality/pipeline.json'))
            state = json.loads(paths[0].read_text()) if len(paths) == 1 else {}
            result['stages'] = [{'name': name, 'status': state.get('stages', {}).get(name, {}).get('status', 'pending')} for name in STAGES]
            if record.get('runner') == 'server':
                enhancement_status = record.get('enhancement', {}).get('status')
                result['stages'].append({'name': 'articulate', 'status': enhancement_status or
                                        ('completed' if record['status'] in {'preparing', 'completed'} else 'pending')})
        except (OSError, ValueError, KeyError):
            pass
        result.update(room_status.describe(folder, record, state))
        if result['usable']:
            result['room'] = self.room(record)
        if record.get('replay_only'):
            result['replay_only'] = True
        return result

    def load_new(self):
        """Pick up jobs registered on disk while the service runs (room_replay.py register)."""
        with self.lock:
            for path in self.root.glob('*/job.json'):
                if path.parent.name not in self.records:
                    try:
                        record = json.loads(path.read_text())
                    except (OSError, ValueError):
                        continue
                    if record.get('replay_only'):
                        self.records[record['id']] = record

    def replay_worker(self, run=None, interval=20):
        """Condense the modelling agent's log for live and finished jobs, a batch at a time."""
        run = run or room_replay.codex_runner()
        backoff = {}
        while True:
            self.load_new()
            with self.lock:
                records = [dict(r) for r in self.records.values()]
            for record in records:
                folder = self.root / record['id']
                if backoff.get(record['id'], 0) > time.time() or record['status'] == 'queued':
                    continue
                scene = room_replay.find_scene(folder)
                if not scene:
                    continue
                try:
                    until = record.get('until')
                    agent = room_replay.agent_records(scene, until)
                    summary = room_replay.Summary(folder)
                    start = min([r['t'] for r in agent] or [time.time()])
                    summary.condense(agent, run, start, final=record['status'] not in ('running', 'preparing'))
                    for event in room_replay.review_events(scene, until):
                        if event.get('issues'):
                            summary.review(event['id'], event['issues'], run)
                except Exception as error:  # a failed call keeps the rule wording; try again later
                    backoff[record['id']] = time.time() + 300
                    with (folder / 'replay-error.log').open('a') as log:
                        log.write(f'{time.ctime()} {error!r}\n')
            time.sleep(interval)

    def room(self, record):
        return {'id': 'scan-' + record['id'], 'name': record['name'],
                'dir': f'{PREFIX}/assets/{record["id"]}', 'summary': '由房间扫描重建，可进入布置。'}

    def add(self, identifier, name, archive):
        # Serialize disk-heavy extractions without holding up job status or replay queries.
        with self.upload_lock:
            with self.lock:
                if identifier in self.records:
                    return self.public(self.records[identifier])
            folder = self.root / identifier
            with tempfile.TemporaryDirectory(dir=self.root, prefix='.upload-') as temp:
                staged = Path(temp) / identifier
                capture = self.extract(archive, staged / 'capture')
                now = time.time()
                record = {'id': identifier, 'name': name, 'status': 'queued', 'created': now, 'queued_at': now,
                          'capture': str(folder / capture.relative_to(staged)), 'scan': capture.name, 'runner': self.runner}
                self.save(record, staged)
                with self.lock:
                    staged.rename(folder)
                    self.records[identifier] = record
                    initial = record.copy()
                    self.pending.put(identifier)
            return self.public(initial)

    def retry(self, identifier):
        with self.lock:
            record = self.records[identifier]
            if record['status'] != 'failed':
                raise ValueError('只有失败的任务可以重试')
            if not self.public(record)['retryable']:
                raise ValueError('请修正扫描输入或运行配置后重新提交')
            record.update(status='queued', queued_at=time.time())
            record.pop('error', None)
            record.pop('enhancement', None)
            self.save(record)
            self.pending.put(identifier)
            return self.public(record)

    def execute(self, args, log):
        return room_executor.execute(self, args, log)

    def run_one(self, identifier):
        return room_executor.run_one(self, identifier)

    def worker(self):
        while True:
            identifier = self.pending.get()
            try:
                self.run_one(identifier)
            finally:
                self.pending.task_done()

