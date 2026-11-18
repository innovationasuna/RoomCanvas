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
                if not file.is_file() or file.stat().st_size != size:
                    raise ValueError('Published artifact is missing or incomplete')
            if not data.get('assets', {}).get('glb', {}).get('transform'):
                raise ValueError('Missing stable model transform')
            return data
        except (ValueError, KeyError, TypeError, OSError) as exc:
            raise AssetUnavailableError('asset_failed', '物体资产发布不完整，请重新重建') from exc
    state_path = run/'result.json'
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text())
        except (ValueError, OSError) as exc:
            raise AssetUnavailableError('asset_failed', '无法读取重建状态') from exc
        if state.get('status') == 'failed':
            raise AssetUnavailableError('asset_failed', '重建失败，模型尚未发布')
        if state.get('asset_schema_version') or state.get('status') != 'complete':
            raise AssetUnavailableError('asset_pending', '模型尚未完成资产发布，请稍后重试')
    # Historical completed runs and manually imported GLBs predate result.json.
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
    scene = load_scene(run)
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
