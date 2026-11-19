"""Lift a planar region out of a photograph as a straight-on texture.

    import rectify
    rectify.rectify_region(S, 12, [(880,300),(1310,290),(1320,560),(875,570)], "textures/monitor.png",
                           size_px=(1024, 640))

`quad_px` is the region's four corners in the STORED jpg, in order top-left, top-right,
bottom-right, bottom-left AS THE OBJECT IS ORIENTED (the phone was held portrait, so 'top' of a
monitor is usually the jpg's left or right edge — pick the corners by what they are on the object,
not on the page). Use the result for screens, notice boards, pictures, labels and the view through
a window; keep the aspect of `size_px` close to the object's real aspect so it is not stretched.

`rectify_image(path, quad, out, size)` does the same for ANY image file — an unposed close-up from
the operator's material, say — with the corners in that image's pixels as it displays upright
(its EXIF orientation applied; capture frames carry none, so for them that is the stored jpg).
HEIC is not readable here; convert it to JPEG first."""
from __future__ import annotations

import os

import numpy as np


def _homography(src, dst):
    A = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y, -u])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y, -v])
    _, _, vt = np.linalg.svd(np.array(A, dtype=np.float64))
    H = vt[-1].reshape(3, 3)
    return H / H[2, 2]


def rectify_region(S, i: int, quad_px, out_path: str, size_px=(1024, 1024)) -> str:
    """Warp the quad of frame i to a size_px image and save it. Returns out_path."""
    return rectify_image(S.rgb_path(i), quad_px, out_path, size_px)


def rectify_image(path, quad, out, size=(1024, 1024)) -> str:
    """Warp the quad of any image file to a `size` image and save it. Returns out."""
    from PIL import Image, ImageOps
    with Image.open(path) as image:
        img = ImageOps.exif_transpose(image).convert("RGB")
    W, Hh = size
    dst = [(0, 0), (W - 1, 0), (W - 1, Hh - 1), (0, Hh - 1)]
    # PIL's PERSPECTIVE wants the inverse map (output -> input) as 8 coefficients
    Hm = _homography(dst, [tuple(map(float, p)) for p in quad])
    coeffs = (Hm / Hm[2, 2]).flatten()[:8]
    warped = img.transform((W, Hh), Image.PERSPECTIVE, tuple(coeffs), Image.BICUBIC)
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    warped.save(out)
    return out
