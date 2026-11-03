"""Run the existing scene launcher with experimental multi-reference conditioning."""
import argparse
import hashlib
import json
from pathlib import Path
import runpy
import sys

from PIL import Image

from trellis_multi import MAX_VIEWS, MIN_VIEWS, MODES, replace_method, run_multi_image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--references', type=Path, required=True)
    parser.add_argument('--fusion-mode', choices=MODES, required=True)
    parser.add_argument('--shared-launcher', type=Path, required=True)
    args, shared_args = parser.parse_known_args()
    references = json.loads(args.references.read_text())['images']
    if not MIN_VIEWS <= len(references) <= MAX_VIEWS:
        raise ValueError('Multi-image experiment requires 2–4 confirmed references')
    images = []
    for reference in references:
        with Image.open(reference['path']) as image:
            images.append(image.convert('RGBA'))
    from litereality_agent.models.trellis import inference
    original_generate = inference.generate

    def generate(pipeline, image_path, output_path, **options):
        if image_path.resolve() != Path(references[0]['path']).resolve():
            raise ValueError('The shared launcher must receive the first reference, not a folder')
        native_run = pipeline.run
        stats = dict(status='running', input_views=len(images), fusion_mode=args.fusion_mode,
                     image_ids=[reference['id'] for reference in references])
        report = output_path.parent/'multiview.json'

        def run(_pipeline, _image, **parameters):
            output, used = run_multi_image(pipeline, images, mode=args.fusion_mode,
                                           native_run=native_run, **parameters)
            stats.update(used)
            return output

        try:
            with replace_method(pipeline, 'run', run):
                original_generate(pipeline, image_path, output_path, **options)
            stats['status'] = 'complete'
        except BaseException as exc:
            stats.update(status='failed', error=str(exc))
            raise
        finally:
            stats['sampler_sha256'] = hashlib.sha256(Path(__file__).with_name('trellis_multi.py').read_bytes()).hexdigest()
            report.write_text(json.dumps(stats, ensure_ascii=False, indent=2)+'\n')

    previous_argv = sys.argv
    inference.generate = generate
    try:
        sys.argv = [str(args.shared_launcher), *shared_args]
        runpy.run_path(str(args.shared_launcher), run_name='__main__')
    finally:
        sys.argv = previous_argv
        inference.generate = original_generate


if __name__ == '__main__':
    main()
