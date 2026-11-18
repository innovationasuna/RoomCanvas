"""Publish the immutable model contract before exposing it to readers.

The single asset.json rename is the commit point. COVER owns recommendations,
but never owns the transforms or material capabilities of a published model.
"""
import json
from pathlib import Path


class AssetUnavailableError(FileNotFoundError):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state


def complete(file):
    """Whether a model file is whole: a GLB must be as long as its header says, anything else nonempty."""
    size = file.stat().st_size
    if file.suffix != '.glb':
        return size > 0
    with file.open('rb') as stream:
        head = stream.read(12)
    return len(head) == 12 and head[:4] == b'glTF' and int.from_bytes(head[8:], 'little') == size


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
    # said: a finished one is served as before, any other only while its model file is whole.
    if not (isinstance(state, dict) and state.get('status', 'complete') == 'complete'):
        if not complete(run/'reconstruction/result.glb'):
            raise AssetUnavailableError('asset_failed', '重建未完成，模型文件不完整')
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
    from cover_scene import load_scene, preview_manifest as make_manifest, write_json
    from dimensions import geometry
    from mvsam_pbr import material_capabilities
    import yaml

    run = Path(run)
    if (run/'asset.json').exists():
        return require_asset(run)
    for name in ('result.glb', 'result.ply'):
        file = run/'reconstruction'/name
        if not file.is_file() or not file.stat().st_size:
            raise ValueError(f'Missing reconstruction artifact: {name}')
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
