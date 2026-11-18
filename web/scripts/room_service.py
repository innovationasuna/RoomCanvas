#!/usr/bin/env python3
"""Private room reconstruction API. Run on the machine configured for LiteReality.

python3 web/scripts/room_service.py --data-dir /path/to/roomcanvas-jobs
Only loopback is exposed; use SSH forwarding to access a remote worker.
"""
import argparse
import fcntl
import gzip
import json
import mimetypes
import os
from pathlib import Path, PurePosixPath
import queue
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import room_replay  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
PREFIX = '/room-reconstruction'
MAX_UPLOAD = 2 * 1024**3
MAX_EXPANDED = 8 * 1024**3
MAX_ENTRIES = 50000
STAGES = ['ingest', 'reconstruct', 'seed', 'author', 'publish']
ASSETS = {'Room.glb', 'room_objects.json', 'thumbnail.jpg'}
ID = r'[0-9a-f]{32}'
PREVIEW = '这台服务器没有 GPU，只能浏览房间、物品和重建回放，不能提交重建。'


SCAN_SUFFIXES = {'.usdz', '.jpg', '.jpeg', '.png', '.json', '.mp4', '.obj', '.mtl', '.txt', '.ply', '.pcd', '.heic'}
UNSAFE = '扫描包包含不安全的路径、链接、特殊文件或加密文件'


def _scan_entries(bundle):
    """Yield bounded scan entries lazily. A directory has no opener; links and devices are refused."""
    is_zip = isinstance(bundle, zipfile.ZipFile)
    for item in bundle.infolist() if is_zip else bundle:
        if is_zip:
            if stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
                raise ValueError(UNSAFE)
            yield item.filename, item.file_size, None if item.is_dir() else lambda item=item: bundle.open(item)
        else:
            if not (item.isfile() or item.isdir()):
                raise ValueError(UNSAFE)
            yield item.name, item.size, None if item.isdir() else lambda item=item: bundle.extractfile(item)


def _open_scan(archive):
    # By the leading bytes: zipfile.is_zipfile looks for a ZIP's end record near the end of the file,
    # which a tar ending with room.usdz (itself a ZIP) also has.
    archive.seek(0)
    head = archive.read(4)
    archive.seek(0)
    if head in (b'PK\x03\x04', b'PK\x05\x06'):
        return zipfile.ZipFile(archive)
    try:
        return tarfile.open(fileobj=archive, mode='r:*')
    except tarfile.TarError:
        raise ValueError('请上传 ZIP 或 tar 格式的扫描包') from None


def extract_scan(archive, destination):
    """Extract bounded data only from a ZIP or tar; reject links, traversal, duplicates and multiple captures."""
    with _open_scan(archive) as bundle:
        names, expanded = set(), 0
        for count, (name, size, open_entry) in enumerate(_scan_entries(bundle), 1):
            expanded += size
            if count > MAX_ENTRIES or size < 0 or expanded > MAX_EXPANDED:
                raise ValueError('扫描包解压后过大（上限 8 GB / 50,000 个文件）')
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
                raise ValueError(UNSAFE)
            if open_entry is None or '__MACOSX' in path.parts or path.name.startswith('.'):
                continue
            path = PurePosixPath(*[part for part in path.parts if part != '.'])  # tar names may start with ./
            if path.suffix.lower() not in SCAN_SUFFIXES:
                raise ValueError('扫描包只能包含扫描数据，不能包含程序或其他文件')
            if str(path).casefold() in names:
                raise ValueError('扫描包包含重复文件')
            names.add(str(path).casefold())
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with open_entry() as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
    candidates = {p.parent.parent if p.parent.name == 'roomplan' else p.parent for p in destination.rglob('room.usdz')}
    if len(candidates) != 1:
        raise ValueError('请上传一个房间的完整扫描包，其中需包含 room.usdz')
    capture = candidates.pop()
    if (capture / 'scene.json').exists():
        raise ValueError('请上传原始扫描包，而不是已经生成的场景包')
    frames = list(capture.glob('frame_*.json')) + list((capture / 'images').glob('frame_*.json'))
    if not frames or not any(p.with_name(p.stem.replace('frame_', 'depth_') + '.png').is_file() for p in frames):
        raise ValueError('扫描包缺少 frame_*.json 相机数据或 depth_*.png 深度数据')
    if not (list(capture.glob('frame_*.jpg')) or list((capture / 'images').glob('frame_*.jpg')) or (capture / 'frames.mp4').is_file()):
        raise ValueError('扫描包缺少图像帧或 frames.mp4')
    return capture


