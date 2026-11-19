"""Publish the immutable model contract before exposing it to readers.

The single asset.json rename is the commit point. COVER owns recommendations,
but never owns the transforms or material capabilities of a published model.
"""
from functools import lru_cache
import json
from pathlib import Path


class AssetUnavailableError(FileNotFoundError):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state


PLY_SIZES = {'char': 1, 'uchar': 1, 'int8': 1, 'uint8': 1, 'short': 2, 'ushort': 2, 'int16': 2, 'uint16': 2,
             'int': 4, 'uint': 4, 'int32': 4, 'uint32': 4, 'float': 4, 'float32': 4, 'double': 8, 'float64': 8}


@lru_cache(maxsize=256)
def _parses(path, size, mtime_ns, inode):
    """A PLY whose length its header cannot give (text rows, list properties) is whole when it parses.
    Keyed by the file's identity, so serving it again does not parse it again."""
    from plyfile import PlyData, PlyParseError
    try:
        PlyData.read(path)
    except (PlyParseError, ValueError, OSError):
        return False
    return True


def complete(file):
    """Whether a model file is whole: exactly as long as its GLB or binary PLY header says."""
    stat = file.stat()
    size = stat.st_size
    with file.open('rb') as stream:
        head = stream.read(12 if file.suffix == '.glb' else 65536)
    if file.suffix == '.glb':
        return len(head) == 12 and head[:4] == b'glTF' and int.from_bytes(head[8:], 'little') == size
    if file.suffix != '.ply':
        return size > 0
    end = head.find(b'end_header')
    if not head.startswith(b'ply') or end < 0 or b'\n' not in head[end:]:
        return False
    expected = head.index(b'\n', end) + 1
    lines = [line.split() for line in head[:end].decode('ascii', 'replace').splitlines()]
    try:
        if lines[1][1] not in ('binary_little_endian', 'binary_big_endian'):
            return _parses(str(file), size, stat.st_mtime_ns, stat.st_ino)  # text rows: no fixed length
        count = 0
        for words in lines:
            if words[:1] == ['element']:
                count = int(words[2])
            elif words[:1] == ['property']:
                if words[1] == 'list':
                    return _parses(str(file), size, stat.st_mtime_ns, stat.st_ino)  # variable-length rows
                expected += count * PLY_SIZES[words[1]]
    except (IndexError, KeyError, ValueError):
        return False
    return size == expected


def require_asset(run):
    run = Path(run)
    publication = run/'asset.json'
    if publication.is_file():
        try:
            data = json.loads(publication.read_text())
            if not isinstance(data, dict):
                raise ValueError('Invalid asset publication')
            files = data['files']
            if not isinstance(files, dict):
                raise ValueError('Invalid artifact list')
            if data.get('schema_version') != 1 or not files or 'result.glb' not in files:
                raise ValueError('Invalid asset publication')
            for name, size in files.items():
                if Path(name).name != name or size <= 0:
                    raise ValueError('Invalid artifact name or size')
                file = run/'reconstruction'/name
                # A file regenerated after publication (e.g. a collision proxy) stays usable while whole.
                if not file.is_file() or (file.stat().st_size != size and not complete(file)):
                    raise ValueError('Published artifact is missing or incomplete')
            if not data.get('assets', {}).get('glb', {}).get('transform'):
                raise ValueError('Missing stable model transform')
            return data
        except (ValueError, KeyError, TypeError, OSError) as exc:
            raise AssetUnavailableError('asset_failed', '物体资产发布不完整，请重新重建') from exc
    state = {}
    if (run/'result.json').is_file():
        try:
            state = json.loads((run/'result.json').read_text())
        except (ValueError, OSError):
            state = None  # judged by its model file alone
    if isinstance(state, dict) and state.get('asset_schema_version'):
        if state.get('status') == 'failed':
            raise AssetUnavailableError('asset_failed', '重建失败，模型尚未发布')
        raise AssetUnavailableError('asset_pending', '模型尚未完成资产发布，请稍后重试')
    # Older runs and manually imported GLBs predate asset.json and were served whatever their state
    # said; they still are, while their model file is whole.
    if not complete(run/'reconstruction/result.glb'):
        raise AssetUnavailableError('asset_failed', '模型文件不完整，请重新重建或导入')
    return None


def base_manifest(run):
    """A published contract wins over any later COVER output."""
    published = require_asset(run)
    if published is not None:
        return published
    path = Path(run)/'cover/preview.json'
    return json.loads(path.read_text()) if path.is_file() else {}


def preview_manifest(run):
    base = base_manifest(run)
    data = dict(base)
    path = Path(run)/'cover/preview.json'
    if path.is_file():
        recommendation = json.loads(path.read_text())
        for key in ('recommendation', 'status', 'message'):
            if key in recommendation:
                data[key] = recommendation[key]
    return data


def publish_asset(run):
    """Validate all required products, then atomically commit their stable contract."""
    from cover_scene import load_gaussians, load_scene, preview_manifest as make_manifest, write_json
    from dimensions import geometry
    from mvsam_pbr import material_capabilities
    import yaml

    run = Path(run)
    if (run/'asset.json').exists():
        return require_asset(run)
    for name in ('result.glb', 'result.ply', 'preview.glb', 'collision.glb'):
        file = run/'reconstruction'/name
        if name.startswith('result') and not file.is_file():
            raise ValueError(f'Missing reconstruction artifact: {name}')
        if file.is_file() and not complete(file):
            raise ValueError(f'Incomplete reconstruction artifact: {name}')
    # A damaged Gaussian model blocks publication; only a failed camera fit below may degrade.
    load_gaussians(run/'reconstruction/result.ply')
    capabilities = material_capabilities(run)
    config = yaml.safe_load((run/'config.yaml').read_text()) or {}
    if config.get('mesh_export', {}).get('mode') == 'baked_pbr' and not capabilities:
        raise ValueError('PBR material baking has not completed')
    try:
        scene = load_scene(run)
    except Exception:
        scene = None  # As COVER does: without a usable camera fit the model is still published, unaligned.
    data = make_manifest(run, scene)
    # Parse the actual GLB as well: a nonempty partial file cannot be published.
    geometry(run, manifest=data)
    data['files'] = {name: (run/'reconstruction'/name).stat().st_size
                     for name in ('result.glb', 'result.ply', 'preview.glb', 'collision.glb')
                     if (run/'reconstruction'/name).is_file()}
    data['capabilities'] = capabilities or dict(backend='mvsam3d', material_mode='vertex_color',
                                               capture=True, gaussian=True)
    write_json(run/'asset.json', data)
    return data
