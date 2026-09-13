"""Append immutable originals and EXIF-normalized reconstruction PNGs."""
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from PIL import Image, ImageOps
from run import component


def import_photos(root, object_name, files, parent_run_id=None):
    directory = Path(root)/'data/inputs'/component(object_name)
    if not (directory/'images').is_dir():
        raise ValueError('Unknown input object')
    result = dict(images=[], errors=[], parent_run_id=parent_run_id)
    for source in files or []:
        source = Path(source)
        image_id = 'capture_' + uuid.uuid4().hex
        original = None
        derived = None
        metadata = None
        try:
            with Image.open(source) as image:
                if image.format not in ('JPEG', 'PNG'):
                    raise ValueError('Only JPEG and PNG are supported')
                image.load()
                ext = '.jpg' if image.format == 'JPEG' else '.png'
                normalized = ImageOps.exif_transpose(image).convert('RGB')
                normalized.info.clear()
            (directory/'originals').mkdir(exist_ok=True)
            (directory/'imports').mkdir(exist_ok=True)
            original = directory/'originals'/f'{image_id}{ext}'
            with original.open('xb') as out, source.open('rb') as inp:
                import shutil
                shutil.copyfileobj(inp, out)
            derived = directory/'images'/f'{image_id}.png'
            pending = directory/'imports'/f'{image_id}.pending'
            normalized.save(pending, format='PNG')
            row = dict(name=image_id, original=str(original), original_filename=source.name,
                       image=str(derived), parent_run_id=parent_run_id,
                       created_at=datetime.now(timezone.utc).isoformat(), exif_normalized=True)
            metadata = directory/'imports'/f'{image_id}.json'
            with metadata.open('x') as out:
                json.dump(row, out, ensure_ascii=False, indent=2)
            # Publish only a fully decoded PNG; unique id, no historical replacement.
            pending.rename(derived)
            result['images'].append(row)
        except Exception as exc:
            # Originals already accepted remain available for diagnosis/retry.
            result['errors'].append(dict(filename=source.name, error=str(exc)))
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
