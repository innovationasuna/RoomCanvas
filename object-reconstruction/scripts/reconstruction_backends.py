"""Backend contracts shared by the runner and API; no GPU imports."""
import json
import os
from pathlib import Path

BACKENDS = ('mvsam3d', 'trellis')


def backend_name(value=None):
    name = value or os.environ.get('VIEWFORGE_BACKEND', 'mvsam3d')
    if name not in BACKENDS:
        raise ValueError(f'Unknown reconstruction backend: {name!r}')
    return name


def capabilities(backend):
    name = backend_name(backend)
    return dict(backend=name, max_photos=40, uses_first_photo=name == 'trellis',
                capture=name != 'trellis', cover=name != 'trellis',
                gaussian=name != 'trellis', material_mode='pbr' if name == 'trellis' else 'original')


def run_backend(run):
    path = Path(run)/'result.json'
    return backend_name(json.loads(path.read_text()).get('backend', 'mvsam3d')) if path.is_file() else 'mvsam3d'


def validate_selection(backend, images, parent=None):
    if backend_name(backend) == 'trellis':
        if parent:
            raise ValueError('单图重建暂不支持补拍续建，请新建物体并选择一张照片')
        if not images:
            raise ValueError('请选择至少一张抠图正确的照片')


def pipeline_stages(backend):
    return ['queued', 'preparing', 'reconstruction'] if backend_name(backend) == 'trellis' else [
        'queued', 'preparing', 'da3', 'reconstruction', 'cover']
