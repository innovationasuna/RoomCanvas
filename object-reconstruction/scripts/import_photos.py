"""Append immutable originals and EXIF-normalized reconstruction PNGs."""
import errno
import json
import os
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageOps
from run import component


def import_photos(root, object_name, files, parent_run_id=None, image_prefix=None, *, create=False, filenames=None):
    directory = Path(root)/'data/inputs'/component(object_name)
    if create:
        if directory.exists():
            raise ValueError('这个名称已经有了，换一个')
        # Stage on the destination volume even when inputs is a separate mount.
        staging_parent = directory.parent if directory.parent.exists() else directory.parent.parent
        staging_parent.mkdir(parents=True, exist_ok=True)
    else:
        if not (directory/'images').is_dir():
            raise ValueError('Unknown input object')
        staging_parent = directory
    result = dict(images=[], errors=[], parent_run_id=parent_run_id)
    with tempfile.TemporaryDirectory(dir=staging_parent, prefix='.import-') as temp:
        staged = Path(temp)/'object'
        for kind in ('images', 'originals', 'imports'):
            (staged/kind).mkdir(parents=True)
        for index, source in enumerate(files or [], 1):
            filename = filenames[index - 1] if filenames is not None else Path(source).name
            image_id = (component(image_prefix) + (f'_{index:03d}' if len(files) > 1 else '')
                        if image_prefix else 'capture_' + uuid.uuid4().hex)
            try:
                with Image.open(source) as image:
                    if image.format not in ('JPEG', 'PNG'):
                        raise ValueError('Unsupported format')
                    ext = '.jpg' if image.format == 'JPEG' else '.png'
                    image.load()
                    normalized = ImageOps.exif_transpose(image).convert('RGB')
            except (OSError, ValueError, SyntaxError, Image.DecompressionBombError):
                result['errors'].append(dict(filename=filename, error='无法完整解码为 JPEG 或 PNG 照片'))
                continue
            original = Path('originals')/f'{image_id}{ext}'
            derived = Path('images')/f'{image_id}.png'
            with normalized:
                normalized.info.clear()
                normalized.save(staged/derived)
            if isinstance(source, (str, os.PathLike)):
                shutil.copyfile(source, staged/original)
            else:
                source.seek(0)
                with (staged/original).open('xb') as out:
                    shutil.copyfileobj(source, out)
            row = dict(name=image_id, original=str(directory/original), original_filename=filename,
                       display_name=image_id if image_prefix else filename,
                       image=str(directory/derived), parent_run_id=parent_run_id,
                       created_at=datetime.now(timezone.utc).isoformat(), exif_normalized=True)
            (staged/'imports'/f'{image_id}.json').write_text(json.dumps(row, ensure_ascii=False, indent=2))
            result['images'].append(row)
        if not result['images']:
            return result
        if create:
            directory.parent.mkdir(exist_ok=True)
            try:
                staged.rename(directory)
            except OSError as exc:
                if exc.errno in (errno.EEXIST, errno.ENOTEMPTY):
                    raise ValueError('这个名称已经有了，换一个') from None
                raise
        else:
            # A capture appends immutable files. Publish metadata first, then the visible PNGs.
            published = []
            try:
                for kind in ('originals', 'imports', 'images'):
                    (directory/kind).mkdir(exist_ok=True)
                    for source in (staged/kind).iterdir():
                        target = directory/kind/source.name
                        os.link(source, target)
                        published.append(target)
            except OSError:
                for path in reversed(published):
                    path.unlink()
                raise
    return result


def source_metadata(root, object_name, image_id):
    path = Path(root)/'data/inputs'/component(object_name)/'imports'/f'{component(image_id)}.json'
    return json.loads(path.read_text()) if path.is_file() else {}


def parent_selection(root, run_id):
    run = Path(root)/'runs'/component(run_id)
    if not (run/'reconstruction/result.glb').is_file():
        raise ValueError('Parent reconstruction is unavailable')
    inputs = json.loads((run/'inputs.json').read_text())
    name = inputs.get('object') or Path(inputs.get('source_input_dir', inputs['input_dir'])).name
    selected = [r.get('source_name', r['name']) for r in inputs['images']]
    return component(name), selected