class Jobs:
    def __init__(self, root, pipeline, uv='uv', timeout=21600, runner='server', python=sys.executable):
        self.root, self.pipeline, self.uv, self.timeout = Path(root).resolve(), Path(pipeline).resolve(), uv, timeout
        self.runner, self.python = runner, python
        self.task_lock = None
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.upload_lock = threading.Lock()
        self.pending = queue.Queue()
        self.records = {}
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
        try:
            folder = self.root / record['id']
            output = folder / 'run/pipeline' if record.get('runner', 'cli') == 'server' else folder / 'output'
            paths = list(output.glob('*/.litereality/pipeline.json'))
            state = json.loads(paths[0].read_text()) if len(paths) == 1 else {}
            result['stages'] = [{'name': name, 'status': state.get('stages', {}).get(name, {}).get('status', 'pending')} for name in STAGES]
            if record.get('runner') == 'server':
                result['stages'].append({'name': 'articulate', 'status': 'completed' if record['status'] in {'preparing', 'completed'} else 'pending'})
        except (OSError, ValueError, KeyError):
            pass
        if record['status'] == 'completed' and not record.get('replay_only'):
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
            with tempfile.TemporaryDirectory(dir=self.root) as temp:
                staged = Path(temp) / identifier
                capture = extract_scan(archive, staged / 'capture')
                record = {'id': identifier, 'name': name, 'status': 'queued', 'created': time.time(),
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
            record.update(status='queued')
            record.pop('error', None)
            self.save(record)
            self.pending.put(identifier)
            return self.public(record)

    def execute(self, args, log):
        process = subprocess.Popen(args, cwd=self.pipeline, stdout=log, stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL, start_new_session=True,
                                   pass_fds=(self.task_lock.fileno(),) if self.task_lock else ())
        try:
            code = process.wait(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise RuntimeError('任务超过运行时限，请检查服务器日志后重试。')
        if code:
            raise RuntimeError(f'重建程序退出（代码 {code}）。请检查服务器 task.log、模型配置和扫描数据后重试。')

    def run_one(self, identifier):
        record = self.records[identifier]
        folder = self.root / identifier
        guard = (folder / 'task.lock').open('a')
        try:
            try:
                fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('上一次重建进程仍在运行，请等它结束后重试。')
            self.task_lock = guard
            with self.lock:
                record.update(status='running')
                self.save(record)
            with (folder / 'task.log').open('ab') as log:
                if record.get('runner', 'cli') == 'server':
                    # Retain this project's runtime configuration, GPU selection/lock and articulation pass.
                    self.execute([self.python, str(self.pipeline / 'server/run_room.py'), record['capture'],
                                  str(folder / 'run'), '--through', 'publish'], log)
                    attempts = sorted((folder / 'run').glob('attempt-*'))
                    if not attempts or any(not (attempts[-1] / name).is_file() or (attempts[-1] / name).read_text().strip() != '0'
                                           for name in ('exit', 'articulate-exit')):
                        raise RuntimeError('房间重建或可动部件生成失败，请检查运行目录的 pipeline.log 和 articulate.log 后重试。')
                    preview = folder / 'run/articulate/room_preview'
                else:
                    self.execute([self.uv, 'run', '--no-sync', 'litereality', 'run', record['capture'],
                                  '--output-root', str(folder / 'output'), '--through', 'publish'], log)
                    previews = list((folder / 'output').glob('*/realism_authoring/room_preview'))
                    if len(previews) != 1:
                        raise RuntimeError('未找到唯一的房间重建结果，请检查服务器日志。')
                    preview = previews[0]
                if not (preview / 'Room.glb').is_file() or not (preview / 'room_layout.json').is_file():
                    raise RuntimeError('重建结束但缺少完整房间模型或布局，尚不能进入布置。')
                with self.lock:
                    record.update(status='preparing')
                    self.save(record)
                self.execute([sys.executable, str(ROOT / 'web/scripts/room_objects.py'), str(preview)], log)
                published = folder / 'assets'
                published.mkdir(exist_ok=True)
                for name in ASSETS:
                    if (preview / name).is_file():
                        shutil.copy2(preview / name, published / name)
            with self.lock:
                record.update(status='completed')
                self.save(record)
        except Exception as error:
            with self.lock:
                record.update(status='failed', error=str(error) if isinstance(error, RuntimeError) else '无法运行重建程序，请检查服务器环境及 task.log。')
                self.save(record)
        finally:
            self.task_lock = None
            guard.close()

    def worker(self):
        while True:
            identifier = self.pending.get()
            try:
                self.run_one(identifier)
            finally:
                self.pending.task_done()


class Handler(BaseHTTPRequestHandler):
    jobs = None
    preview = False  # no GPU: browse only

    def respond(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        replay = None
        if path == PREFIX + '/jobs':
            self.jobs.load_new()
        with self.jobs.lock:
            if path == PREFIX + '/health':
                return self.respond(200, {'ok': True, 'max_upload': MAX_UPLOAD, 'preview': self.preview})
            if path == PREFIX + '/jobs':
                records = sorted(self.jobs.records.values(), key=lambda r: r['created'], reverse=True)
                return self.respond(200, {'jobs': [self.jobs.public(r) for r in records]})
            if path == PREFIX + '/catalog':
                return self.respond(200, {'rooms': [self.jobs.room(r) for r in self.jobs.records.values()
                                                    if r['status'] == 'completed' and not r.get('replay_only')]})
            match = re.fullmatch(PREFIX + rf'/jobs/({ID})', path)
            if match and match[1] in self.jobs.records:
                return self.respond(200, self.jobs.public(self.jobs.records[match[1]]))
            # Replay: the timeline, the 3D scaffold, and allowlisted models / pictures of a job's run.
            match = re.fullmatch(PREFIX + rf'/jobs/({ID})/replay(?:/(scaffold/(?:points\.bin|layout\.json|colors\.bin)|files/(.+)))?', path)
            if match and match[1] in self.jobs.records:
                record = self.jobs.records[match[1]]
                replay = (self.jobs.root / match[1], record['status'], record.get('until'), match[2], match[3], record.get('name'))
            else:
                match = re.fullmatch(PREFIX + rf'/assets/({ID})/([^/]+)', path)
                if not match or match[2] not in ASSETS or self.jobs.records.get(match[1], {}).get('status') != 'completed':
                    return self.respond(404, {'error': '没有找到该任务或资源'})
                asset = self.jobs.root / match[1] / 'assets' / match[2]
        if replay:
            folder, status, until, part, rel, name = replay
            if not part:
                data = room_replay.timeline(folder, status, until)
                data['name'] = name
                return self.respond(200, data)
            if part.startswith('scaffold/'):
                if part == 'scaffold/colors.bin':
                    asset = room_replay.scaffold_colors(folder)
                else:
                    files = room_replay.scaffold(folder)
                    asset = dict(zip(('points.bin', 'layout.json'), files)).get(part.split('/')[1]) if files else None
            else:
                scene = room_replay.find_scene(folder)
                asset = room_replay.scene_file(scene, unquote(rel)) if scene else None
            if not asset:
                return self.respond(404, {'error': '没有找到该任务或资源'})
            return self.send_file(asset, cache=status == 'completed')
        if not asset.is_file():
            return self.respond(404, {'error': '该资源尚未生成'})
        self.send_file(asset)

    def send_file(self, asset, cache=False):
        self.send_response(200)
        self.send_header('Content-Type', mimetypes.guess_type(asset.name)[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(asset.stat().st_size))
        if cache:  # finished runs do not change; live ones may rewrite a model
            self.send_header('Cache-Control', 'max-age=3600')
        self.end_headers()
        with asset.open('rb') as source:
            shutil.copyfileobj(source, self.wfile)

    def do_POST(self):
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.respond(403, {'error': '不允许跨站提交'})
        path = urlsplit(self.path).path
        if self.preview:
            return self.respond(503, {'error': PREVIEW})
        match = re.fullmatch(PREFIX + rf'/jobs/({ID})/retry', path)
        if match:
            try:
                return self.respond(202, self.jobs.retry(match[1]))
            except (ValueError, KeyError):
                return self.respond(409, {'error': '任务不存在或当前不能重试'})
        if path != PREFIX + '/jobs':
            return self.respond(404, {'error': '接口不存在'})
        identifier = self.headers.get('X-Upload-ID', '')
        name = unquote(self.headers.get('X-Room-Name', '')).strip()
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not re.fullmatch(ID, identifier) or not name or len(name) > 80:
            return self.respond(400, {'error': '请填写房间名称（最多 80 个字符）'})
        if not 0 < length <= MAX_UPLOAD:
            return self.respond(413, {'error': '扫描包需在 2 GB 以内且不能为空'})
        # Spool in chunks instead of retaining a multi-gigabyte scan in memory.
        try:
            self.connection.settimeout(120)
            with tempfile.TemporaryFile() as archive:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('上传中断，请重新提交')
                    archive.write(chunk)
                    remaining -= len(chunk)
                archive.seek(0)
                result = self.jobs.add(identifier, name, archive)
            self.respond(202, result)
        except (tarfile.TarError, EOFError, gzip.BadGzipFile, zlib.error):
            self.respond(400, {'error': '扫描包已损坏或不完整，请重新导出后上传'})
        except (ValueError, zipfile.BadZipFile, NotImplementedError) as error:
            self.respond(400, {'error': str(error)})
        except (OSError, RuntimeError):
            self.respond(500, {'error': '扫描包未保存，请检查服务器磁盘和文件权限后重试'})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=7866)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--pipeline-dir', type=Path, default=ROOT / 'room-reconstruction')
    parser.add_argument('--uv', default='uv')
    parser.add_argument('--runner', choices=('server', 'cli'), default='server', help='server: existing GPU launcher; cli: generic uv installation')
    parser.add_argument('--python', default=sys.executable, help='Python for the existing server/run_room.py launcher')
    parser.add_argument('--timeout', type=int, default=21600)
    parser.add_argument('--preview', action='store_true', help='no GPU: serve rooms, assets and replays, refuse new reconstructions')
    parser.add_argument('--no-replay-summary', action='store_true', help='do not condense agent logs with codex (rule wording only)')
    args = parser.parse_args()
    args.data_dir.mkdir(parents=True, exist_ok=True)
    # Prevent two service processes from sharing this job store / queue.
    lockfile = (args.data_dir / '.service.lock').open('w')
    fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
    Handler.jobs = Jobs(args.data_dir, args.pipeline_dir, args.uv, args.timeout, args.runner, args.python)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    Handler.preview = args.preview
    if not args.preview:
        threading.Thread(target=Handler.jobs.worker, daemon=True).start()
    if not args.no_replay_summary:
        threading.Thread(target=Handler.jobs.replay_worker, daemon=True).start()
    print(f'Room reconstruction API: http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
