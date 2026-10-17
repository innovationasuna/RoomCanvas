"""Image-space mask conversion; deliberately do not apply EXIF transpose."""
import os
from pathlib import Path
import tempfile

import numpy as np
from PIL import Image


def save_prediction(image_path, probability, destination):
    """Restore float probabilities, threshold at 0.5, publish without replacement."""
    probability = np.asarray(probability, dtype=np.float32)
    if probability.ndim != 2 or not np.isfinite(probability).all():
        raise ValueError('Invalid probability map')
    destination = Path(destination)
    with Image.open(image_path) as source:
        rgb = source.convert('RGB')
    restored = Image.fromarray(probability).resize(rgb.size, Image.Resampling.BICUBIC)
    alpha = Image.fromarray((np.asarray(restored) >= 0.5).astype(np.uint8) * 255)
    if alpha.getbbox() is None:
        raise ValueError(f'{destination.stem}: empty foreground')
    rgb.putalpha(alpha)
    destination.parent.mkdir(parents=True, exist_ok=True)
    # A same-directory hard link publishes only a fully written PNG and refuses
    # to replace any existing file, including a dangling symlink.
    fd, temporary = tempfile.mkstemp(prefix='.birefnet-', suffix='.png', dir=destination.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            rgb.save(output, format='PNG')
        os.link(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)


def preview(image_path, mask_path, destination):
    with Image.open(image_path) as source, Image.open(mask_path) as mask:
        rgb = source.convert('RGB')
        rgb.thumbnail((640, 640))
        alpha = mask.getchannel('A').resize(rgb.size, Image.Resampling.NEAREST)
        # Downstream treats every alpha > 0 as foreground, including reused masks.
        alpha = alpha.point(lambda value: 95 if value > 0 else 0)
        tint = Image.new('RGB', rgb.size, (25, 210, 155))
        Image.composite(tint, rgb, alpha).save(destination, format='PNG')
