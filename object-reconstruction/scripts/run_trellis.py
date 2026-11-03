"""Use the room pipeline's TRELLIS.2 launcher for one masked ViewForge photo.

The model and interpreter remain in ROOMCANVAS_HOME; outputs stay in this run.
No DA3, Gaussian, COVER, image generation API or shared service is started here.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess

from PIL import Image
import yaml
from reconstruction_backends import backend_name, validate_selection

CODE = Path(__file__).resolve().parents[1]
CHECKOUT = CODE.parent


def runtime_paths():
    value = os.environ.get('ROOMCANVAS_HOME')
    if not value:
        raise ValueError('Set ROOMCANVAS_HOME to the existing room reconstruction runtime')
    home = Path(value).resolve()
    python = Path(os.environ.get('TRELLIS_PYTHON', str(home/'runtime/trellis-env/bin/python')))
    launcher = CHECKOUT/'room-reconstruction/server/trellis_local.py'
    for path in (python, launcher, home/'backends/TRELLIS.2/trellis2',
                 home/'backends/weights/trellis2/pipeline.json', home/'backends/weights/dinov3/config.json',
                 home/'backends/weights/sparse-decoder/ckpts/ss_dec_conv3d_16l8_fp16.json'):
        if not path.exists():
            raise FileNotFoundError(f'TRELLIS.2 runtime is missing: {path}')
    return home, python, launcher


def prepare_reference(inputs, destination):
    """Combine original RGB with the confirmed alpha, preserving dark foreground."""
    rows = inputs['images']
    if not rows:
        raise ValueError('TRELLIS.2 experiment requires a confirmed photo')
    row = rows[0]
    with Image.open(row['image']) as photo, Image.open(row['mask']) as mask:
        if photo.size != mask.size or mask.mode != 'RGBA':
            raise ValueError('Expected a same-size RGBA mask')
        alpha = mask.getchannel('A')
        bounds = alpha.getbbox()
        if bounds is None:
            raise ValueError('Object mask is empty')
        rgba = photo.convert('RGBA')
        rgba.putalpha(alpha)
        foreground = rgba.crop(bounds)
        side = max(max(foreground.size)+2, math.ceil(max(foreground.size)*1.2))
        canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
        canvas.paste(foreground, ((side-foreground.width)//2, (side-foreground.height)//2))
        canvas.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        canvas.save(destination)
    return dict(source_image_id=row.get('source_name', row['name']), crop=list(bounds),
                reference=str(destination), method='confirmed_photo_rgba', input_views=1,
                unused_image_ids=[r.get('source_name', r['name']) for r in rows[1:]])


def launch_command(run, cfg, reference):
    backend_name(cfg.get('backend', 'trellis'))
    home, python, launcher = runtime_paths()
    options = cfg.get('trellis', {})
    command = [str(python), str(launcher), '-i', str(reference),
               '-o', str(run/'reconstruction/result.glb'), '--seed', str(cfg['seed']),
               '--decimation', str(options.get('decimation', 50000)),
               '--texture-size', str(options.get('texture_size', 2048)),
               '--skip-rembg', '--no-skip-floor-wall']
    if options.get('pipeline_type'):
        command += ['--pipeline-type', str(options['pipeline_type'])]
    env = dict(os.environ)
    env.setdefault('OMP_NUM_THREADS', '4')
    env.setdefault('MKL_NUM_THREADS', '4')
    # The API runs in MV-SAM3D's environment. Native libraries must come from TRELLIS's.
    for key in ('CPATH', 'LIBRARY_PATH', 'PYTHONHOME'):
        env.pop(key, None)
    prefix = python.parent.parent
    env.update(ROOMCANVAS_HOME=str(home), CONDA_PREFIX=str(prefix),
               LITEREALITY_WEIGHTS=str(home/'backends/weights'),
               LITEREALITY_DINOV3=str(home/'backends/weights/dinov3'),
               PYTHONPATH=os.pathsep.join([str(CHECKOUT/'room-reconstruction/src'), str(home/'backends/TRELLIS.2')]),
               PATH=str(python.parent)+os.pathsep+env.get('PATH', ''),
               CUDA_HOME=str(home/'runtime/cuda-12.4'),
               LD_LIBRARY_PATH=os.pathsep.join([str(home/'runtime/cuda-12.4/lib'),
                   str(prefix/'lib/python3.11/site-packages/nvidia/cuda_nvrtc/lib'),
                   str(home/'runtime/system-libs/lib/usr/lib/x86_64-linux-gnu')]),
               HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    return command, env


def write_manifest(run):
    # o_voxel.to_glb already exports glTF Y-up. Do not reuse SAM3D's display rotation.
    transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    manifest = dict(status='unsupported', message='此单图结果暂不提供补拍建议；可填写实测尺寸后放入房间。',
                    assets=dict(glb=dict(transform=transform)), recommendation=None)
    (run/'cover').mkdir()
    (run/'cover/preview.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args()
    run = args.run_dir.resolve()
    cfg = yaml.safe_load((run/'config.yaml').read_text())
    inputs = json.loads((run/'inputs.json').read_text())
    validate_selection(cfg.get('backend', 'trellis'), inputs['images'])
    out = run/'reconstruction'
    out.mkdir(exist_ok=False)
    reference = out/'reference.png'
    receipt = prepare_reference(inputs, reference)
    command, env = launch_command(run, cfg, reference)
    receipt.update(backend='trellis', launcher=str(Path(command[1]).relative_to(CHECKOUT)),
                   seed=cfg['seed'], options=cfg.get('trellis', {}),
                   adapter_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                   launcher_sha256=hashlib.sha256(Path(command[1]).read_bytes()).hexdigest())
    (out/'generation.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n')
    subprocess.run(command, env=env, check=True, cwd=CHECKOUT)
    model = out/'result.glb'
    # The shared launcher reports per-image failures in its log but can still exit 0.
    if not model.is_file() or model.stat().st_size < 20 or model.read_bytes()[:4] != b'glTF':
        raise RuntimeError('TRELLIS.2 did not produce a GLB; see logs/reconstruction.log')
    # Keep the full textured GLB. The existing decimator converts PBR to vertex colours.
    write_manifest(run)


if __name__ == '__main__':
    main()
