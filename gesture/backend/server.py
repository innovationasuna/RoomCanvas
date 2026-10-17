"""Mac mini 局域网测试：同源静态网页 + 内存 JPEG 推理，不记录画面或关键点。"""
import argparse
import hashlib
import hmac
import io
import json
import os
import secrets
import queue
import ssl
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
MAX_BODY = 512 * 1024


class Inference:
    def __init__(self):
        os.environ.setdefault('MPLCONFIGDIR', str(ROOT / 'backend/.cache/matplotlib'))
        import mediapipe as mp
        from mediapipe.tasks import python
        from mediapipe.tasks.python import vision
        model = ROOT / 'public/vision/hand_landmarker.task'
        manifest = json.loads((ROOT / 'public/vision/manifest.json').read_text())
        expected = next(r['sha256'] for r in manifest['resources'] if r['path'] == 'public/vision/hand_landmarker.task')
        if hashlib.sha256(model.read_bytes()).hexdigest() != expected:
            raise RuntimeError('模型校验失败')
        self.mp = mp
        # 无跨客户端追踪状态；每帧独立识别，避免多设备身份串线。
        self.detector = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(model), delegate=python.BaseOptions.Delegate.CPU),
            running_mode=vision.RunningMode.IMAGE, num_hands=2,
            min_hand_detection_confidence=0.6, min_hand_presence_confidence=0.6,
            min_tracking_confidence=0.6))

    def detect(self, body):
        import numpy as np
        from PIL import Image
        with Image.open(io.BytesIO(body)) as image:
            if image.format != 'JPEG' or image.width > 640 or image.height > 480:
                raise ValueError('仅接受不超过 640×480 的 JPEG')
            pixels = np.asarray(image.convert('RGB'))
        start = time.perf_counter()
        result = self.detector.detect(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=pixels))
        elapsed = (time.perf_counter() - start) * 1000
        def points(values):
            return [dict(x=p.x, y=p.y, z=p.z) for p in values]
        return dict(inferenceMs=elapsed, hands=[dict(
            landmarks=points(landmarks), world=points(result.hand_world_landmarks[i]),
            side=result.handedness[i][0].category_name, score=result.handedness[i][0].score
        ) for i, landmarks in enumerate(result.hand_landmarks)])

    def close(self):
        self.detector.close()


class InferencePool:
    def __init__(self, workers=2):
        self.engines = [Inference() for _ in range(workers)]
        self.available = queue.Queue()
        for engine in self.engines:
            self.available.put_nowait(engine)

    def close(self):
        for engine in self.engines:
            engine.close()


def handler_factory(pool, token):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / 'dist'), **kwargs)

        def log_message(self, *_args):
            pass  # 不记录请求、令牌、画面和关键点。

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Referrer-Policy', 'no-referrer')
            super().end_headers()

        def respond(self, status, value):
            data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def authorized(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.respond(401, dict(error='访问令牌不正确'))
                return False
            # 浏览器跨站请求不能访问推理接口；不启用 CORS。
            origin = self.headers.get('Origin')
            if origin and urlsplit(origin).netloc != self.headers.get('Host'):
                self.respond(403, dict(error='仅允许同源请求'))
                return False
            return True

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == '/api/health':
                if self.authorized():
                    self.respond(200, dict(engine='mediapipe-python', mode='IMAGE', recording=False))
            elif path.startswith('/api/'):
                self.respond(404, dict(error='接口不存在'))
            else:
                super().do_GET()

        def do_POST(self):
            self.close_connection = True
            if not self.authorized():
                return
            if self.path != '/api/detect':
                self.respond(404, dict(error='接口不存在'))
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                length = 0
            if not 0 < length <= MAX_BODY or self.headers.get('Content-Type') != 'image/jpeg' or self.headers.get('Transfer-Encoding'):
                self.respond(400, dict(error='画面格式或大小无效'))
                return
            try:
                engine = pool.available.get_nowait()
            except queue.Empty:
                self.respond(503, dict(error='后端忙，跳过当前帧'))
                return
            try:
                self.connection.settimeout(5)
                body = self.rfile.read(length)
                if len(body) != length:
                    raise ValueError('画面不完整')
                result = engine.detect(body)
                self.respond(200, result)
            except (ValueError, OSError):
                self.respond(400, dict(error='无法解析画面'))
            except Exception:
                self.respond(500, dict(error='模型推理失败'))
            finally:
                pool.available.put_nowait(engine)
    return Handler


def main():
    parser = argparse.ArgumentParser(description='Mac mini 手部识别测试后端')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8843)
    parser.add_argument('--cert', type=Path)
    parser.add_argument('--key', type=Path)
    parser.add_argument('--public-host', default='localhost', help='其他电脑访问的 Mac mini IP 或主机名')
    parser.add_argument('--workers', type=int, default=2, help='并发推理实例数，默认 2')
    args = parser.parse_args()
    if not 1 <= args.workers <= 8:
        parser.error('并发实例数必须在 1 到 8 之间')
    if bool(args.cert) != bool(args.key):
        parser.error('证书和私钥必须一起提供')
    if args.host not in ('127.0.0.1', 'localhost', '::1') and not args.cert:
        parser.error('局域网模式必须提供 HTTPS 证书和私钥')
    if not (ROOT / 'dist/index.html').is_file():
        parser.error('请先执行 ./scripts/run.sh build')
    pool = InferencePool(args.workers)
    token = secrets.token_urlsafe(32)
    server = ThreadingHTTPServer((args.host, args.port), handler_factory(pool, token))
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.cert, args.key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    scheme = 'https' if args.cert else 'http'
    print(f'后端已就绪（CPU 推理、不录制、不持久化），请在测试电脑打开：\n{scheme}://{args.public_host}:{args.port}/?tracking=remote#token={token}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n后端已停止。')
    finally:
        server.server_close()
        pool.close()


if __name__ == '__main__':
    main()
