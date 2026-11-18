"""Float32 DA3 arrays in OpenCV camera coordinates (+x right, +y down, +z forward)."""
import numpy as np


def depth_to_pointmap(depth, intrinsics, out=None):
    depth = np.asarray(depth, dtype=np.float32)
    intrinsics = np.asarray(intrinsics, dtype=np.float32)
    if depth.ndim != 2 or intrinsics.shape != (3, 3):
        raise ValueError('Expected depth (H,W) and intrinsics (3,3)')
    height, width = depth.shape
    fx, fy = intrinsics[0, 0], intrinsics[1, 1]
    if not np.isfinite(intrinsics).all() or fx <= 0 or fy <= 0:
        raise ValueError('Invalid camera intrinsics')
    if out is None:
        out = np.empty((height, width, 3), dtype=np.float32)
    # Broadcast one row and one column; no integer grids or float64 promotion.
    np.multiply(depth, np.arange(width, dtype=np.float32)-intrinsics[0, 2], out=out[..., 0])
    out[..., 0] /= fx
    np.multiply(depth, (np.arange(height, dtype=np.float32)-intrinsics[1, 2])[:, None], out=out[..., 1])
    out[..., 1] /= fy
    out[..., 2] = depth
    return out


def pointmap_to_sam3d_format(pointmap):
    """A channel-first view only; SAM3D itself performs the PyTorch3D axis flip."""
    return np.asarray(pointmap, dtype=np.float32).transpose(2, 0, 1)


def pointmaps_from_depth(depth, intrinsics):
    depth = np.asarray(depth, dtype=np.float32)
    if depth.ndim != 3 or len(intrinsics) != len(depth):
        raise ValueError('Expected matching batches of depth and intrinsics')
    points = np.empty((*depth.shape, 3), dtype=np.float32)
    for index in range(len(depth)):
        depth_to_pointmap(depth[index], intrinsics[index], out=points[index])
    return points


def load_da3_arrays(path):
    """Read schema 2 or historical NPZs; expose the old NCHW key without a copy."""
    with np.load(path, allow_pickle=False) as source:
        if 'pointmaps' in source:
            points = np.asarray(source['pointmaps'], dtype=np.float32)
            if points.ndim != 4 or points.shape[-1] != 3:
                raise ValueError('Expected pointmaps (N,H,W,3)')
            points = points.transpose(0, 3, 1, 2)
        elif 'pointmaps_sam3d' in source:
            points = np.asarray(source['pointmaps_sam3d'], dtype=np.float32)
            if points.ndim != 4 or points.shape[1] != 3:
                raise ValueError('Expected legacy pointmaps_sam3d (N,3,H,W)')
        else:
            raise ValueError(f'No pointmaps found in DA3 output: {path}')
        result = dict(pointmaps_sam3d=points)
        for name in ('extrinsics', 'intrinsics', 'image_files'):
            if name in source:
                result[name] = source[name]
        return result
