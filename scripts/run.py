"""Run native DA3 and MV-SAM3D with external inputs and a fresh output directory."""
import argparse
import csv
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import yaml
from PIL import Image

CODE = Path(__file__).resolve().parents[1]


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def component(value):
    if not re.fullmatch(r'[\w][\w.-]{0,79}', value):
        raise ValueError(f'Expected a simple directory name, got {value!r}')
    return value


def natural_name(path):
    try:
        return (0, int(path.stem), path.stem)
    except ValueError:
        return (1, 0, path.stem)


def selected_images(root, name, selected=None):
    """List/validate photos independently of mask availability (no EXIF rotation)."""
    directory = root/'data/inputs'/component(name)
    images = sorted((p for p in (directory/'images').iterdir() if p.is_file()
                     and p.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp', '.bmp')), key=natural_name)
    if not images or len({p.stem for p in images}) != len(images):
        raise ValueError('Expected images with distinct filename stems')
    if selected is not None:
        if not selected or len(selected) != len(set(selected)):
            raise ValueError('Select at least one distinct image')
        unknown = set(selected) - {p.stem for p in images}
        if unknown:
            raise ValueError(f'Unknown image names: {sorted(unknown)}')
        images = [p for p in images if p.stem in selected]
    entries = []
    for path in images:
        if path.suffix not in ('.png', '.jpg'):
            raise ValueError(f'MV-SAM3D input requires lowercase .png/.jpg: {path}')
        try:
            with Image.open(path) as rgb:
                rgb.load()
        except (OSError, ValueError) as exc:
            raise ValueError(f'{path.stem}: invalid image: {exc}') from exc
        entries.append(dict(name=path.stem, image=str(path.absolute())))
    return dict(input_dir=str(directory.resolve()), mask_prompt='masks', images=entries)


def match_masks(inputs, allow_missing=False):
    directory = Path(inputs['input_dir'])
    entries = []
    for row in inputs['images']:
        path = Path(row['image'])
        candidates = [directory/'masks'/f'{row["name"]}{suffix}'
                      for suffix in ('.png', '_mask.png', '.jpg', '_mask.jpg')]
        masks = [p for p in candidates if p.exists() or p.is_symlink()]
        if not masks and allow_missing:
            entries.append(dict(row, mask=None))
            continue
        if len(masks) != 1:
            raise ValueError(f'{row["name"]}: expected exactly one matching mask; found {len(masks)}')
        try:
            with Image.open(path) as rgb, Image.open(masks[0]) as mask:
                mask.load()
                if rgb.size != mask.size or mask.mode != 'RGBA' or mask.getchannel('A').getbbox() is None:
                    raise ValueError('expected a same-size RGBA mask with nonempty alpha')
        except (OSError, ValueError) as exc:
            raise ValueError(f'{row["name"]}: invalid mask {masks[0].name}: {exc}') from exc
        entries.append(dict(row, mask=str(masks[0].absolute())))
    return dict(inputs, images=entries)


def input_manifest(root, name, selected=None):
    return match_masks(selected_images(root, name, selected))


def check_gpu(min_free_gib):
    visible = os.environ.get('CUDA_VISIBLE_DEVICES', '')
    if not visible or ',' in visible or visible == '-1':
        raise ValueError('Set CUDA_VISIBLE_DEVICES to exactly one authorized GPU')
    output = subprocess.check_output(['nvidia-smi', f'--id={visible}',
        '--query-gpu=uuid,memory.free', '--format=csv,noheader,nounits'], text=True)
    rows = list(csv.reader(output.splitlines()))
    if len(rows) != 1 or float(rows[0][1]) < float(min_free_gib)*1024:
        raise RuntimeError('Insufficient free GPU memory; other jobs will not be stopped')
    return rows[0][0].strip()


def stage_commands(root, run, cfg, inputs):
    return [
        ('da3', [sys.executable, str(CODE/'scripts/run_da3.py'),
                 '--image_dir', str(Path(inputs['input_dir'])/'images'),
                 '--output_dir', str(run/'da3'), '--model_path', str(root/'weights'/cfg['da3']['model']),
                 '--process_res', str(cfg['da3']['process_res']), '--no_vis']),
        ('reconstruction', [sys.executable, str(CODE/'scripts/run_reconstruction.py'),
                            '--root', str(root), '--run-dir', str(run)]),
    ]


def execute(run, commands, result):
    result.update(status='running', stages={})
    try:
        for stage, command in commands:
            result['current_stage'] = stage
            write_json(run/'result.json', result)
            print(f'START {stage}: {run}', flush=True)
            with (run/'logs'/f'{stage}.log').open('x') as log:
                completed = subprocess.run(command, cwd=CODE, stdout=log, stderr=subprocess.STDOUT)
            result['stages'][stage] = completed.returncode
            if completed.returncode:
                raise RuntimeError(f'{stage} failed; see logs/{stage}.log')
        for name in ('result.glb', 'result.ply'):
            if not (run/'reconstruction'/name).is_file() or not (run/'reconstruction'/name).stat().st_size:
                raise RuntimeError(f'Missing reconstruction artifact: {name}')
        result.update(status='complete', mesh='reconstruction/result.glb')
    except BaseException as exc:
        result.update(status='failed', error=str(exc))
        raise
    finally:
        result.pop('current_stage', None)
        write_json(run/'result.json', result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--object', default='stuffed_toy')
    parser.add_argument('--attempt', default='a01')
    parser.add_argument('--config', type=Path, default=CODE/'configs/default.yaml')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--images', nargs='+', help='Image stems to reconstruct; default: all')
    args = parser.parse_args()
    root = Path(os.environ['VIEWFORGE_ROOT']).resolve()
    name, attempt = component(args.object), component(args.attempt)
    cfg = yaml.safe_load(args.config.read_text())
    inputs = input_manifest(root, name, args.images)
    for path in (root/'weights'/cfg['da3']['model'], root/'weights/sam3d/pipeline.yaml',
                 root/'third_party/dinov2/hubconf.py'):
        if not path.exists():
            raise FileNotFoundError(path)
    gpu = check_gpu(cfg['runtime']['min_free_gib'])
    if args.check:
        print(json.dumps(dict(status='preflight_passed', images=len(inputs['images']), gpu=gpu)))
        return
    lock_path = Path(os.environ.get('VIEWFORGE_GPU_LOCK', str(root/'cache/gpu.lock')))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        check_gpu(cfg['runtime']['min_free_gib'])
        run = root/'runs'/f'{datetime.now():%Y%m%d}_{name}_{attempt}'
        run.mkdir(parents=True, exist_ok=False)
        (run/'logs').mkdir()
        if args.images is not None:
            # Both DA3 and MV must see exactly the selected views, in the same order.
            subset = run/'input'
            for folder in ('images', 'masks'):
                (subset/folder).mkdir(parents=True)
            for row in inputs['images']:
                for key, folder in (('image', 'images'), ('mask', 'masks')):
                    source = Path(row[key])
                    (subset/folder/source.name).symlink_to(source)
            inputs['source_input_dir'] = inputs['input_dir']
            inputs['input_dir'] = str(subset)

        (run/'config.yaml').write_text(yaml.safe_dump(cfg, sort_keys=False))
        write_json(run/'inputs.json', inputs)
        result = dict(gpu=gpu, code_revision=subprocess.check_output(['git', '-C', str(CODE),
            'rev-parse', 'HEAD'], text=True).strip(),
            upstream_versions=json.loads((CODE/'configs/upstream_versions.json').read_text()))
        execute(run, stage_commands(root, run, cfg, inputs), result)
        print(f'COMPLETE {run}', flush=True)


if __name__ == '__main__':
    main()
