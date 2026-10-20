#!/usr/bin/env python3
"""Serve the repository for the editor, and pass ViewForge's object APIs through from the same origin.

python3 web/scripts/serve.py                      # http://127.0.0.1:7880/web/
python3 web/scripts/serve.py --viewforge http://127.0.0.1:7865

The editor reads ViewForge's objects at /viewforge/assets/catalog and /viewforge/assets/<run>/...,
and "添加物体" uploads photos and follows the reconstruction at /viewforge/objects/... and saves the
measured size at /viewforge/dimensions/<run>; those requests go to the ViewForge server (normally the
SSH tunnel to the 3090). Nothing else is forwarded, POSTs only from this page, and the server only
listens on this computer.
"""
import argparse
import re
import shutil
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

ROOT = Path(__file__).resolve().parents[2]
NAME = r'[\w.-]+'
# The reads the editor makes: catalog, assets/<run>[/result.glb|preview.glb], a job, a mask preview.
READS = re.compile(rf'^/viewforge/(assets/(catalog|{NAME}(/(result|preview)\.glb)?)'
                   rf'|layouts/(catalog|assets/{NAME}(/(result|preview)\.glb)?)'
                   rf'|objects/(jobs/[0-9a-f]{{32}}|previews/\w+/{NAME}\.png))$')
# Its writes: new object with photos, masks, reconstruction, measured size.
WRITES = re.compile(rf'^/viewforge/(objects/(create|masks|reconstruct)|dimensions/{NAME})$')
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


class Server(ThreadingHTTPServer):
    # ES-module imports arrive in bursts; Python 3.12's five-entry default can reset local connections.
    request_queue_size = 64


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=7880)
    parser.add_argument('--viewforge', default=Handler.viewforge, help='ViewForge server (default: the SSH tunnel)')
    args = parser.parse_args()
    Handler.viewforge = args.viewforge.rstrip('/')
    server = Server(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT)))
    print(f'http://127.0.0.1:{args.port}/web/  ·  ViewForge {Handler.viewforge}')
    server.serve_forever()


if __name__ == '__main__':
    main()
