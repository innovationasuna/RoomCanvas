"""Single-axis metric calibration of completed results, outside reconstruction."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import tempfile
from datetime import datetime, timezone

import numpy as np
from asset_state import AssetUnavailableError, base_manifest, require_asset

UNITS = {'mm': .001, 'cm': .01, 'm': 1.}
# User-facing right-handed Z-up frame: X=display +X, Y=display -Z, Z=display +Y.
AXES = {'X': 0, 'Y': 2, 'Z': 1}


def atomic_json(path, data):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(data, handle, ensure_ascii=False, allow_nan=False, indent=2)
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def result_directory(root, name):
    if not re.fullmatch(r'[\w.-]+', name) or name in ('.', '..'):
        raise ValueError('无效的重建结果名称')
    runs = (Path(root)/'runs').resolve()
    run = (runs/name).resolve()
    if run.parent != runs or not (run/'reconstruction/result.glb').is_file():
        raise FileNotFoundError('找不到重建模型')
    require_asset(run)
    return run


@contextmanager
def locked(run):
    with (run/'dimensions.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def geometry(run, *, manifest=None):
    """Measure the FULL mesh in display coordinates, never the simplified mesh."""
    source = run/'reconstruction/result.glb'
    manifest = base_manifest(run) if manifest is None else manifest
    values = manifest.get('assets', {}).get('glb', {}).get('transform', np.eye(4).flatten().tolist())
    transform = np.asarray(values, dtype=float).reshape(4, 4, order='F')
    if not np.isfinite(transform).all() or not np.allclose(transform[3], [0, 0, 0, 1]):
        raise ValueError('模型坐标变换无效')
    stat = source.stat()
    key = hashlib.sha256(json.dumps([stat.st_size, stat.st_mtime_ns, values]).encode()).hexdigest()
    cache = run/'dimensions-base.json'
    if cache.is_file():
        previous = json.loads(cache.read_text())
        if previous.get('source_key') == key:
            return previous
    import trimesh
    scene = trimesh.load_scene(source, process=False)
    lower, upper = np.full(3, np.inf), np.full(3, -np.inf)
    for node in scene.graph.nodes_geometry:
        matrix, name = scene.graph[node]
        mesh = scene.geometry[name]
        if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
            continue
        points = trimesh.transform_points(mesh.vertices, transform @ matrix)
        if not np.isfinite(points).all():
            raise ValueError('模型包含无效坐标')
        lower = np.minimum(lower, points.min(axis=0))
        upper = np.maximum(upper, points.max(axis=0))
    spans = upper - lower
    if not np.isfinite(spans).all() or np.max(spans) <= 0:
        raise ValueError('模型没有可测量的几何体')
    data = dict(source_key=key, bounds=dict(min=lower.tolist(), max=upper.tolist()),
                lengths={axis: float(spans[index]) for axis, index in AXES.items()},
                transform=values)
    atomic_json(cache, data)
    return data


def current(run, base):
    path = run/'dimensions.json'
    if path.is_file():
        data = json.loads(path.read_text())
        if data.get('source_key') == base['source_key']:
            return data
    return None


def read_dimensions(run):
    with locked(run):
        base = geometry(run)
        return dict(run_id=run.name, base=base, calibration=current(run, base))


def save_dimensions(run, axis, value, unit):
    if axis not in AXES or unit not in UNITS:
        raise ValueError('请选择 X、Y 或 Z 轴，以及有效的单位')
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
        raise ValueError('实际长度必须是大于 0 的有限数值')
    with locked(run):
        base = geometry(run)
        length = base['lengths'][axis]
        if length <= max(base['lengths'].values()) * 1e-9:
            raise ValueError('这个方向的模型长度过小，请选择其他轴')
        scale = value * UNITS[unit] / length
        sizes = {name: span * scale for name, span in base['lengths'].items()}
        if not math.isfinite(scale) or not all(math.isfinite(v) for v in sizes.values()) or not 1e-9 <= scale <= 1e9:
            raise ValueError('尺寸超出可显示的范围，请检查单位和数值')
        data = dict(schema_version=1, source_key=base['source_key'], axis=axis, value=value,
                    unit=unit, scale=scale, dimensions_m=sizes,
                    updated_at=datetime.now(timezone.utc).isoformat())
        atomic_json(run/'dimensions.json', data)
        return dict(run_id=run.name, base=base, calibration=data)


def reset_dimensions(run):
    with locked(run):
        base = geometry(run)
        (run/'dimensions.json').unlink(missing_ok=True)
        return dict(run_id=run.name, base=base, calibration=None)


def metric_glb(run):
    """Wrap original scene nodes in one metric transform; preserve binary payload."""
    with locked(run):
        base = geometry(run)
        calibration = current(run, base)
        if calibration is None:
            raise ValueError('请先输入并保存实际尺寸')
        version = hashlib.sha256(json.dumps(calibration, sort_keys=True).encode()).hexdigest()[:16]
        # Each downloaded revision is immutable, including during concurrent edits.
        destination = run/'reconstruction'/f'scaled-{version}.glb'
        if destination.is_file():
            return destination
        data = (run/'reconstruction/result.glb').read_bytes()
        if len(data) < 20 or struct.unpack_from('<III', data) != (0x46546C67, 2, len(data)):
            raise ValueError('模型不是有效的 GLB 2.0 文件')
        size, kind = struct.unpack_from('<II', data, 12)
        if kind != 0x4E4F534A or 20 + size > len(data):
            raise ValueError('GLB 元数据损坏')
        doc = json.loads(data[20:20+size])
        matrix = np.diag([calibration['scale']] * 3 + [1.]) @ np.array(base['transform']).reshape(4, 4, order='F')
        nodes = doc.setdefault('nodes', [])
        for scene in doc.get('scenes', []):
            index = len(nodes)
            nodes.append(dict(name='ViewForge metric scale', matrix=matrix.flatten(order='F').tolist(), children=scene.get('nodes', [])))
            scene['nodes'] = [index]
        doc.setdefault('extras', {})['viewforge_dimensions'] = dict(calibration, length_unit='m', user_axes='X=+X,Y=-Z,Z=+Y')
        chunk = json.dumps(doc, separators=(',', ':'), allow_nan=False).encode()
        chunk += b' ' * (-len(chunk) % 4)
        tail = data[20+size:]
        encoded = struct.pack('<IIIII', 0x46546C67, 2, 20+len(chunk)+len(tail), len(chunk), kind) + chunk + tail
        with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(encoded)
        try:
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return destination


class DimensionsMiddleware:
    """Small same-origin API alongside Gradio, without changing its queue."""
    def __init__(self, app, root):
        self.app, self.root = app, Path(root)

    async def __call__(self, scope, receive, send):
        prefix = '/viewforge/dimensions/'
        if scope['type'] != 'http' or not scope['path'].startswith(prefix):
            return await self.app(scope, receive, send)
        from starlette.requests import Request
        from starlette.responses import JSONResponse, FileResponse
        from starlette.concurrency import run_in_threadpool
        from urllib.parse import urlsplit
        request = Request(scope, receive)
        parts = scope['path'][len(prefix):].split('/')
        try:
            if len(parts) > 2 or (len(parts) == 2 and parts[1] != 'model.glb'):
                raise FileNotFoundError('找不到接口')
            run = result_directory(self.root, parts[0])
            if request.method == 'GET' and len(parts) == 2:
                path = await run_in_threadpool(metric_glb, run)
                response = FileResponse(path, media_type='model/gltf-binary', filename=f'{run.name}-scaled.glb', headers={'Cache-Control': 'no-store'})
            elif request.method == 'GET':
                response = JSONResponse(await run_in_threadpool(read_dimensions, run), headers={'Cache-Control': 'no-store'})
            elif request.method == 'POST' and len(parts) == 1:
                origin = request.headers.get('origin')
                if origin and urlsplit(origin).netloc != request.headers.get('host'):
                    raise ValueError('请在当前网页中保存尺寸')
                if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                    raise ValueError('需要 JSON 格式的数据')
                body = await request.body()
                if len(body) > 2048:
                    raise ValueError('尺寸数据过长')
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise ValueError('尺寸数据格式无效')
                if payload.get('reset') is True:
                    result = await run_in_threadpool(reset_dimensions, run)
                else:
                    result = await run_in_threadpool(save_dimensions, run, payload.get('axis'), payload.get('value'), payload.get('unit'))
                response = JSONResponse(result, headers={'Cache-Control': 'no-store'})
            else:
                response = JSONResponse({'error': '不支持的请求方法'}, status_code=405)
        except AssetUnavailableError as exc:
            response = JSONResponse({'error': str(exc), 'state': exc.state}, status_code=409)
        except FileNotFoundError as exc:
            response = JSONResponse({'error': str(exc)}, status_code=404)
        except (ValueError, TypeError) as exc:
            response = JSONResponse({'error': str(exc)}, status_code=400)
        await response(scope, receive, send)
