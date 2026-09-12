"""Call upstream MV-SAM3D using local weights and a run-local output path."""
import argparse
import json
import os
from pathlib import Path
import sys

import yaml

CODE = Path(__file__).resolve().parents[1]


def prepare_pipeline(root, out):
    weights = root/'weights/sam3d'
    local = out/'checkpoints/local'
    local.mkdir(parents=True, exist_ok=False)
    pipeline = yaml.safe_load((weights/'pipeline.yaml').read_text())
    for key, value in pipeline.items():
        if key.endswith(('_config_path', '_ckpt_path')) and value:
            pipeline[key] = str(weights/value)

    def local_dino(node):
        if isinstance(node, dict):
            if str(node.get('_target_', '')).endswith('.dino.Dino'):
                node.update(repo_or_dir=str(root/'third_party/dinov2'), source='local')
            for child in node.values():
                local_dino(child)
        elif isinstance(node, list):
            for child in node:
                local_dino(child)

    for key in ('ss_generator_config_path', 'slat_generator_config_path'):
        source = Path(pipeline[key])
        config = yaml.safe_load(source.read_text())
        local_dino(config)
        destination = local/source.name
        destination.write_text(yaml.safe_dump(config, sort_keys=False))
        pipeline[key] = str(destination)
    pipeline['depth_model'] = None  # Use the already computed external DA3 pointmaps.
    (local/'pipeline.yaml').write_text(yaml.safe_dump(pipeline, sort_keys=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--run-dir', type=Path, required=True)
    args = parser.parse_args()
    root, run = args.root.resolve(), args.run_dir.resolve()
    cfg = yaml.safe_load((run/'config.yaml').read_text())
    inputs = json.loads((run/'inputs.json').read_text())
    out = run/'reconstruction'
    out.mkdir(exist_ok=False)
    prepare_pipeline(root, out)
    os.environ['ATTN_BACKEND'] = os.environ['SPARSE_ATTN_BACKEND'] = 'xformers'
    sys.path[:0] = [str(CODE), str(CODE/'notebook')]
    import run_inference_weighted as upstream

    # Only redirect output; model execution and algorithm options stay upstream-owned.
    upstream.get_output_dir = lambda *args, **kwargs: out
    os.chdir(out)
    upstream.run_weighted_inference(input_path=Path(inputs['input_dir']),
        mask_prompt=inputs['mask_prompt'], image_names=[row['name'] for row in inputs['images']],
        da3_output_path=str(run/'da3/da3_output.npz'), model_tag='local',
        seed=cfg['seed'], decode_formats=['gaussian', 'mesh'], **cfg['mv'])


if __name__ == '__main__':
    main()
