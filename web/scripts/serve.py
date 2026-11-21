#!/usr/bin/env python3
"""Serve the repository for the editor, and pass ViewForge's object APIs through from the same origin.

python3 web/scripts/serve.py --ssh <host>                           # page + one tunnel to gateway.py (127.0.0.1:7870 on <host>)
python3 web/scripts/serve.py --ssh <host> --server-dir <repo on host> # also start the services there (scripts/start_server.sh)
python3 web/scripts/serve.py --ssh <host> --cpa                     # also lend <host> this computer's CLIProxyAPI (127.0.0.1:8317)
python3 web/scripts/serve.py --ssh <host> --remote <address>:7862   # page + separate tunnels to the object and room services
python3 web/scripts/serve.py                                         # page only: local rooms and the cached ones
python3 web/scripts/serve.py --viewforge http://127.0.0.1:7865

The editor reads ViewForge's objects at /viewforge/assets/catalog and /viewforge/assets/<run>/...,
and "添加物品" uploads photos and follows the reconstruction at /viewforge/objects/... and saves the
measured size at /viewforge/dimensions/<run>; those requests go to the ViewForge server. "重建房间" uploads
a scan and follows the job at /room-reconstruction/..., which goes to the room reconstruction API. With --ssh,
this script opens one SSH connection forwarding both (local ports taken from --viewforge and --room-backend),
reopens it whenever it drops, and closes it on exit. --cpa also forwards 127.0.0.1:8317 on <host> back to this
computer, so the server's Codex can use the CLIProxyAPI (the user's own subscription) running here.
--server-dir runs scripts/start_server.sh in that directory on <host> over the same connection (it leaves running
services alone), so one password starts everything.
Finished rooms and replays are kept under runs/room-cache/ and read from there (room_cache.py); with --ssh the
missing ones download in the background. Without the server the cached ones still open.
The sample rooms' models (samples/*/Room.glb) are release assets, not files in git: the missing ones are fetched
in the background at start-up (scripts/fetch_samples.py) while the page already works, before the rooms and
replays (GitHub is usually faster than the tunnel). A file whose content is already here (a sample room that is
also a finished job's room, a replay's last version that is also the room) is linked, not downloaded again.
Missing samples are also fetched from the room service when opened, even with --no-download.
Only the requested model is fetched, verified against samples/models.json, and kept beside its metadata.
Nothing else is forwarded, POSTs only from this page, and the server only listens on this computer.
"""
import argparse
from contextlib import nullcontext
import http.client
import json
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

sys.path[:0] = [str(Path(__file__).resolve().parent), str(Path(__file__).resolve().parents[2] / 'scripts')]
import fetch_samples  # noqa: E402
import room_cache  # noqa: E402
from cache_manage import CacheBusy, CacheManager  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
NAME = r'[\w.-]+'
# The reads the editor makes: catalog, assets/<run>[/result.glb|preview.glb], a job, a mask preview.
READS = re.compile(rf'^/viewforge/(assets/(catalog|{NAME}(/((result|preview|collision)\.glb|result\.ply|preview\.json))?)'
                   rf'|layouts/(catalog|assets/{NAME}(/((result|preview)\.glb|result\.ply|preview\.json))?)'
                   rf'|objects/(jobs/[0-9a-f]{{32}}|previews/\w+/{NAME}\.png))$')
# Its writes: new object with photos, more photos for a finished one (补拍), masks, reconstruction, measured size.
WRITES = re.compile(rf'^/viewforge/(objects/(create|capture|masks|reconstruct)|dimensions/{NAME})$')
MAX_BODY = 400 * 1024 * 1024
# Reads for the room service: health, catalog, jobs, a finished room's files, and a job's replay
# (timeline, 3D scaffold, and the models / pictures the service itself allowlists under files/).
ROOM_READS = re.compile(r'^/room-reconstruction/(health|catalog|jobs(/[0-9a-f]{32}(/replay(/scaffold/(points\.bin|layout\.json|colors\.bin)|/files/[\w./-]+)?)?)?'
                        r'|assets/[0-9a-f]{32}/(Room\.glb|room_objects\.json|thumbnail\.jpg))$')
