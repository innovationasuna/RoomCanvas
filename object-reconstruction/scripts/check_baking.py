"""Exercise native baking rasterization, texture gradients and Gaussian rendering on one GPU."""
import json
import os

from mvsam_pbr import render_observations, require_baking_dependencies


def main():
    require_baking_dependencies()
    import nvdiffrast
    import nvdiffrast.torch as dr
    import torch
    os.environ['ATTN_BACKEND'] = os.environ['SPARSE_ATTN_BACKEND'] = 'xformers'
    from sam3d_objects.model.backbone.tdfy_dit.representations import Gaussian

    pos = torch.tensor([[[-.8, -.8, 0, 1], [.8, -.8, 0, 1], [0, .8, 0, 1]]],
                       device='cuda', dtype=torch.float32)
    triangles = torch.tensor([[0, 1, 2]], device='cuda', dtype=torch.int32)
    uv = torch.tensor([[[0, 0], [1, 0], [.5, 1]]], device='cuda', dtype=torch.float32)
    texture = torch.ones((1, 8, 8, 3), device='cuda', requires_grad=True)
    raster, _ = dr.rasterize(dr.RasterizeCudaContext(), pos, triangles, [32, 32])
    coordinates, _ = dr.interpolate(uv, raster, triangles)
    colour = dr.texture(texture, coordinates, filter_mode='linear') * (raster[..., 3:] > 0)
    colour.sum().backward()
    assert torch.isfinite(texture.grad).all() and texture.grad.abs().sum() > 0

    sample = Gaussian(aabb=[-.5, -.5, -.5, 1, 1, 1], sh_degree=0)
    sample.from_xyz(torch.tensor([[0., 0., 0.]], device='cuda'))
    sample.from_scaling(torch.full((1, 3), .1, device='cuda'))
    sample.from_rotation(torch.tensor([[1., 0., 0., 0.]], device='cuda'))
    sample.from_opacity(torch.full((1, 1), .8, device='cuda'))
    sample.from_features(torch.zeros((1, 1, 3), device='cuda'))
    images, _, _ = render_observations(sample, resolution=64, nviews=2)
    assert len(images) == 2 and all(image.shape == (64, 64, 3) for image in images)
    print(json.dumps(dict(status='ok', nvdiffrast=nvdiffrast.__version__,
                         gpu=torch.cuda.get_device_name(0), rasterization=True,
                         texture_gradients=True, gaussian_views=len(images))))


if __name__ == '__main__':
    main()
