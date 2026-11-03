"""Experimental fixed-mesh TRELLIS material inference; never starts the object service.

Run with the existing TRELLIS interpreter and runtime environment. All model weights
are local. Source runs stay read-only; only a new trial directory is written.
"""
import argparse
from contextlib import ExitStack
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--trial', type=Path, required=True)
    parser.add_argument('--gpu', required=True, help='Exactly one GPU UUID')
    parser.add_argument('--source', nargs=2, action='append', metavar=('LABEL', 'RUN'), required=True)
    parser.add_argument('--resolution', type=int, choices=(512, 1024), default=512)
    args = parser.parse_args()
    if ',' in args.gpu or not args.gpu.startswith('GPU-'):
        raise ValueError('Use exactly one GPU UUID')
    home, trial = args.home.resolve(), args.trial.resolve()
    trial.mkdir(exist_ok=True)
    receipt_path = trial/'experiment.json'
    if receipt_path.exists():
        raise FileExistsError('Use a new trial directory; do not overwrite a prior experiment')
    receipt = dict(status='preparing', method='trellis_fixed_mv_mesh_texturing',
                   resolution=args.resolution, texture_size=2048, seed=42, gpu=args.gpu,
                   normal_prediction=False, sources=[], worker_sha256=sha(__file__))
    started = time.monotonic()
    def save():
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n')
    save()
    try:
        # Model imports and CUDA contexts are created only after acquiring both locks.
        with ExitStack() as stack:
            locks = [home/'runtime/object-reconstruction/cache/gpu.lock', home/f'runtime/gpu-{args.gpu}.lock']
            # The scene lock uses the physical GPU index, resolved from this exact UUID.
            query = subprocess.check_output(['nvidia-smi', f'--id={args.gpu}',
                '--query-gpu=index,memory.free', '--format=csv,noheader,nounits'], text=True).strip()
            rows = query.splitlines()
            if len(rows) != 1:
                raise RuntimeError('Expected exactly one authorized GPU')
            index, _ = [part.strip() for part in rows[0].split(',')]
            locks[1] = home/f'runtime/gpu-{index}.lock'
            for path in locks:
                handle = stack.enter_context(path.open('a'))
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            free = int(subprocess.check_output(['nvidia-smi', f'--id={args.gpu}',
                '--query-gpu=memory.free', '--format=csv,noheader,nounits'], text=True).strip())
            if free < 22*1024:
                raise RuntimeError(f'GPU is not idle enough: {free} MiB free; need 22 GiB')
            os.environ.update(CUDA_VISIBLE_DEVICES=args.gpu, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                              OMP_NUM_THREADS='4', MKL_NUM_THREADS='4',
                              ATTN_BACKEND='xformers', SPARSE_ATTN_BACKEND='xformers',
                              PYTORCH_CUDA_ALLOC_CONF='expandable_segments:True')
            receipt.update(status='running', gpu_index=int(index), initial_free_mib=free,
                           locks=[str(path) for path in locks])
            save()
            import numpy as np
            from PIL import Image
            import torch
            import trimesh
            from scipy.ndimage import distance_transform_edt
            from trellis2.pipelines import Trellis2TexturingPipeline
            from trellis2.pipelines import rembg
            import trellis2.pipelines.trellis2_texturing as native

            torch.backends.cudnn.enabled = False
            class ConfirmedMaskOnly:
                def __init__(self, **_kwargs):
                    pass
                def to(self, _device):
                    return self
                def cpu(self):
                    return self
                def __call__(self, _image):
                    raise RuntimeError('The confirmed input must already have a nontrivial alpha mask')
            original_rembg = rembg.BiRefNet
            rembg.BiRefNet = ConfirmedMaskOnly
            try:
                model_dir = trial/'model'
                model_dir.mkdir()
                weights = home/'backends/weights/trellis2'
                (model_dir/'ckpts').symlink_to(weights/'ckpts', target_is_directory=True)
                config = json.loads((weights/'texturing_pipeline.json').read_text())
                other = '1024' if args.resolution == 512 else '512'
                config['args']['models'].pop(f'tex_slat_flow_model_{other}')
                config['args']['image_cond_model']['args']['model_name'] = str(home/'backends/weights/dinov3')
                config['args']['low_vram'] = True
                (model_dir/'texturing_pipeline.json').write_text(json.dumps(config, indent=2)+'\n')
                receipt['model_config'] = config
                receipt['upstream_revision'] = subprocess.check_output(
                    ['git', '-C', str(home/'backends/TRELLIS.2'), 'rev-parse', 'HEAD'], text=True).strip()
                save()
                model_started = time.monotonic()
                pipeline = Trellis2TexturingPipeline.from_pretrained(str(model_dir), config_file='texturing_pipeline.json')
                pipeline.cuda()
                receipt['model_load_seconds'] = round(time.monotonic()-model_started, 3)
            finally:
                rembg.BiRefNet = original_rembg

            # Native preprocess_mesh drops the original UV. Restore it on its transformed
            # working copy, so postprocess samples the new material onto the original atlas.
            original_preprocess = pipeline.preprocess_mesh
            def preserve_uv(mesh):
                uv = mesh.visual.uv.copy()
                working = original_preprocess(mesh.copy())
                working.visual = trimesh.visual.TextureVisuals(uv=uv)
                return working
            pipeline.preprocess_mesh = preserve_uv
            original_encode = pipeline.encode_shape_slat
            original_decode = pipeline.decode_tex_slat
            original_postprocess = pipeline.postprocess_mesh
            def writable_normal_postprocess(mesh, pbr_voxel, resolution=1024, texture_size=1024):
                class WorkingMesh:
                    def __getattr__(self, name):
                        return getattr(mesh, name)
                    @property
                    def vertex_normals(self):
                        # The installed trimesh exposes cached normals read-only;
                        # upstream rotates this array in place. Give it a working copy.
                        return np.array(mesh.vertex_normals, copy=True)
                return original_postprocess(WorkingMesh(), pbr_voxel, resolution, texture_size)
            pipeline.postprocess_mesh = writable_normal_postprocess
            current_output = None
            def encode_and_checkpoint(mesh, resolution=1024):
                stage_started = time.monotonic()
                receipt['current_stage'] = 'shape_encoding'
                save()
                result = original_encode(mesh, resolution)
                torch.save(dict(feats=result.feats.cpu(), coords=result.coords.cpu(), resolution=resolution,
                    geometry_sha256=hashlib.sha256(mesh.vertices.tobytes()+mesh.faces.tobytes()).hexdigest()),
                    current_output/'shape-slat.pt')
                receipt['sources'][-1]['shape_encoding_seconds'] = round(time.monotonic()-stage_started, 3)
                receipt['current_stage'] = 'texture_sampling_and_export'
                save()
                return result
            pipeline.encode_shape_slat = encode_and_checkpoint
            def decode_and_checkpoint(slat):
                result = original_decode(slat)
                torch.save(dict(feats=result.feats.cpu(), coords=result.coords.cpu(), resolution=args.resolution),
                           current_output/'texture-voxel.pt')
                receipt['current_stage'] = 'uv_material_export'
                save()
                return result
            pipeline.decode_tex_slat = decode_and_checkpoint

            # Pad only uncovered atlas pixels; avoid the long native Telea gap fill.
            original_cv2 = native.cv2
            class AtlasPadding:
                def __init__(self):
                    self.key, self.nearest = None, None
                def __getattr__(self, key):
                    return getattr(original_cv2, key)
                def inpaint(self, image, mask, _radius, _method):
                    holes = np.asarray(mask) != 0
                    if holes.all():
                        raise ValueError('No covered texture pixels')
                    if not holes.any():
                        result = image.copy()
                        return result[..., 0] if result.ndim == 3 and result.shape[-1] == 1 else result
                    key = hashlib.sha256(holes.tobytes()).hexdigest()
                    if key != self.key:
                        self.nearest = distance_transform_edt(holes, return_distances=False, return_indices=True)
                        self.key = key
                    result = image.copy()
                    result[holes] = image[tuple(self.nearest[:, holes])]
                    # Native cv2.inpaint returns HxW for HxWx1 input, and upstream
                    # adds the singleton channel back. Preserve that shape contract.
                    return result[..., 0] if result.ndim == 3 and result.shape[-1] == 1 else result
            native.cv2 = AtlasPadding()
            try:
                for label, run_name in args.source:
                    run = Path(run_name).resolve()
                    model = run/'reconstruction/result.glb'
                    output = trial/'outputs'/label
                    output.mkdir(parents=True, exist_ok=False)
                    current_output = output
                    item_started = time.monotonic()
                    source = dict(label=label, run=str(run), model_sha256=sha(model), status='running')
                    receipt['sources'].append(source)
                    save()
                    inputs = json.loads((run/'inputs.json').read_text())['images']
                    if len(inputs) != 1:
                        raise ValueError('This controlled trial requires exactly one original photo')
                    photo_path, mask_path = Path(inputs[0]['image']), Path(inputs[0]['mask'])
                    source.update(image_sha256=sha(photo_path), mask_sha256=sha(mask_path))
                    with Image.open(photo_path) as photo, Image.open(mask_path) as mask:
                        if photo.size != mask.size or mask.mode != 'RGBA':
                            raise ValueError('Expected a same-size confirmed RGBA mask')
                        reference = photo.convert('RGBA')
                        reference.putalpha(mask.getchannel('A'))
                        if reference.getchannel('A').getextrema() != (0, 255):
                            raise ValueError('Expected a nonempty foreground and transparent background')
                        reference.save(output/'reference.png')
                    scene = trimesh.load_scene(model, process=False)
                    instances = scene.dump()
                    if len(instances) != 1:
                        raise ValueError('This UV-preserving trial requires one mesh instance')
                    mesh = instances[0].copy()
                    if mesh.visual.uv is None:
                        raise ValueError('Source mesh has no UV')
                    source.update(triangles=len(mesh.faces), vertices=len(mesh.vertices),
                                  uv_sha256=hashlib.sha256(mesh.visual.uv.tobytes()).hexdigest())
                    original_uv = mesh.visual.uv.copy()
                    torch.cuda.reset_peak_memory_stats()
                    inference_started = time.monotonic()
                    result = pipeline.run(mesh, reference, seed=42, resolution=args.resolution, texture_size=2048)
                    inference_seconds = time.monotonic()-inference_started
                    uv_error = float(np.abs(result.visual.uv-original_uv).max())
                    if len(result.faces) != len(mesh.faces) or uv_error > 1e-6:
                        raise RuntimeError('Texturing did not preserve the source UV/topology')
                    material = result.visual.material
                    material.baseColorTexture.save(output/'predicted-basecolor.png')
                    material.metallicRoughnessTexture.save(output/'predicted-metallic-roughness.png')
                    mr = np.asarray(material.metallicRoughnessTexture)
                    source.update(status='complete', inference_seconds=round(inference_seconds, 3),
                        elapsed_seconds=round(time.monotonic()-item_started, 3), uv_max_error=uv_error,
                        peak_allocated_mib=round(torch.cuda.max_memory_allocated()/2**20, 1),
                        source_file_unchanged=sha(model)==source['model_sha256'],
                        material_maps=dict(roughness='G', metallic='B', normal=False),
                        roughness_quantiles=np.quantile(mr[..., 1]/255, [0, .1, .5, .9, 1]).tolist(),
                        metallic_quantiles=np.quantile(mr[..., 2]/255, [0, .1, .5, .9, 1]).tolist())
                    if not source['source_file_unchanged']:
                        raise RuntimeError('Source file changed')
                    (output/'result.json').write_text(json.dumps(source, indent=2)+'\n')
                    save()
                    print(json.dumps(source), flush=True)
                    del result, mesh
                    torch.cuda.empty_cache()
            finally:
                pipeline.preprocess_mesh = original_preprocess
                pipeline.encode_shape_slat = original_encode
                pipeline.decode_tex_slat = original_decode
                pipeline.postprocess_mesh = original_postprocess
                native.cv2 = original_cv2
            receipt['status'] = 'complete'
    except BaseException as exc:
        receipt.update(status='failed', error=str(exc))
        raise
    finally:
        receipt['elapsed_seconds'] = round(time.monotonic()-started, 3)
        save()


if __name__ == '__main__':
    main()
