"""Backend contracts shared by the runner and API; no GPU imports."""
import json
import os
from pathlib import Path

TRELLIS_BACKENDS = ('trellis', 'trellis_multi')
# Historical multi-reference results remain readable; new jobs use these two backends.
BACKENDS = ('mvsam3d', 'trellis')


def backend_name(value=None, *, allow_retired=False):
    name = value or os.environ.get('VIEWFORGE_BACKEND', 'mvsam3d')
    if name == 'trellis_multi' and not allow_retired:
        raise ValueError('多图 TRELLIS 实验已停用，请使用 trellis（单图）或 mvsam3d')
    if name not in ('mvsam3d', *TRELLIS_BACKENDS):
        raise ValueError(f'Unknown reconstruction backend: {name!r}')
    return name


def capabilities(backend):
    name = backend_name(backend, allow_retired=True)
    trellis = name in TRELLIS_BACKENDS
    result = dict(backend=name, max_photos=40, uses_first_photo=name == 'trellis',
                  capture=not trellis, cover=not trellis,
                  gaussian=not trellis, material_mode='pbr' if trellis else 'original')
    if name == 'trellis_multi':
        result.update(min_photos=2, max_photos=4, uses_all_photos=True,
                      conditioning='unposed_multi_reference', experimental=True, retired=True)
    return result


def run_backend(run):
    path = Path(run)/'result.json'
    return backend_name(json.loads(path.read_text()).get('backend', 'mvsam3d'), allow_retired=True) if path.is_file() else 'mvsam3d'


def run_capabilities(run):
    result = capabilities(run_backend(run))
    receipt = Path(run)/'reconstruction/materials.json'
    if result['backend'] == 'mvsam3d' and receipt.is_file():
        material = json.loads(receipt.read_text())
        if material.get('status') == 'complete' and material.get('method') == 'native_gaussian_colour_baking':
            result.update(material_mode='pbr', material_source='baked_colour_fixed_factors',
                          predicted_material_maps=False)
    return result


def validate_selection(backend, images, parent=None):
    name = backend_name(backend)
    if name in TRELLIS_BACKENDS:
        if parent:
            raise ValueError('TRELLIS 实验暂不支持补拍续建，请新建物体')
        if not images:
            raise ValueError('请选择至少一张抠图正确的照片')


def pipeline_stages(backend):
    return ['queued', 'preparing', 'reconstruction'] if backend_name(backend, allow_retired=True) in TRELLIS_BACKENDS else [
        'queued', 'preparing', 'da3', 'reconstruction', 'cover']
