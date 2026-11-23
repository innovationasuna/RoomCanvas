"""Immutable room snapshots and an allowlisted, read-only LAN server (stdlib only)."""
import hashlib
import ipaddress
import json
import re
import secrets
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote

MAX_MODEL = 512 * 1024 * 1024
SHARE_ID = r'[a-f0-9]{32}'
ROOT = Path(__file__).resolve().parents[2]


def lan_addresses():
    addresses = set()
    preferred = None
    try:
        addresses.update(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    # macOS often resolves its hostname to loopback. Enumerate interfaces without contacting a server.
    try:
        output = subprocess.check_output(['ifconfig'], text=True, timeout=2, stderr=subprocess.DEVNULL)
        addresses.update(re.findall(r'\binet (\d+\.\d+\.\d+\.\d+)', output))
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        preferred = subprocess.check_output(['ipconfig', 'getifaddr', 'en0'], text=True, timeout=2, stderr=subprocess.DEVNULL).strip()
        if preferred:
            ipaddress.ip_address(preferred)
            addresses.add(preferred)
    except (OSError, ValueError, subprocess.SubprocessError):
        preferred = None
    usable = sorted(a for a in addresses if ipaddress.ip_address(a).is_private
                    and not ipaddress.ip_address(a).is_loopback and not ipaddress.ip_address(a).is_link_local)
    if preferred in usable:
        usable.remove(preferred)
        usable.insert(0, preferred)
    return usable


def validate_glb(path):
    size = path.stat().st_size
    with path.open('rb') as f:
        header = f.read(20)
        if len(header) != 20:
            raise ValueError('房间文件不完整')
        magic, version, total, length, kind = struct.unpack('<4sIIII', header)
        if magic != b'glTF' or version != 2 or total != size or kind != 0x4E4F534A or length > min(size - 20, 16 * 1024 * 1024):
            raise ValueError('房间文件不是完整的 GLB 2.0')
        document = json.loads(f.read(length))
        # Every texture and buffer must travel with the room. No original editor URLs.
        for resource in document.get('buffers', []) + document.get('images', []):
            if 'uri' in resource and not resource['uri'].startswith('data:'):
                raise ValueError('房间仍引用外部模型或贴图，请重新导出完整快照')
        position = 20 + length
        while position < size:
            chunk = f.read(8)
            if len(chunk) != 8:
                raise ValueError('GLB 数据块不完整')
            chunk_length, _ = struct.unpack('<II', chunk)
            position += 8 + chunk_length
            if position > size:
                raise ValueError('GLB 数据块不完整')
            f.seek(chunk_length, 1)
    metadata = next((n.get('extras', {}).get('roomcanvas') for n in document.get('nodes', [])
                     if n.get('extras', {}).get('roomcanvas')), None)
    if not isinstance(metadata, dict) or metadata.get('schema') != 1:
        raise ValueError('缺少 RoomCanvas 快照信息，请从编辑器重新生成')
    if not isinstance(metadata.get('name'), str) or not 1 <= len(metadata['name']) <= 200:
        raise ValueError('房间名称无效')
    if not re.fullmatch(r'[a-f0-9-]{36}', str(metadata.get('version', ''))):
        raise ValueError('房间版本无效')
    return metadata


class SnapshotStore:
    def __init__(self, directory):
        self.directory = Path(directory)

    def create(self, stream, length):
        if not 20 <= length <= MAX_MODEL:
            raise ValueError('房间文件须小于 512 MB')
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = Path(tempfile.mkdtemp(prefix='.upload-', dir=self.directory))
        try:
            path = temporary / 'room.glb'
            digest = hashlib.sha256()
            with path.open('wb') as output:
                remaining = length
                while remaining:
                    chunk = stream.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError('上传中断，请重新生成分享')
                    remaining -= len(chunk)
                    digest.update(chunk)
                    output.write(chunk)
            meta = validate_glb(path)
            identifier = secrets.token_hex(16)
            manifest = {key: meta.get(key) for key in ('schema', 'name', 'version', 'createdAt', 'units', 'floorY', 'bounds', 'interaction')}
            manifest.update(id=identifier, model={
                'url': f'/s/{identifier}/room.glb', 'bytes': length, 'sha256': digest.hexdigest(),
            })
            (temporary / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
            temporary.rename(self.directory / identifier)
            return manifest
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)


# These files alone are reachable on the phone port. No repository listing, source models,
# proxy APIs, room deletion, reconstruction, or publication endpoints.
STATIC_FILES = {
    '/web/mobile/index.html', '/web/mobile/mobile.css', '/web/mobile/viewer.mjs', '/web/mobile/texture-loader.mjs',
    '/web/mobile/room-visibility.mjs', '/web/editor/placement.mjs',
    '/web/editor/wall-visibility.mjs', '/web/editor/material-layers.mjs',
    '/web/mobile/lighting.mjs', '/web/editor/time-lighting.mjs', '/web/editor/physical-lighting.mjs',
    '/web/editor/lighting-profiles.mjs', '/web/editor/lighting-settings.mjs', '/web/editor/indoor-lighting.mjs',
    '/web/editor/environment-lighting.mjs', '/web/editor/static-lighting.mjs', '/web/editor/settled-render.mjs',
    '/web/editor/lighting-composite.mjs', '/web/editor/color-grading.mjs',
    '/web/editor/room-luminaires.mjs', '/web/editor/ray-queries.mjs', '/web/editor/collision.mjs',
    '/web/editor/entity-geometry.mjs', '/web/editor/geometry-bounds.mjs', '/web/editor/triangle-index.mjs',
    '/web/editor/walk.mjs', '/web/editor/touch-walk.mjs', '/web/theme.css', '/web/icon.svg',
    '/web/vendor/build/three.module.js', '/web/vendor/build/three.core.js',
    '/web/vendor/examples/jsm/loaders/GLTFLoader.js',
    '/web/vendor/examples/jsm/controls/OrbitControls.js',
    '/web/vendor/examples/jsm/utils/BufferGeometryUtils.js',
    '/web/vendor/examples/jsm/environments/RoomEnvironment.js',
    '/web/vendor/examples/jsm/postprocessing/GTAOPass.js', '/web/vendor/examples/jsm/postprocessing/Pass.js',
    '/web/vendor/examples/jsm/shaders/GTAOShader.js', '/web/vendor/examples/jsm/shaders/PoissonDenoiseShader.js',
    '/web/vendor/examples/jsm/shaders/CopyShader.js', '/web/vendor/examples/jsm/math/SimplexNoise.js',
}


class ShareHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, store, root=ROOT, **kwargs):
        self.store, self.root = store, Path(root)
        super().__init__(*args, directory=str(root), **kwargs)

    def do_GET(self):
        self.deliver(False)

    def do_HEAD(self):
        self.deliver(True)

    def deliver(self, head):
        route = urlsplit(self.path).path
        path = None
        if re.fullmatch(rf'/s/{SHARE_ID}/?', route):
            identifier = route.split('/')[2]
            if (self.store.directory / identifier / 'manifest.json').is_file():
                path = self.root / 'web/mobile/index.html'
        elif re.fullmatch(rf'/s/{SHARE_ID}/(manifest\.json|room\.glb)', route):
            path = self.store.directory / route.split('/')[2] / route.split('/')[3]
        elif route in STATIC_FILES:
            path = self.root / route.lstrip('/')
        elif re.fullmatch(r'/web/assets/fonts/manrope-[A-Za-z0-9.-]+\.woff2', route):
            path = self.root / route.lstrip('/')
        if path is None or not path.is_file():
            return self.send_error(404, 'Share or resource not found')
        self.send_response(200)
        self.send_header('Content-Type', 'model/gltf-binary' if path.suffix == '.glb' else self.guess_type(str(path)))
        self.send_header('Content-Length', str(path.stat().st_size))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        if not head:
            try:
                with path.open('rb') as source:
                    shutil.copyfileobj(source, self.wfile, 1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_POST(self):
        self.send_error(405, 'Read only')

    do_DELETE = do_PUT = do_PATCH = do_POST


def start_share_server(store, host, port):
    server = ThreadingHTTPServer((host, port), partial(ShareHandler, store=store))
    thread = threading.Thread(target=server.serve_forever, daemon=True, name='mobile-share')
    thread.start()
    return server
