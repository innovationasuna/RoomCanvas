"""Credentials protect direct backends as well as the gateway, before reading uploads."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import room_service
import gateway
import room_cache
import serve
from service_auth import AuthMiddleware, load_token, urlopen

TOKEN = 'c' * 64


class Credentials(unittest.TestCase):
    def test_creation_is_private_atomic_and_reuses_the_existing_token(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'private/token'
            with ThreadPoolExecutor(4) as pool:
                tokens = list(pool.map(lambda _: load_token(path, create=True), range(8)))
            self.assertEqual(len(set(tokens)), 1)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(tokens[0]), 64)
            self.assertEqual(list(path.parent.iterdir()), [path])
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                load_token(path)
            path.chmod(0o600)
            link = Path(temp) / 'link'; link.symlink_to(path)
            with self.assertRaises(OSError):
                load_token(link)

    def test_unauthorized_asgi_upload_never_reads_body_or_dispatches(self):
        async def check():
            async def forbidden(*args):
                self.fail('unauthorized upload reached the body or application')
            sent = []
            async def send(message):
                sent.append(message)
            await AuthMiddleware(forbidden, TOKEN)({'type': 'http', 'headers': []}, forbidden, send)
            self.assertEqual(sent[0]['status'], 401)
        asyncio.run(check())


class ProtectedServices(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        jobs = room_service.Jobs(Path(self.temp.name) / 'jobs', Path.cwd())
        self.addCleanup(os.close, jobs.owner)
        handler = type('Room', (room_service.Handler,), {'service_token': TOKEN, 'jobs': jobs,
                                                       'log_message': lambda *args: None})
        self.room = self.server(handler)
        handler = type('Gateway', (gateway.Gateway,), {'service_token': TOKEN,
                    'rooms': ('127.0.0.1', self.room.server_port), 'objects': ('127.0.0.1', self.room.server_port)})
        self.gateway = self.server(handler)

    def server(self, handler):
        server = room_service.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        return server

    def test_direct_and_gateway_requests_require_credentials_for_reads_and_writes(self):
        for server in (self.room, self.gateway):
            for method, path in [('GET', '/room-reconstruction/jobs'), ('HEAD', '/room-reconstruction/health'),
                                 ('POST', '/room-reconstruction/jobs'), ('GET', '/room-reconstruction/samples/office/Room.glb')]:
                for value in (None, 'Bearer wrong', 'Bearer é'):
                    with self.subTest(port=server.server_port, method=method, value=value):
                        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
                        connection.request(method, path, headers={'Authorization': value} if value else {})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 401)
                        self.assertEqual(response.read(), b'')
                        connection.close()
            base = f'http://127.0.0.1:{server.server_port}'
            with urlopen(base + '/room-reconstruction/health', token=TOKEN) as response:
                self.assertTrue(json.load(response)['ok'])
            sync = room_cache.Sync(base, Path(self.temp.name) / 'cache', token=TOKEN)
            self.assertEqual(json.loads(sync.get('/room-reconstruction/jobs')), {'jobs': []})

    def test_redirects_cannot_forward_the_credential(self):
        class Redirect(gateway.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302)
                self.send_header('Location', 'http://127.0.0.1:1/secret')
                self.end_headers()
            def log_message(self, *args):
                pass
        redirect = self.server(Redirect)
        with self.assertRaises(urllib.error.HTTPError) as error:
            urlopen(f'http://127.0.0.1:{redirect.server_port}/', token=TOKEN)
        self.assertEqual(error.exception.code, 302)

    def test_ssh_reads_token_without_placing_it_in_command_arguments(self):
        with patch.object(serve.subprocess, 'run') as run:
            run.return_value.returncode = 0
            run.return_value.stdout = TOKEN + '\n'
            self.assertEqual(serve.remote_token('host', '/private path/token'), TOKEN)
            self.assertNotIn(TOKEN, str(run.call_args))
