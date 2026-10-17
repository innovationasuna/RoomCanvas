"""协议/并发集成测试；真实模型仅使用空白合成图，不代表真人识别验收。"""
import io
import json
import queue
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from PIL import Image
from backend.server import Inference, handler_factory


class FakeEngine:
    def detect(self, body):
        return dict(hands=[], inferenceMs=1)


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.pool = type('Pool', (), dict(available=queue.Queue()))()
        self.engine = FakeEngine()
        self.pool.available.put(self.engine)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_factory(self.pool, 'test-token'))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method, path, body=None, headers=None):
        client = HTTPConnection(*self.server.server_address, timeout=5)
        client.request(method, path, body=body, headers=headers or {})
        response = client.getresponse()
        value = response.read()
        client.close()
        return response.status, value

    def test_auth_and_origin(self):
        self.assertEqual(self.request('GET', '/api/health')[0], 401)
        headers = {'Authorization': 'Bearer test-token'}
        status, body = self.request('GET', '/api/health', headers=headers)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['engine'], 'mediapipe-python')
        headers['Origin'] = 'https://other.example'
        self.assertEqual(self.request('POST', '/api/detect', b'jpeg', headers)[0], 403)

    def test_bad_request_busy_and_recovery(self):
        headers = {'Authorization': 'Bearer test-token', 'Content-Type': 'image/jpeg'}
        self.assertEqual(self.request('POST', '/api/detect', b'', headers)[0], 400)
        self.assertEqual(self.request('POST', '/api/detect', b'jpeg', headers)[0], 200)
        self.pool.available.get_nowait()
        self.assertEqual(self.request('POST', '/api/detect', b'jpeg', headers)[0], 503)
        self.pool.available.put(self.engine)
        self.assertEqual(self.request('POST', '/api/detect', b'jpeg', headers)[0], 200)
        self.assertEqual(self.pool.available.qsize(), 1)

    def test_two_clients_can_compute_simultaneously(self):
        barrier = threading.Barrier(2)
        class ParallelEngine:
            def detect(self, body):
                barrier.wait(timeout=3)
                return dict(hands=[], inferenceMs=1)
        self.pool.available.get_nowait()
        for _ in range(2):
            self.pool.available.put(ParallelEngine())
        statuses = []
        def request():
            statuses.append(self.request('POST', '/api/detect', b'jpeg', {'Authorization': 'Bearer test-token', 'Content-Type': 'image/jpeg'})[0])
        threads = [threading.Thread(target=request) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(statuses, [200, 200])
        self.assertEqual(self.pool.available.qsize(), 2)

    def test_invalid_frame_releases_worker(self):
        class InvalidEngine:
            def detect(self, body):
                raise ValueError('无效画面')
        self.pool.available.get_nowait()
        self.pool.available.put(InvalidEngine())
        headers = {'Authorization': 'Bearer test-token', 'Content-Type': 'image/jpeg'}
        self.assertEqual(self.request('POST', '/api/detect', b'invalid', headers)[0], 400)
        self.assertEqual(self.pool.available.qsize(), 1)


class RealModelTests(unittest.TestCase):
    def test_blank_image_and_reject_invalid_image(self):
        engine = Inference()
        try:
            output = io.BytesIO()
            Image.new('RGB', (320, 240), 'white').save(output, format='JPEG')
            result = engine.detect(output.getvalue())
            self.assertEqual(result['hands'], [])
            self.assertGreater(result['inferenceMs'], 0)
            with self.assertRaises((ValueError, OSError)):
                engine.detect(b'not a jpeg')
            output = io.BytesIO()
            Image.new('RGB', (641, 480), 'white').save(output, format='JPEG')
            with self.assertRaises(ValueError):
                engine.detect(output.getvalue())
        finally:
            engine.close()


if __name__ == '__main__':
    unittest.main()