ROOM_WRITES = re.compile(r'^/room-reconstruction/jobs(/[0-9a-f]{32}/retry)?$')
MAX_SCAN = 2 * 1024**3


def room_forwarded(path, method='GET'):
    path = urlsplit(path).path
    if '..' in path:
        return None
    return path if (ROOM_READS if method == 'GET' else ROOM_WRITES).fullmatch(path) else None


def forwarded(path, method='GET'):
    """The ViewForge path to request for an editor path, or None if it is not forwarded."""
    path = unquote(path.split('?', 1)[0])
    if '..' in path or not (READS if method == 'GET' else WRITES).match(path):
        return None
    return quote(path)


class RoomDeletions:
    """Persist list removals without erasing scans or cancelling worker processes."""
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()

    def read(self):
        if not self.path.exists():
            return set()
        return set(json.loads(self.path.read_text()))

    def remove(self, identifier):
        self.update(identifier, removed=True)

    def restore(self, identifier):
        self.update(identifier, removed=False)

    def update(self, identifier, removed):
        with self.lock:
            deleted = self.read()
            if removed:
                deleted.add(identifier)
            else:
                deleted.discard(identifier)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix('.tmp')
            temporary.write_text(json.dumps(sorted(deleted)))
            temporary.replace(self.path)


