#!/usr/bin/env python3
"""Serve the repository for the editor, and pass ViewForge's object APIs through from the same origin.

python3 web/scripts/serve.py --ssh <host> --remote <address>:7862   # page + tunnel to the object service
python3 web/scripts/serve.py                                         # page only, tunnel opened elsewhere
python3 web/scripts/serve.py --viewforge http://127.0.0.1:7865

The editor reads ViewForge's objects at /viewforge/assets/catalog and /viewforge/assets/<run>/...,
and "添加物品" uploads photos and follows the reconstruction at /viewforge/objects/... and saves the
measured size at /viewforge/dimensions/<run>; those requests go to the ViewForge server. With --ssh,
this script opens the SSH tunnel to it (local port taken from --viewforge) and closes it on exit.
Nothing else is forwarded, POSTs only from this page, and the server only listens on this computer.
"""
import argparse
import re
import shutil
import signal
import socket
import subprocess
import sys
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


def forwarded(path, method='GET'):
    """The ViewForge path to request for an editor path, or None if it is not forwarded."""
    path = unquote(path.split('?', 1)[0])
    if '..' in path or not (READS if method == 'GET' else WRITES).match(path):
        return None
    return quote(path)


class Handler(SimpleHTTPRequestHandler):
    viewforge = 'http://127.0.0.1:7865'

    def end_headers(self):
        # Files are revalidated (304 if unchanged): a replaced Room.glb must not come from the cache.
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        target = forwarded(self.path)
        if target is None:
            return super().do_GET()
        self.relay(urllib.request.Request(self.viewforge + target), 60)

    def do_POST(self):
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

    def relay(self, request, timeout):
        try:
            response = urllib.request.urlopen(request, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error  # ViewForge's own error message (JSON) goes to the page as it is.
        except (urllib.error.URLError, TimeoutError) as error:
            return self.send_error(502, f'ViewForge not reachable at {self.viewforge} ({error})')
        with response:
            self.send_response(response.status)
            for name in ('Content-Type', 'Content-Length'):
                if response.headers.get(name):
                    self.send_header(name, response.headers[name])
            self.end_headers()
            shutil.copyfileobj(response, self.wfile)


def tunnel_command(host, remote, local_port):
    """The ssh command that forwards 127.0.0.1:<local_port> to <remote> as seen from <host>."""
    if not re.fullmatch(r'[\w.-]+:\d+', remote):
        raise ValueError(f'--remote must be <address>:<port>, got {remote!r}')
    return ['ssh', '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15',
            '-L', f'127.0.0.1:{local_port}:{remote}', host]


def open_tunnel(command, local_port, wait=30):
    """Start ssh and return it once the local port accepts connections; exit with a message if ssh stops."""
    try:
        socket.create_connection(('127.0.0.1', local_port), timeout=1).close()
    except OSError:
        pass
    else:  # something already answers there, e.g. a tunnel opened by hand: it would look like ours
        sys.exit(f'Port {local_port} is already in use (a tunnel already open?). Close it, or run without --ssh.')
    process = subprocess.Popen(command)
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        if process.poll() is not None:
            sys.exit(f'SSH tunnel failed (exit {process.returncode}). Is port {local_port} already in use, '
                     f'or the host unreachable? Command: {" ".join(command)}')
        try:
            socket.create_connection(('127.0.0.1', local_port), timeout=1).close()
            return process
        except OSError:
            time.sleep(0.3)
    process.terminate()
    sys.exit(f'SSH tunnel did not open port {local_port} within {wait} s')


class Server(ThreadingHTTPServer):
    # ES-module imports arrive in bursts; Python 3.12's five-entry default can reset local connections.
    request_queue_size = 64


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=7880)
    parser.add_argument('--viewforge', default=Handler.viewforge, help='ViewForge server (default: the SSH tunnel)')
    parser.add_argument('--ssh', metavar='HOST', help='open the SSH tunnel to the object service on HOST')
    parser.add_argument('--remote', default='127.0.0.1:7862',
                        help='object service address as seen from HOST (default: 127.0.0.1:7862)')
    args = parser.parse_args()
    Handler.viewforge = args.viewforge.rstrip('/')
    tunnel = None
    if args.ssh:
        local_port = urlsplit(Handler.viewforge).port or 80
        try:
            command = tunnel_command(args.ssh, args.remote, local_port)
        except ValueError as error:
            parser.error(str(error))
        tunnel = open_tunnel(command, local_port)
    server = Server(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT)))
    print(f'http://127.0.0.1:{args.port}/web/  ·  ViewForge {Handler.viewforge}'
          + (f' (tunnel via {args.ssh} to {args.remote})' if tunnel else ''))
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
