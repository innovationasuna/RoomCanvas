"""Reuse valid masks; generate only missing masks, then prepare CPU previews."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

import yaml

from PIL import Image

from run import CODE, check_gpu, object_lease, selected_images, match_masks, write_json
from mask_images import preview


def file_signatures(rows):
    return [{key: [str(Path(row[key]).resolve()), Path(row[key]).stat().st_size,
                   Path(row[key]).stat().st_mtime_ns] for key in ('image', 'mask')}
            for row in rows]


def infer_missing(root, rows, work, lease):
    request = work/'request.json'
    write_json(request, dict(images=rows))
    env = os.environ.copy()
    # Do not leak the reconstruction environment's Python/CUDA paths into the
    # isolated segmenter. The selected GPU and shared cache remain inherited.
    for key in ('PYTHONPATH', 'PYTHONHOME', 'CONDA_PREFIX', 'CUDA_HOME', 'CPATH', 'LIBRARY_PATH', 'LD_LIBRARY_PATH'):
        env.pop(key, None)
    env.update(CUDA_VISIBLE_DEVICES=lease.uuid, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
    with (work/'inference.log').open('x') as log:
        completed = subprocess.run([str(root/'envs/birefnet/bin/python'),
            str(CODE/'scripts/birefnet_worker.py'), '--request', str(request),
            '--metrics', str(work/'inference.json')], env=env, stdout=log,
            stderr=subprocess.STDOUT, cwd=CODE, pass_fds=lease.fds)
    if completed.returncode:
        detail = ''
        if (work/'inference.json').exists():
            detail = json.loads((work/'inference.json').read_text()).get('error', '')
        raise RuntimeError(f'BiRefNet 推理失败：{detail or "请查看服务器 inference.log"}')


def prepare(root, name, selected, *, infer=None, wait_gpu=False, lock_fd=None):
    root = Path(root)
    task_id = datetime.now().strftime('%Y%m%d_%H%M%S_') + uuid.uuid4().hex[:8]
    work = root/'logs/masks'/task_id
    work.mkdir(parents=True)
    config = json.loads((CODE/'configs/birefnet.json').read_text())
    record = dict(status='preparing', object=name, selected=selected,
                  model=dict(model_id=config['model_id'], revision=config['revision']),
                  inference=dict(size=[1024, 1024], dtype='float16', batch_size=1,
                      eval=True, gradients=False, mean=[0.485, 0.456, 0.406],
                      std=[0.229, 0.224, 0.225], prediction='last.sigmoid',
                      probability_resize='bicubic', threshold=0.5, alpha=[0, 255],
                      exif_transpose=False),
                  reused=[], generated=[], previews=[], log_dir=str(work))
    started = time.monotonic()
    missing = []
    try:
        inputs = match_masks(selected_images(root, name, selected), allow_missing=True)
        record['reused'] = [r['name'] for r in inputs['images'] if r['mask']]
        missing = [dict(r, mask=str(Path(inputs['input_dir'])/'masks'/f'{r["name"]}.png'))
                   for r in inputs['images'] if not r['mask']]
        if missing:
            with object_lease(root, wait=wait_gpu, inherited=lock_fd) as lease:
                # Another preparation might have completed between the first
                # inspection and lock acquisition. Never overwrite its masks.
                inputs = match_masks(selected_images(root, name, selected), allow_missing=True)
                record['reused'] = [r['name'] for r in inputs['images'] if r['mask']]
                missing = [dict(r, mask=str(Path(inputs['input_dir'])/'masks'/f'{r["name"]}.png'))
                           for r in inputs['images'] if not r['mask']]
                if missing:
                    if infer is None:
                        runtime = yaml.safe_load((CODE/'configs/default.yaml').read_text())['runtime']
                        record['gpu'] = check_gpu(runtime['min_free_gib'], lease.uuid)
                    Path(inputs['input_dir'], 'masks').mkdir(parents=True, exist_ok=True)
                    write_json(work/'result.json', record)
                    if infer is None:
                        infer_missing(root, missing, work, lease)
                    else:
                        infer(missing)
                # subprocess.run has waited for the process to exit; release the
                # same GPU lock used by reconstruction before displaying previews.
        inputs = match_masks(selected_images(root, name, selected))
        for row in missing:
            with Image.open(row['mask']) as mask:
                if set(mask.getchannel('A').getdata()) - {0, 255}:
                    raise ValueError(f'{row["name"]}: generated alpha must be binary')
        record['generated'] = [r['name'] for r in missing]
        previews = root/'cache/mask_previews'/task_id
        previews.mkdir(parents=True)
        for row in inputs['images']:
            target = previews/f'{row["name"]}.png'
            preview(row['image'], row['mask'], target)
            record['previews'].append(dict(name=row['name'], path=str(target)))
        record.update(status='complete', images=inputs['images'], signatures=file_signatures(inputs['images']))
    except BaseException as exc:
        record.update(status='failed', error=str(exc))
        # Preserve successes from a partially failed worker for reuse on retry.
        record['generated'] = [r['name'] for r in missing if Path(r['mask']).is_file()]
        raise
    finally:
        record['elapsed_seconds'] = round(time.monotonic() - started, 3)
        write_json(work/'result.json', record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--object', required=True)
    parser.add_argument('--images', nargs='+', required=True, help='Photo stems, without extensions')
    parser.add_argument('--wait-gpu', action='store_true', help='Wait for the GPU lock instead of failing')
    parser.add_argument('--lock-fd', type=int, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        result = prepare(Path(os.environ['VIEWFORGE_ROOT']).resolve(), args.object, args.images,
                         wait_gpu=args.wait_gpu, lock_fd=args.lock_fd)
    except Exception as exc:
        print(json.dumps(dict(status='failed', error=str(exc)), ensure_ascii=False), flush=True)
        sys.exit(1)
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
