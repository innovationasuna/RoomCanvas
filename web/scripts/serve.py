#!/usr/bin/env python3
"""Serve the repository for the editor, and pass ViewForge's layout API through from the same origin.

python3 web/scripts/serve.py                      # http://127.0.0.1:7880/web/
python3 web/scripts/serve.py --viewforge http://127.0.0.1:7865

The editor reads ViewForge's objects at /viewforge/layouts/catalog and /viewforge/layouts/assets/...;
those GET requests go to the ViewForge server (normally the SSH tunnel to the 3090). Nothing else
is forwarded, and the server only listens on this computer.
"""
import argparse
import re
import shutil
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# catalog, assets/<run>, assets/<run>/result.glb|preview.glb: the reads the editor makes.
FORWARDED = re.compile(r'^/viewforge/layouts/(catalog|assets/[\w-]+(/(result|preview)\.glb)?)$')


def forwarded(path):
    """The ViewForge path to request for an editor path, or None if it is not forwarded."""
    path = path.split('?', 1)[0]
    return path if FORWARDED.match(path) else None


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
        try:
            with urllib.request.urlopen(self.viewforge + target, timeout=60) as response:
                self.send_response(response.status)
                for name in ('Content-Type', 'Content-Length'):
                    if response.headers.get(name):
                        self.send_header(name, response.headers[name])
                self.end_headers()
                shutil.copyfileobj(response, self.wfile)
        except urllib.error.HTTPError as error:
            self.send_error(error.code, 'ViewForge: ' + error.reason)
        except (urllib.error.URLError, TimeoutError) as error:
            self.send_error(502, f'ViewForge not reachable at {self.viewforge} ({error})')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=7880)
    parser.add_argument('--viewforge', default=Handler.viewforge, help='ViewForge server (default: the SSH tunnel)')
    args = parser.parse_args()
    Handler.viewforge = args.viewforge.rstrip('/')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(ROOT)))
    print(f'http://127.0.0.1:{args.port}/web/  ·  ViewForge {Handler.viewforge}')
    server.serve_forever()


if __name__ == '__main__':
    main()
