import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
SPEC = importlib.util.spec_from_file_location('layout_runner', Path(__file__).resolve().parents[1]/'scripts/run.py')
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
SPEC_MV = importlib.util.spec_from_file_location('local_reconstruction', Path(__file__).resolve().parents[1]/'scripts/run_reconstruction.py')
reconstruction = importlib.util.module_from_spec(SPEC_MV)
SPEC_MV.loader.exec_module(reconstruction)


class RunnerTests(unittest.TestCase):
    def test_backend_timing_is_persistable(self):
        result = {'timing': {'started_at': 'start'}}
        runner.finish_timing(result, time.monotonic() - 1)
        self.assertGreaterEqual(result['timing']['elapsed_seconds'], 1)
        self.assertIn('finished_at', result['timing'])

    def test_manifest_order_and_mask_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'data/inputs/toy'
            for folder in ('images', 'masks'):
                (directory/folder).mkdir(parents=True)
            for name in ('10', '2', '1'):
                Image.new('RGB', (2, 2)).save(directory/'images'/f'{name}.png')
                Image.new('RGBA', (2, 2), (255, 255, 255, 255)).save(directory/'masks'/f'{name}.png')
            result = runner.input_manifest(root, 'toy')
            self.assertEqual([row['name'] for row in result['images']], ['1', '2', '10'])
            Image.new('L', (2, 2), 255).save(directory/'masks/1.png')
            with self.assertRaisesRegex(ValueError, 'RGBA'):
                runner.input_manifest(root, 'toy')
            (directory/'masks/1.png').unlink()
            with self.assertRaisesRegex(ValueError, 'exactly one matching mask'):
                runner.input_manifest(root, 'toy')
            Image.new('RGBA', (2, 2), (255, 255, 255, 255)).save(directory/'masks/1_mask.png')
            self.assertTrue(runner.input_manifest(root, 'toy')['images'][0]['mask'].endswith('1_mask.png'))
            Image.new('RGBA', (2, 2), (255, 255, 255, 255)).save(directory/'masks/1.png')
            with self.assertRaisesRegex(ValueError, 'exactly one matching mask'):
                runner.input_manifest(root, 'toy')

    def test_selected_views(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "data/inputs/toy"
            for folder in ("images", "masks"):
                (directory / folder).mkdir(parents=True)
            for name in ("1", "2", "10"):
                Image.new("RGB", (2, 2)).save(directory / "images" / f"{name}.png")
                Image.new("RGBA", (2, 2), (255, 255, 255, 255)).save(directory / "masks" / f"{name}_mask.png")
            inputs = runner.input_manifest(root, "toy", ["10", "1"])
            self.assertEqual([row["name"] for row in inputs["images"]], ["1", "10"])
            for selected in ([], ["1", "1"], ["missing"]):
                with self.assertRaises(ValueError):
                    runner.input_manifest(root, "toy", selected)

    def test_no_path_escape(self):
        for value in ('../old', '/absolute', '.', '..', 'x/y'):
            with self.assertRaises(ValueError):
                runner.component(value)
        self.assertEqual(runner.component('玩偶-a02'), '玩偶-a02')

    def test_single_view_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'data/inputs/toy'
            (directory/'images').mkdir(parents=True)
            (directory/'masks').mkdir()
            Image.new('RGB', (2, 2)).save(directory/'images/1.png')
            Image.new('RGBA', (2, 2), (255, 255, 255, 255)).save(directory/'masks/1_mask.png')
            self.assertEqual(len(runner.input_manifest(root, 'toy')['images']), 1)

    def test_reconstruction_success_and_failure(self):
        for exit_code in (0, 1):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as temporary:
                run = Path(temporary)
                (run/'logs').mkdir()
                (run/'reconstruction').mkdir()
                for name in ('result.glb', 'result.ply'):
                    (run/'reconstruction'/name).write_bytes(b'test fixture')
                command = ['fake-reconstruction']
                outcomes = [subprocess.CompletedProcess(command, exit_code)]
                result = {}
                with patch.object(runner.subprocess, 'run', side_effect=outcomes) as mocked:
                    if exit_code:
                        with self.assertRaises(RuntimeError):
                            runner.execute(run, [('reconstruction', command)], result)
                    else:
                        runner.execute(run, [('reconstruction', command)], result)
                    self.assertEqual(mocked.call_count, 1)
                saved = json.loads((run/'result.json').read_text())
                self.assertEqual(saved['status'], 'failed' if exit_code else 'complete')
    def test_options_pass_through_without_benchmark_restrictions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run = root/'run'
            run.mkdir()
            options = dict(stage1_weighting=False, stage2_weighting=False, stage2_weight_source='visibility')
            (run/'config.yaml').write_text(yaml.safe_dump(dict(seed=42, mv=options)))
            (run/'inputs.json').write_text(json.dumps(dict(input_dir=str(root), mask_prompt='masks', images=[dict(name='1')])))
            upstream = SimpleNamespace(run_weighted_inference=lambda **kwargs: None)
            with patch.dict(sys.modules, run_inference_weighted=upstream), \
                 patch.object(sys, 'argv', ['run_reconstruction.py', '--root', str(root), '--run-dir', str(run)]), \
                 patch.object(reconstruction, 'prepare_pipeline'), \
                 patch.object(reconstruction.os, 'chdir'), \
                 patch.object(upstream, 'run_weighted_inference') as call:
                reconstruction.main()
                for key, value in options.items():
                    self.assertEqual(call.call_args.kwargs[key], value)


if __name__ == '__main__':
    unittest.main()
