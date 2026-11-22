"""python3 -m unittest discover -s web/scripts"""
import http.client
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gateway import Gateway, split_address  # noqa: E402


def backend(name):
    class Echo(BaseHTTPRequestHandler):
        def respond(self):
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            reply = json.dumps({'service': name, 'method': self.command, 'path': self.path,
                                'size': len(body), 'name': self.headers.get('X-Room-Name')}).encode()
            self.send_response(201 if body else 200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(reply)))
            self.end_headers()
            self.wfile.write(reply)
        do_GET = do_POST = respond

        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Echo)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Routing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.objects, cls.rooms = backend('objects'), backend('rooms')
        Gateway.service_token = 'a' * 64
        Gateway.objects = ('127.0.0.1', cls.objects.server_port)
        Gateway.rooms = ('127.0.0.1', cls.rooms.server_port)
        cls.gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
        threading.Thread(target=cls.gateway.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.gateway, cls.objects, cls.rooms):
            server.shutdown()
            server.server_close()

    def call(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.gateway.server_port, timeout=10)
        connection.request(method, path, body=body, headers={'Authorization': 'Bearer ' + 'a' * 64, **(headers or {})})
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def test_room_paths_go_to_the_room_service_and_the_rest_to_objects(self):
        self.assertEqual(self.call('GET', '/room-reconstruction/jobs?x=1')[1]['service'], 'rooms')
        self.assertEqual(self.call('GET', '/room-reconstruction/jobs?x=1')[1]['path'], '/room-reconstruction/jobs?x=1')
        for path in ['/health', '/viewforge/assets/catalog', '/room-reconstructionx']:
            self.assertEqual(self.call('GET', path)[1]['service'], 'objects', path)

    def test_a_post_body_and_headers_arrive_unchanged(self):
        status, data = self.call('POST', '/room-reconstruction/jobs', b'z' * 3_000_000, {'X-Room-Name': 'room3'})
        self.assertEqual((status, data['service'], data['size'], data['name']), (201, 'rooms', 3_000_000, 'room3'))

    def test_a_stopped_service_gives_503_naming_it(self):
        rooms = Gateway.rooms
        Gateway.rooms = ('127.0.0.1', 1)
        try:
            status, data = self.call('GET', '/room-reconstruction/health')
        finally:
            Gateway.rooms = rooms
        self.assertEqual(status, 503)
        self.assertIn('房间重建服务', data['error'])


class Preview(Routing):
    """Without a GPU the gateway refuses object reconstruction but still serves and saves everything else."""
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        Gateway.preview = True

    @classmethod
    def tearDownClass(cls):
        Gateway.preview = False
        super().tearDownClass()

    def test_object_reconstruction_is_refused_with_a_reason(self):
        status, body = self.call('POST', '/viewforge/objects/create', b'{}', {'Content-Type': 'application/json'})
        self.assertEqual(status, 503)
        self.assertIn('GPU', body['error'])

    def test_reads_and_size_edits_still_pass(self):
        self.assertEqual(self.call('GET', '/viewforge/assets/catalog')[1]['service'], 'objects')
        self.assertEqual(self.call('POST', '/viewforge/dimensions/run1', b'{}')[1]['service'], 'objects')


class Address(unittest.TestCase):
    def test_address_is_host_and_port(self):
        self.assertEqual(split_address('172.18.0.2:7862'), ('172.18.0.2', 7862))
        for bad in ['7862', 'host', 'http://h:1', 'h:x']:
            with self.assertRaises(ValueError):
                split_address(bad)


if __name__ == '__main__':
    unittest.main()
