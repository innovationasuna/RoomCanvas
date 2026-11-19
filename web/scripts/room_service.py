#!/usr/bin/env python3
"""Private room reconstruction API. Run on the machine configured for LiteReality.

python3 web/scripts/room_service.py --data-dir /path/to/roomcanvas-jobs
Only loopback is exposed; use SSH forwarding to access a remote worker.
"""
import argparse
import gzip
import json
import mimetypes
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile
import threading
import zipfile
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))
import room_replay  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'room-reconstruction/src'))
from room_contract import PREFIX, STAGES, ASSETS  # noqa: E402,F401
MAX_UPLOAD = 2 * 1024**3
MAX_EXPANDED = 8 * 1024**3
MAX_ENTRIES = 50000
ID = r'[0-9a-f]{32}'
PREVIEW = '这台服务器没有 GPU，只能浏览房间、物品和重建回放，不能提交重建。'


from room_scan import extract_scan as _extract_scan
from room_jobs import Jobs as JobStore


def extract_scan(archive, destination):
    return _extract_scan(archive, destination, max_expanded=MAX_EXPANDED, max_entries=MAX_ENTRIES)


class Jobs(JobStore):
    # Keep the script's public import stable for existing launchers and integrations.
    def __init__(self, *args, **kwargs):
        super().__init__(*args, extract=lambda archive, dest: extract_scan(archive, dest), **kwargs)


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
                                                    if self.jobs.public(r)['usable']]})
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
    try:  # Jobs refuses a data directory another service process is using.
        Handler.jobs = Jobs(args.data_dir, args.pipeline_dir, args.uv, args.timeout, args.runner, args.python)
    except RuntimeError as error:
        raise SystemExit(str(error))
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