class Handler(SimpleHTTPRequestHandler):
    viewforge = 'http://127.0.0.1:7865'
    room_backend = 'http://127.0.0.1:7866'
    deletions = RoomDeletions(ROOT / '.roomcanvas/deleted-rooms.json')
    cache = ROOT / 'runs/room-cache'
    sample_locks = {}
    sample_locks_guard = threading.Lock()

    def cache_control(self):
        return CacheManager(ROOT, self.cache)

    def cache_clear(self):
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        if (urlsplit('//' + host).hostname not in {'127.0.0.1', 'localhost', '::1'}
                or (origin and urlsplit(origin).netloc != host)
                or self.headers.get('Sec-Fetch-Site') == 'cross-site'):
            return self.room_json(403, {'error': '不允许跨站清理本地缓存。'})
        if self.headers.get_content_type() != 'application/json':
            return self.room_json(415, {'error': '请使用 JSON 提交清理请求。'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                raise ValueError('清理请求大小无效。')
            self.connection.settimeout(15)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict) or set(data) - {'ids', 'all'}:
                raise ValueError('清理请求格式无效。')
            result = self.cache_control().clear(data.get('ids'), all=data.get('all', False))
        except CacheBusy as error:
            return self.room_json(409, {'error': str(error)})
        except (ValueError, UnicodeError) as error:
            return self.room_json(400, {'error': str(error)})
        except OSError:
            return self.room_json(500, {'error': '无法清理缓存，请检查本地文件权限后重试。'})
        return self.room_json(200, result)

    def missing_sample(self, path):
        """Only manifest-listed models may trigger an on-demand download."""
        if not path.startswith('/samples/') or not path.endswith('/Room.glb'):
            return None
        _, models = fetch_samples.load(ROOT)
        entry = next((entry for entry in models if path == '/' + entry['path']), None)
        if entry is None or (ROOT / entry['path']).is_file():
            return None
        rooms = json.loads((ROOT / 'web/rooms.json').read_text())['rooms']
        for room in rooms:
            if room.get('dir') == '../' + str(Path(entry['path']).parent) and re.fullmatch(r'[0-9a-f]{32}', room.get('scan', '')):
                return entry, room['scan']
        return entry, None

    def sample_get(self, entry, scan):
        """Fetch one pinned model on GET, never on HEAD; publish only a complete, matching file."""
        target = ROOT / entry['path']
        with self.sample_locks_guard:
            lock = self.sample_locks.setdefault(target, threading.Lock())
        with self.cache_control().download(), lock:
            if not target.is_file():
                part = None
                failure = None
                try:
                    same = fetch_samples.same_file([self.cache], entry['bytes'], entry['sha256'])
                    if same:
                        fetch_samples.place(same, target)
                        self.log_message('房间模型：本机已有相同文件，已复用 %s', entry['path'])
                        return self.send_kept(target)
                    self.log_message('房间模型：按需下载 %s（%.1f MB）', entry['path'], entry['bytes'] / 1e6)
                    resource = f'assets/{scan}' if scan else f'samples/{fetch_samples.room(entry)}'
                    source = f'{self.room_backend}/room-reconstruction/{resource}/Room.glb'
                    with urllib.request.urlopen(source, timeout=120) as response:
                        size = response.headers.get('Content-Length')
                        if size is not None and int(size) != entry['bytes']:
                            raise ValueError('服务器模型版本与本地房间清单不匹配，请更新房间资源后重试')
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.Room-', suffix='.part', delete=False) as output:
                            part = Path(output.name)
                            received, reported = 0, 0
                            while chunk := response.read(1024 * 1024):
                                received += len(chunk)
                                if received > entry['bytes']:
                                    raise ValueError('服务器模型大小与本地房间清单不匹配')
                                output.write(chunk)
                                if received - reported >= 16 * 1024 * 1024:
                                    self.log_message('房间模型：%s %.1f / %.1f MB', entry['path'], received / 1e6, entry['bytes'] / 1e6)
                                    reported = received
                    if fetch_samples.problem(part, entry):
                        raise ValueError('房间模型不完整或版本不匹配，未保存；请检查服务连接及房间资源后重试')
                    # A concurrent startup fetch may already have supplied the model.
                    if not target.exists():
                        part.replace(target)
                    self.log_message('房间模型：已缓存 %s', entry['path'])
                except (OSError, http.client.HTTPException) as error:
                    self.log_message('房间模型：下载失败 %s (%s)', entry['path'], error)
                    failure = (503, {'error': '无法从服务器获取房间模型，请检查 SSH 连接和房间服务后刷新重试。'})
                except ValueError as error:
                    failure = (502, {'error': str(error)})
                finally:
                    if part:
                        part.unlink(missing_ok=True)
                if failure and failure[0] == 503 and not scan:
                    # Unlinked samples also work without a room server when GitHub is configured.
                    ways = fetch_samples.methods()
                    if ways:
                        try:
                            repo, _ = fetch_samples.load(ROOT)
                            self.log_message('房间模型：从 GitHub 按需下载 %s', entry['path'])
                            fetch_samples.fetch_one(repo, entry, ROOT, ways, missing_only=True)
                            failure = None
                        except (fetch_samples.FetchError, OSError, http.client.HTTPException):
                            failure = (503, {'error': '房间服务和 GitHub 均未能提供该模型，请检查连接后刷新重试。'})
                    else:
                        failure = (503, {'error': '无法获取该示例模型。请连接已更新且备有该模型的房间服务，或配置 GitHub 登录（gh auth login / GH_TOKEN）后重启网页服务。刷新只会重试当前房间。'})
                # Complete cleanup before the browser receives an error and can retry.
                if failure:
                    return self.room_json(*failure)
        return self.send_kept(target)

    def room_json(self, status, data, stale=False):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        if stale:
            self.send_header('X-RoomCanvas-Cache', 'stale')
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Files are revalidated (304 if unchanged): a replaced Room.glb must not come from the cache.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/web/cache':
            try:
                return self.room_json(200, self.cache_control().inventory())
            except (OSError, ValueError):
                return self.room_json(500, {'error': '无法读取本地缓存，请检查文件权限后重试。'})
        sample = self.missing_sample(path)
        if sample:
            return self.sample_get(*sample)
        if path in {'/web/rooms.json', '/web/rooms/trash'}:
            data = json.loads((ROOT / 'web/rooms.json').read_text())
            status, body, _, stale = self.room_answer('/room-reconstruction/catalog', 2)
            try:
                data['rooms'].extend(json.loads(body)['rooms'] if status == 200 else [])
            except (ValueError, KeyError):
                pass  # Existing rooms remain usable while the reconstruction worker is offline.
            try:
                deleted = self.deletions.read()
            except (OSError, ValueError):
                return self.room_json(500, {'error': '无法读取房间删除记录'})
            if path == '/web/rooms/trash':
                known = {room['id']: room for room in data['rooms']}
                # Running/failed scans are jobs rather than published catalog rooms.
                if any(identifier.startswith('scan-') and identifier not in known for identifier in deleted):
                    try:
                        with urllib.request.urlopen(self.room_backend + '/room-reconstruction/jobs', timeout=2) as response:
                            for job in json.load(response)['jobs']:
                                known.setdefault('scan-' + job['id'], {
                                    'id': 'scan-' + job['id'], 'name': job['name'], 'status': job['status'],
                                    'summary': '重建任务仍保留，恢复后可继续查看。',
                                })
                    except (OSError, ValueError, KeyError):
                        pass
                rooms = [known.get(identifier, {
                    'id': identifier, 'name': '扫描房间' if identifier.startswith('scan-') else identifier,
                    'summary': '暂时无法读取房间详情。恢复后，连接原服务即可查看。',
                }) for identifier in sorted(deleted)]
                return self.room_json(200, {'rooms': rooms}, stale=stale)
            data['rooms'] = [room for room in data['rooms'] if room['id'] not in deleted]
            data['deleted'] = sorted(deleted)
            return self.room_json(200, data, stale=stale)
        room_target = room_forwarded(self.path)
        if room_target:
            return self.room_get(room_target)
        target = forwarded(self.path)
        if target is None:
            return super().do_GET()
        self.relay(urllib.request.Request(self.viewforge + target), 60)

    def do_DELETE(self):
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.room_json(403, {'error': '不允许跨站删除'})
        match = re.fullmatch(r'/web/rooms/([A-Za-z0-9_-]{1,100})', urlsplit(self.path).path)
        if not match:
            return self.room_json(404, {'error': '房间地址无效'})
        try:
            self.deletions.remove(match[1])
        except (OSError, ValueError):
            return self.room_json(500, {'error': '删除未保存，请检查网页服务的写入权限后重试。'})
        return self.room_json(200, {'deleted': match[1]})

    def do_HEAD(self):
        sample = self.missing_sample(urlsplit(self.path).path)
        if sample:
            # The editor probes a model before GET. Metadata must not start a large transfer.
            self.send_response(200)
            self.send_header('Content-Type', 'model/gltf-binary')
            self.send_header('Content-Length', str(sample[0]['bytes']))
            self.end_headers()
            return
        target = room_forwarded(self.path)
        kept = target and room_cache.is_file(target) and room_cache.local(self.cache, target)
        if kept and kept.is_file():
            return self.send_kept(kept, head=True)
        return super().do_HEAD()

    def room_get(self, path):
        """A finished job's file from the local copy when there is one; JSON answers live, else the kept one."""
        kept = room_cache.local(self.cache, path)
        if kept and room_cache.is_file(path) and kept.is_file():
            return self.send_kept(kept)
        if kept is None or room_cache.is_file(path):
            # 60 s like ViewForge reads: room models are tens of MB and the tunnel can be slow.
            return self.relay(urllib.request.Request(self.room_backend + path), 60, room=True)
        status, body, kind, stale = self.room_answer(path, 8 if kept.is_file() else 60)
        if status is None:
            return self.room_json(503, {'error': '房间重建服务未连接，请启动服务并检查 SSH 隧道后重试。'})
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        if stale:
            self.send_header('X-RoomCanvas-Cache', 'stale')
        self.end_headers()
        self.wfile.write(body)

    def room_answer(self, path, timeout):
        """Return status, bytes, content type and whether a temporary outage required the saved answer."""
        kept = room_cache.local(self.cache, path)
        with self.cache_control().download(), room_cache.answer_writer(kept) as publish:
            try:
                with urllib.request.urlopen(self.room_backend + path, timeout=timeout) as response:
                    body, status, kind = response.read(), response.status, response.headers.get('Content-Type', 'application/json')
            except urllib.error.HTTPError as error:
                with error:
                    failure = error.code, error.read(), error.headers.get('Content-Type', 'application/json'), False
                if error.code not in (502, 503, 504):
                    return failure
            except (OSError, http.client.IncompleteRead):
                failure = None, b'', '', False
            else:
                if status == 200 and kept:
                    publish(body)
                return status, body, kind, False
            if kept:
                try:
                    return 200, kept.read_bytes(), 'application/json; charset=utf-8', True
                except FileNotFoundError:
                    pass
            return failure

    def send_kept(self, path, head=False):
        with self.cache_control().download():
            try:
                source = path.open('rb')
            except FileNotFoundError:
                return self.room_json(404, {'error': '本地缓存已清理，请刷新后重新加载。'})
            with source:
                self.send_response(200)
                self.send_header('Content-Type', room_cache.content_type(path))
                self.send_header('Content-Length', str(path.stat().st_size))
                self.send_header('Last-Modified', self.date_time_string(path.stat().st_mtime))
                self.end_headers()
                if not head:
                    shutil.copyfileobj(source, self.wfile)

    def do_POST(self):
        if urlsplit(self.path).path == '/web/cache/clear':
            return self.cache_clear()
        restore = re.fullmatch(r'/web/rooms/([A-Za-z0-9_-]{1,100})/restore', urlsplit(self.path).path)
        if restore:
            origin = self.headers.get('Origin')
            if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                return self.room_json(403, {'error': '不允许跨站恢复'})
            try:
                self.deletions.restore(restore[1])
            except (OSError, ValueError):
                return self.room_json(500, {'error': '恢复未保存，请检查网页服务的写入权限后重试。'})
            return self.room_json(200, {'restored': restore[1]})
        room_target = room_forwarded(self.path, 'POST')
        if room_target:
            return self.room_post(room_target)
        target = forwarded(self.path, 'POST')
        origin = self.headers.get('Origin')
        length = int(self.headers.get('Content-Length') or 0)
        if target is None or (origin and urlsplit(origin).netloc != self.headers.get('Host')):
            return self.send_error(403)
        if length > MAX_BODY:
            return self.send_error(413)
        body = self.rfile.read(length)
        headers = {'Content-Type': self.headers.get('Content-Type', '')}
        self.relay(urllib.request.Request(self.viewforge + target, data=body, headers=headers, method='POST'), 300)

    def room_post(self, target):
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            return self.room_json(403, {'error': '不允许跨站提交'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return self.room_json(400, {'error': '上传长度无效'})
        if length < 0 or length > MAX_SCAN:
            return self.room_json(413, {'error': '扫描包不能超过 2 GB'})
        headers = {key: self.headers[key] for key in ('Content-Type', 'X-Room-Name', 'X-Upload-ID') if key in self.headers}
        headers['Content-Length'] = str(length)
        self.connection.settimeout(120)
        with tempfile.TemporaryFile() as body:
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    return self.room_json(400, {'error': '上传中断'})
                body.write(chunk)
                remaining -= len(chunk)
            body.seek(0)
            request = urllib.request.Request(self.room_backend + target,
                data=iter(lambda: body.read(1024 * 1024), b''), headers=headers, method='POST')
            return self.relay(request, 300, room=True)

    def relay(self, request, timeout, room=False):
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error  # ViewForge's own error message (JSON) goes to the page as it is.
        except OSError as error:  # refused, timed out, or reset by an SSH tunnel whose remote side is down
            if room:
                return self.room_json(503, {'error': '房间重建服务未连接，请启动服务并检查 SSH 隧道后重试。'})
            return self.send_error(502, f'ViewForge not reachable at {self.viewforge} ({error})')
        with response:
            self.send_response(response.status)
            for name in ('Content-Type', 'Content-Length'):
                if response.headers.get(name):
                    self.send_header(name, response.headers[name])
            self.end_headers()
            shutil.copyfileobj(response, self.wfile)


def tunnel_command(host, forwards, reverse=(), server_dir=None):
    """The ssh command that forwards each 127.0.0.1:<local_port> to <remote> as seen from <host>, and each
    port in `reverse` on <host>'s 127.0.0.1 back to the same port on this computer. With `server_dir` it also
    starts the services there, then stays connected until this script closes its input."""
    # ControlPath=none: with ControlMaster in ~/.ssh/config a second ssh hands the forwards to the master and
    # exits, leaving the ports open after this script stops.
    command = ['ssh'] + ([] if server_dir else ['-N'])
    command += ['-o', 'ControlPath=none', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15']
    for local_port, remote in forwards:
        if not re.fullmatch(r'[\w.-]+:\d+', remote):
            raise ValueError(f'remote must be <address>:<port>, got {remote!r}')
        command += ['-L', f'127.0.0.1:{local_port}:{remote}']
    for port in reverse:
        command += ['-R', f'127.0.0.1:{port}:127.0.0.1:{port}']
    if server_dir:  # `cat` ends when the connection or this script ends, so nothing stays behind on the server
        return command + [host, f'cd {shlex.quote(server_dir)} && bash scripts/start_server.sh; exec cat > /dev/null']
    return command + [host]


def spawn(command):
    # The input is a pipe, not the terminal: a remote `cat` must not read what is typed here (the password
    # prompt reads the terminal itself).
    return subprocess.Popen(command, stdin=subprocess.PIPE)


def open_tunnel(command, ports, wait=30):
    """Start ssh and return it once every local port accepts connections; exit with a message if ssh stops."""
    for port in ports:
        try:
            socket.create_connection(('127.0.0.1', port), timeout=1).close()
        except OSError:
            continue
        # something already answers there, e.g. a tunnel opened by hand: it would look like ours
        sys.exit(f'Port {port} is already in use (a tunnel already open?). Close it, or run without --ssh.')
    process = spawn(command)
    waiting = list(ports)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if process.poll() is not None:
            sys.exit(f'SSH tunnel failed (exit {process.returncode}). Is a port in {ports} already in use, '
                     f'or the host unreachable? Command: {" ".join(command)}')
        try:
            socket.create_connection(('127.0.0.1', waiting[0]), timeout=1).close()
            waiting.pop(0)
            if not waiting:
                return process
        except OSError:
            time.sleep(0.3)
    process.terminate()
    sys.exit(f'SSH tunnel did not open ports {waiting} within {wait} s')


class Tunnel:
    """The open ssh process, started again whenever it exits: cloud gateways (AutoDL) drop long connections."""

    def __init__(self, command, process, check=2.0):
        self.command, self.process, self.check = command, process, check
        self.stopped = threading.Event()
        threading.Thread(target=self.watch, daemon=True).start()

    def watch(self):
        failures = 0
        while not self.stopped.wait(self.check):
            if self.process.poll() is None:
                failures = 0
                continue
            failures += 1
            print(f'SSH tunnel closed (exit {self.process.returncode}); reconnecting…', flush=True)
            if self.stopped.wait(min(3 * failures, 30)):
                return
            self.process = spawn(self.command)

    def close(self):
        self.stopped.set()
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()


def fetch_sample_models(download=True, log=print, cache=None, then=None, control=None):
    """Optionally fetch samples before room prefetch; --no-download keeps both on demand."""
    if not download:
        log('后台模型下载已关闭；打开房间时，才按需获取该房间缺失的模型。')
        return []
    try:
        with control.download(background=True) if control else nullcontext(True) as allowed:
            if not allowed:
                log('清理缓存后，后台预下载已暂停；打开房间时仍可按需获取模型。')
                return []
            return fetch_samples.fetch(check=False, missing_only=True, log=log, cache=cache)
    except (OSError, ValueError, KeyError) as error:
        log(f'Sample models not checked (samples/models.json): {error}')
    finally:
        if then:
            then()


class Server(ThreadingHTTPServer):
    # ES-module imports arrive in bursts; Python 3.12's five-entry default can reset local connections.
    request_queue_size = 64


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=7880)
    parser.add_argument('--viewforge', default=Handler.viewforge, help='ViewForge server (default: the SSH tunnel)')
    parser.add_argument('--room-backend', default=Handler.room_backend, help='Room reconstruction API (default: http://127.0.0.1:7866)')
    parser.add_argument('--ssh', metavar='HOST', help='open the SSH tunnels to the object and room services on HOST')
    parser.add_argument('--remote', help='object service address as seen from HOST: separate tunnels, no gateway (default: 127.0.0.1:7862)')
    parser.add_argument('--room-remote', help='room reconstruction API address as seen from HOST (default: 127.0.0.1:7866)')
    parser.add_argument('--gateway', metavar='ADDRESS:PORT',
                        help='gateway.py address as seen from HOST, one tunnel for both services '
                             '(default with --ssh: 127.0.0.1:7870, unless --remote or --room-remote is given)')
    parser.add_argument('--cpa', nargs='?', const=8317, type=int, metavar='PORT',
                        help="with --ssh: forward this port on the server back to this computer's CLIProxyAPI (default 8317)")
    parser.add_argument('--server-dir', metavar='DIR', help='with --ssh: the RoomCanvas checkout on HOST; start its services there')
    parser.add_argument('--cache', type=Path, default=Handler.cache, help='local copies of finished rooms and replays (default: runs/room-cache)')
    parser.add_argument('--no-download', action='store_true',
                        help='disable background sample/room/replay downloads; opening a sample may still fetch its missing model')
    args = parser.parse_args()
    if args.server_dir and not args.ssh:
        parser.error('--server-dir needs --ssh')
    if args.cpa and not args.ssh:
        parser.error('--cpa needs --ssh')
    if args.gateway and not args.ssh:
        parser.error('--gateway needs --ssh')
    if args.gateway and (args.remote or args.room_remote):
        parser.error('--gateway replaces --remote and --room-remote')
    if args.ssh and not (args.remote or args.room_remote):
        args.gateway = args.gateway or '127.0.0.1:7870'
    args.remote = args.remote or '127.0.0.1:7862'
    args.room_remote = args.room_remote or '127.0.0.1:7866'
    Handler.viewforge = args.viewforge.rstrip('/')
    Handler.room_backend = args.room_backend.rstrip('/')
    Handler.cache = args.cache.resolve()
    control = CacheManager(ROOT, Handler.cache)
    tunnel = sync = None
    if args.gateway:  # paths already tell the services apart, so both backends are the one forwarded port
        Handler.room_backend = Handler.viewforge
    if args.ssh:
        forwards = [(urlsplit(Handler.viewforge).port or 80, args.gateway or args.remote)]
        if not args.gateway:
            forwards.append((urlsplit(Handler.room_backend).port or 80, args.room_remote))
        try:
            command = tunnel_command(args.ssh, forwards, [args.cpa] if args.cpa else [], args.server_dir)
        except ValueError as error:
            parser.error(str(error))
        tunnel = Tunnel(command, open_tunnel(command, [port for port, _ in forwards]))
        if not args.no_download:
            try:  # only manifest-listed sample models may be reused, never their tracked metadata
                samples = [ROOT / entry['path'] for entry in fetch_samples.load()[1]]
            except (OSError, ValueError, KeyError):
                samples = []
            sync = room_cache.Sync(Handler.room_backend, Handler.cache, log=lambda line: print(line, flush=True),
                                   also=samples, control=control)
    server = Server(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT)))
    # Seed the shared files from samples before starting room prefetch; both honor the cleanup pause.
    threading.Thread(target=fetch_sample_models, args=(not args.no_download, lambda line: print(line, flush=True)),
                     kwargs={'cache': Handler.cache, 'then': sync and sync.start, 'control': control}, daemon=True).start()
    print(f'http://127.0.0.1:{args.port}/web/  ·  ViewForge {Handler.viewforge}'
          + (f' (tunnel via {args.ssh} to {args.gateway or args.remote})' if tunnel else '')
          + f'  ·  rooms {Handler.room_backend}' + (f' (to {args.gateway or args.room_remote})' if tunnel else '')
          + (f'  ·  CPA: {args.ssh} 127.0.0.1:{args.cpa} -> this computer' if args.cpa else ''))
    def stop(signum, frame):
        raise KeyboardInterrupt
    for signum in (signal.SIGTERM, signal.SIGHUP):  # closing the terminal or `kill` also closes the tunnel
        signal.signal(signum, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if sync:
            sync.stop()
        if tunnel:
            tunnel.close()


if __name__ == '__main__':
    main()
