"""Optional native colour baking for MV-SAM3D; no GPU imports at module load."""
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import time


def export_settings(config):
    options = dict(config.get('mesh_export', {}))
    mode = options.get('mode', 'vertex_color')
    if mode not in ('vertex_color', 'baked_pbr'):
        raise ValueError(f'Unknown MV-SAM3D mesh export mode: {mode}')
    if mode == 'vertex_color':
        return None
    size = options.get('texture_size', 2048)
    if size not in (512, 1024, 2048, 4096):
        raise ValueError('Texture size must be 512, 1024, 2048 or 4096')
    values = dict(roughness=float(options.get('roughness', 1.0)),
                  metallic=float(options.get('metallic', 0.0)))
    if any(not math.isfinite(value) or not 0 <= value <= 1 for value in values.values()):
        raise ValueError('Material factors must be finite values between 0 and 1')
    padding = options.get('texture_padding', 'nearest')
    if padding not in ('native', 'nearest'):
        raise ValueError('Texture padding must be native or nearest')
    return dict(mode=mode, texture_size=size, gaussian_backend='gsplat', gaussian_packed=False,
                texture_padding=padding, **values)


def pad_texture(image, mask):
    """Fill only unobserved UV gaps; retain every covered texel exactly."""
    import numpy as np
    from scipy.ndimage import distance_transform_edt
    holes = np.asarray(mask) != 0
    if holes.all():
        raise ValueError('Texture has no covered UV texels')
    result = image.copy()
    if holes.any():
        nearest = distance_transform_edt(holes, return_distances=False, return_indices=True)
        result[holes] = image[tuple(nearest[:, holes])]
    return result


def render_observations(sample, resolution=512, nviews=30):
    """Use upstream cameras and its existing gsplat renderer, with one RGB background per camera."""
    from sam3d_objects.model.backbone.tdfy_dit.utils import render_utils
    from sam3d_objects.model.backbone.tdfy_dit.renderers import gaussian_render
    cams = [render_utils.sphere_hammersley_sequence(i, nviews) for i in range(nviews)]
    extrinsics, intrinsics = render_utils.yaw_pitch_r_fov_to_extrinsics_intrinsics(
        [cam[0] for cam in cams], [cam[1] for cam in cams], 2, 40)
    # The installed gsplat packed path disagrees with its per-camera background
    # shape check. Its supported unpacked path keeps the same rendering equation.
    native_rasterization = gaussian_render.rasterization
    def rasterization(*args, **kwargs):
        return native_rasterization(*args, **dict(kwargs, packed=False))
    gaussian_render.rasterization = rasterization
    try:
        result = render_utils.render_frames(sample, extrinsics, intrinsics,
            dict(resolution=resolution, bg_color=[(0, 0, 0)], backend='gsplat'), verbose=False)
    finally:
        gaussian_render.rasterization = native_rasterization
    return result['color'], extrinsics, intrinsics


@contextmanager
def native_baking_support(module, output, texture_padding='native'):
    """Select an installed native renderer and retain completed UV work for diagnosis/retry."""
    import numpy as np
    original_views, original_uv = module.render_multiview, module.parametrize_mesh
    cache = Path(output)/'baking-uv.npz'
    original_cv = getattr(module, 'cv2', None)
    if texture_padding == 'nearest':
        class Padding:
            def __getattr__(self, name):
                return getattr(original_cv, name)
            def inpaint(self, image, mask, _radius, _method):
                print('[MV PBR] Padding uncovered UV texels by nearest covered texel', flush=True)
                return pad_texture(image, mask)
        module.cv2 = Padding()

    def parametrize(vertices, faces):
        digest = hashlib.sha256(vertices.tobytes()+faces.tobytes()).hexdigest()
        if cache.is_file():
            with np.load(cache, allow_pickle=False) as data:
                if str(data['source_sha256']) == digest:
                    print('[MV PBR] Reusing verified UV cache', flush=True)
                    return data['vertices'].copy(), data['faces'].copy(), data['uvs'].copy()
        result = original_uv(vertices, faces)
        np.savez_compressed(cache, source_sha256=digest, vertices=result[0], faces=result[1], uvs=result[2])
        print('[MV PBR] UV parameterization completed and saved', flush=True)
        return result

    module.render_multiview, module.parametrize_mesh = render_observations, parametrize
    try:
        yield
    finally:
        module.render_multiview, module.parametrize_mesh = original_views, original_uv
        if texture_padding == 'nearest':
            module.cv2 = original_cv


@contextmanager
def baked_export(module, output, settings):
    """Retain a vertex-colour control, and delegate actual baking to upstream."""
    original = module.to_glb
    receipt = dict(status='pending', material_mode='pbr', method='native_gaussian_colour_baking',
                   predicted_material_maps=False, mesh_postprocess=False, **settings)
    output = Path(output)

    def export(app_rep, mesh, **kwargs):
        started = time.monotonic()
        receipt['status'] = 'running'
        try:
            if app_rep is not None and hasattr(app_rep, 'save_ply'):
                import numpy as np
                # These are run-local checkpoints, never a replacement for source weights.
                app_rep.save_ply(str(output/'baking-gaussian.ply'))
                np.savez_compressed(output/'baking-mesh.npz',
                    vertices=mesh.vertices.detach().cpu().numpy(), faces=mesh.faces.detach().cpu().numpy(),
                    vertex_attrs=mesh.vertex_attrs.detach().cpu().numpy())
                render_observations(app_rep, resolution=64, nviews=1)  # Detect renderer errors before costly UV.
            control = original(app_rep, mesh, **dict(kwargs, with_mesh_postprocess=False,
                               with_texture_baking=False, use_vertex_color=True))
            control.export(str(output/'vertex-color.glb'))
            print('[MV PBR] Baking native Gaussian colour observations into a texture', flush=True)
            result = original(app_rep, mesh, **dict(kwargs, with_mesh_postprocess=False,
                              with_texture_baking=True, use_vertex_color=False,
                              texture_size=settings['texture_size']))
            material = result.visual.material
            material.roughnessFactor = settings['roughness']
            material.metallicFactor = settings['metallic']
            if material.baseColorTexture is None:
                raise RuntimeError('Native baking returned no base-colour texture')
            receipt.update(status='complete', texture_dimensions=list(material.baseColorTexture.size),
                           control_sha256=hashlib.sha256((output/'vertex-color.glb').read_bytes()).hexdigest())
            return result
        except BaseException as exc:
            receipt.update(status='failed', error=str(exc))
            raise
        finally:
            receipt['elapsed_seconds'] = round(time.monotonic()-started, 3)
            (output/'materials.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n')

    module.to_glb = export
    try:
        yield receipt
    finally:
        module.to_glb = original
