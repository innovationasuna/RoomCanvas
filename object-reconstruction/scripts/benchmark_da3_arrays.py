"""Compare old/new DA3 array allocation and serialization using an existing run (CPU)."""
import argparse
import json
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import time
import numpy as np
from da3_arrays import pointmaps_from_depth, load_da3_arrays


def legacy(depth, intrinsics):
    points, channel_first = [], []
    for d, k in zip(depth, intrinsics):
        v, u = np.meshgrid(np.arange(d.shape[0]), np.arange(d.shape[1]), indexing='ij')
        p = np.stack([(u-k[0, 2])*d/k[0, 0], (v-k[1, 2])*d/k[1, 1], d], axis=-1)
        points.append(p)
        channel_first.append(p.transpose(2, 0, 1))
    return np.stack(points), np.stack(channel_first)


def measure(path, mode):
    with np.load(path, allow_pickle=False) as source:
        depth, intrinsics = source['depth'], source['intrinsics']
        extra = {k: source[k] for k in ('extrinsics', 'intrinsics', 'image_files', 'process_res') if k in source}
    started = time.perf_counter()
    if mode == 'legacy':
        points, sam3d = legacy(depth, intrinsics)
        arrays = dict(depth=depth, pointmaps=points, pointmaps_sam3d=sam3d, **extra)
    else:
        points = pointmaps_from_depth(depth, intrinsics)
        arrays = dict(depth=depth.astype(np.float32), pointmaps=points, **extra)
    build = time.perf_counter()-started
    with tempfile.TemporaryDirectory() as temp:
        file = Path(temp)/'arrays.npz'
        started = time.perf_counter()
        np.savez(file, **arrays)
        save = time.perf_counter()-started
        started = time.perf_counter()
        if mode == 'legacy':
            with np.load(file, allow_pickle=False) as source:
                consumed = source['pointmaps_sam3d'].astype(np.float32)
        else:
            consumed = load_da3_arrays(file)['pointmaps_sam3d']
        load = time.perf_counter()-started
        return dict(mode=mode, build_seconds=build, save_seconds=save, load_seconds=load,
                    file_bytes=file.stat().st_size, pointmap_bytes=sum(v.nbytes for k, v in arrays.items() if k.startswith('pointmap')),
                    peak_rss_bytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == 'darwin' else 1024),
                    consumed_shape=list(consumed.shape))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input-npz', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--case', choices=['legacy', 'current'], help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.case:
        print(json.dumps(measure(args.input_npz, args.case)))
        return
    records = [json.loads(subprocess.check_output([sys.executable, __file__, '--input-npz', str(args.input_npz), '--case', mode], text=True))
               for mode in ('legacy', 'current')]
    with np.load(args.input_npz, allow_pickle=False) as source:
        reference, _ = legacy(source['depth'], source['intrinsics'])
        actual = pointmaps_from_depth(source['depth'], source['intrinsics'])
    difference = np.abs(reference-actual)
    result = dict(measurements=records, max_absolute_error=float(difference.max()),
                  max_relative_error=float((difference / np.maximum(np.abs(reference), 1e-12)).max()),
                  coordinate_system='opencv', consumers=['MV-SAM3D: NCHW transpose view',
                      'COVER and pose alignment: unchanged depth/extrinsics/intrinsics'])
    if not np.allclose(reference, actual, rtol=2e-7, atol=2e-6):
        raise ValueError('Float32 pointmap error exceeded tolerance')
    encoded = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.write_text(encoded)
    print(encoded, end='')


if __name__ == '__main__':
    main()
