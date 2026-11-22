#!/usr/bin/env python3
"""One port in front of the object and room reconstruction services, so the computer needs one SSH tunnel.

python3 web/scripts/gateway.py                      # 127.0.0.1:7870 -> objects 127.0.0.1:7862, rooms 127.0.0.1:7866
python3 web/scripts/gateway.py --objects 172.18.0.2:7862

/room-reconstruction/... goes to the room service, everything else to the object service. Requests and
responses are streamed unchanged (scan ZIPs are up to 2 GB); the filtering of what the page may reach stays
in serve.py. Uses only the Python standard library, so any Python 3 on the server can run it.
"""
import argparse
import http.client
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from service_auth import HTTPAuth, load_token
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOM_PREFIX = '/room-reconstruction/'
# Writes that need the GPU; saving a measured size (/dimensions/...) does not.
GPU_WRITES = re.compile(r'^/viewforge/objects/')
PREVIEW = '这台服务器没有 GPU，只能浏览房间、物品和重建回放，不能提交重建。'
HOP_BY_HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
              'transfer-encoding', 'upgrade', 'host'}
CHUNK = 1024 * 1024


def split_address(text):
    match = re.fullmatch(r'([\w.-]+):(\d+)', text)
    if not match:
        raise ValueError(f'address must be <host>:<port>, got {text!r}')
    return match.group(1), int(match.group(2))


class Gateway(HTTPAuth, BaseHTTPRequestHandler):
    objects = ('127.0.0.1', 7862)
    rooms = ('127.0.0.1', 7866)
    preview = False

    def backend(self):
        return self.rooms if self.path.startswith(ROOM_PREFIX) else self.objects

    def fail(self, status, message):
        body = json.dumps({'error': message}, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def relay(self):
        if self.preview and self.command == 'POST' and GPU_WRITES.match(self.path):
            return self.fail(503, PREVIEW)
        host, port = self.backend()
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        length = int(self.headers.get('Content-Length') or 0)
        try:
            connection = http.client.HTTPConnection(host, port, timeout=300)
            connection.putrequest(self.command, self.path, skip_host=True, skip_accept_encoding=True)
            connection.putheader('Host', f'{host}:{port}')
            for name, value in headers.items():
                connection.putheader(name, value)
            connection.endheaders()
            remaining = length
            while remaining:
                chunk = self.rfile.read(min(CHUNK, remaining))
                if not chunk:
                    break
                connection.send(chunk)
                remaining -= len(chunk)
            response = connection.getresponse()
        except OSError:
            name = '房间重建服务' if (host, port) == self.rooms else '物体重建服务'
            return self.fail(503, f'{name}未启动：网关连不上 {host}:{port}。')
        with response:
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in HOP_BY_HOP:
                    self.send_header(name, value)
            self.end_headers()  # HTTP/1.0: the body ends when the connection closes, as the backend's did
            if self.command != 'HEAD':
                while chunk := response.read(CHUNK):
                    self.wfile.write(chunk)
        connection.close()

    do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = relay

    def log_message(self, format, *args):
        pass


class Server(ThreadingHTTPServer):
    request_queue_size = 64


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--host', default='127.0.0.1', help='address to listen on (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=7870)
    parser.add_argument('--objects', default='127.0.0.1:7862', help='object service <host>:<port>')
    parser.add_argument('--rooms', default='127.0.0.1:7866', help='room service <host>:<port>')
    parser.add_argument('--preview', action='store_true', help='no GPU: refuse object reconstruction (the room service refuses its own)')
    parser.add_argument('--token-file', help='private service credential file')
    args = parser.parse_args()
    Gateway.service_token = load_token(args.token_file, create=True)
    Gateway.preview = args.preview
    try:
        Gateway.objects, Gateway.rooms = split_address(args.objects), split_address(args.rooms)
    except ValueError as error:
        parser.error(str(error))
    server = Server((args.host, args.port), Gateway)
    print(f'gateway {args.host}:{args.port} -> objects {args.objects}, rooms {args.rooms}' + (' (preview, no GPU)' if args.preview else ''), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
