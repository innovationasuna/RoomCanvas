#!/usr/bin/env python3
"""Serve the repository for the editor, and pass ViewForge's object APIs through from the same origin.

python3 web/scripts/serve.py --ssh <host>                           # page + one tunnel to gateway.py (127.0.0.1:7870 on <host>)
python3 web/scripts/serve.py --ssh <host> --remote <address>:7862   # page + separate tunnels to the object and room services
python3 web/scripts/serve.py                                         # page only, tunnel opened elsewhere
python3 web/scripts/serve.py --viewforge http://127.0.0.1:7865

The editor reads ViewForge's objects at /viewforge/assets/catalog and /viewforge/assets/<run>/...,
and "添加物品" uploads photos and follows the reconstruction at /viewforge/objects/... and saves the
measured size at /viewforge/dimensions/<run>; those requests go to the ViewForge server. "重建房间" uploads
a scan and follows the job at /room-reconstruction/..., which goes to the room reconstruction API. With --ssh,
this script opens one SSH connection forwarding both (local ports taken from --viewforge and --room-backend)
and closes it on exit.
Nothing else is forwarded, POSTs only from this page, and the server only listens on this computer.
"""
import argparse
import json
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
NAME = r'[\w.-]+'
# The reads the editor makes: catalog, assets/<run>[/result.glb|preview.glb], a job, a mask preview.
READS = re.compile(rf'^/viewforge/(assets/(catalog|{NAME}(/((result|preview)\.glb|result\.ply|preview\.json))?)'
                   rf'|layouts/(catalog|assets/{NAME}(/((result|preview)\.glb|result\.ply|preview\.json))?)'
                   rf'|objects/(jobs/[0-9a-f]{{32}}|previews/\w+/{NAME}\.png))$')
# Its writes: new object with photos, more photos for a finished one (补拍), masks, reconstruction, measured size.
WRITES = re.compile(rf'^/viewforge/(objects/(create|capture|masks|reconstruct)|dimensions/{NAME})$')
MAX_BODY = 400 * 1024 * 1024
# Reads for the room service: health, catalog, jobs, a finished room's files, and a job's replay
# (timeline, 3D scaffold, and the models / pictures the service itself allowlists under files/).
ROOM_READS = re.compile(r'^/room-reconstruction/(health|catalog|jobs(/[0-9a-f]{32}(/replay(/scaffold/(points\.bin|layout\.json)|/files/[\w./-]+)?)?)?'
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


class Handler(SimpleHTTPRequestHandler):
    viewforge = 'http://127.0.0.1:7865'
    room_backend = 'http://127.0.0.1:7866'

    def room_json(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        # Files are revalidated (304 if unchanged): a replaced Room.glb must not come from the cache.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if urlsplit(self.path).path == '/web/rooms.json':
            data = json.loads((ROOT / 'web/rooms.json').read_text())
            try:
                with urllib.request.urlopen(self.room_backend + '/room-reconstruction/catalog', timeout=2) as response:
                    data['rooms'].extend(json.load(response)['rooms'])
            except (OSError, ValueError, KeyError):
                pass  # Existing rooms remain usable while the reconstruction worker is offline.
            return self.room_json(200, data)
        room_target = room_forwarded(self.path)
        if room_target:
            return self.relay(urllib.request.Request(self.room_backend + room_target), 10, room=True)
        target = forwarded(self.path)
        if target is None:
            return super().do_GET()
        self.relay(urllib.request.Request(self.viewforge + target), 60)

    def do_POST(self):
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
            return self.room_json(413, {'error': '扫描 ZIP 不能超过 2 GB'})
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


def tunnel_command(host, forwards):
    """The ssh command that forwards each 127.0.0.1:<local_port> to <remote> as seen from <host>."""
    # ControlPath=none: with ControlMaster in ~/.ssh/config a second ssh hands the forwards to the master and
    # exits, leaving the ports open after this script stops.
    command = ['ssh', '-N', '-o', 'ControlPath=none', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15']
    for local_port, remote in forwards:
        if not re.fullmatch(r'[\w.-]+:\d+', remote):
            raise ValueError(f'remote must be <address>:<port>, got {remote!r}')
        command += ['-L', f'127.0.0.1:{local_port}:{remote}']
    return command + [host]


def open_tunnel(command, ports, wait=30):
    """Start ssh and return it once every local port accepts connections; exit with a message if ssh stops."""
    for port in ports:
        try:
            socket.create_connection(('127.0.0.1', port), timeout=1).close()
        except OSError:
            continue
        # something already answers there, e.g. a tunnel opened by hand: it would look like ours
        sys.exit(f'Port {port} is already in use (a tunnel already open?). Close it, or run without --ssh.')
    process = subprocess.Popen(command)
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
    args = parser.parse_args()
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
    tunnel = None
    if args.gateway:  # paths already tell the services apart, so both backends are the one forwarded port
        Handler.room_backend = Handler.viewforge
    if args.ssh:
        forwards = [(urlsplit(Handler.viewforge).port or 80, args.gateway or args.remote)]
        if not args.gateway:
            forwards.append((urlsplit(Handler.room_backend).port or 80, args.room_remote))
        try:
            command = tunnel_command(args.ssh, forwards)
        except ValueError as error:
            parser.error(str(error))
        tunnel = open_tunnel(command, [port for port, _ in forwards])
    server = Server(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT)))
    print(f'http://127.0.0.1:{args.port}/web/  ·  ViewForge {Handler.viewforge}'
          + (f' (tunnel via {args.ssh} to {args.gateway or args.remote})' if tunnel else '')
          + f'  ·  rooms {Handler.room_backend}' + (f' (to {args.gateway or args.room_remote})' if tunnel else ''))
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
        if tunnel:
            tunnel.terminate()
            tunnel.wait(timeout=5)


if __name__ == '__main__':
    main()
