"""Call upstream MV-SAM3D using local weights and a run-local output path."""
import argparse
import json
import os
from pathlib import Path
import sys
from contextlib import ExitStack

import yaml
from mvsam_pbr import baked_export, export_settings, native_baking_support, require_baking_dependencies

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
    material_settings = export_settings(cfg)
    if material_settings:
        require_baking_dependencies()
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
    if material_settings:
        from sam3d_objects.model.backbone.tdfy_dit.utils import postprocessing_utils
    with ExitStack() as stack:
        if material_settings:
            stack.enter_context(native_baking_support(postprocessing_utils, out, material_settings['texture_padding']))
            receipt = stack.enter_context(baked_export(postprocessing_utils, out, material_settings))
        upstream.run_weighted_inference(input_path=Path(inputs['input_dir']),
            mask_prompt=inputs['mask_prompt'], image_names=[row['name'] for row in inputs['images']],
            da3_output_path=str(run/'da3/da3_output.npz'), model_tag='local',
            seed=cfg['seed'], decode_formats=['gaussian', 'mesh'], **cfg['mv'])
    if material_settings:
        if receipt['status'] != 'complete':
            raise RuntimeError('MV-SAM3D did not complete native PBR colour baking')
    # Collision data is independent of display materials, including default PBR.
    # A failed quality check retains that component's exact geometry.
    try:
        from collision_proxy import generate_collision_proxy
        print('Collision proxy:', json.dumps(generate_collision_proxy(run)), flush=True)
    except Exception as exc:
        print(f'Collision proxy unavailable: {exc}', flush=True)
    if material_settings:
        # Colour previews remain optional; PBR display always retains its texture.
        return
    # A preview is optional: a failed simplification must not discard a valid
    # reconstruction or prevent the full GLB from being viewed.
    try:
        from preview_glb import generate_preview
        print('GLB preview:', json.dumps(generate_preview(run)), flush=True)
    except Exception as exc:
        print(f'GLB preview unavailable: {exc}', flush=True)


if __name__ == '__main__':
    main()
