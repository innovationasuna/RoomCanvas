import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
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

    def test_gpu_memory_is_checked_once_the_lock_is_ours(self):
        """While another job holds the lock it also holds the memory; --wait-gpu waits for it."""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for path in ('weights/da3-nested-giant-large/x', 'weights/sam3d/pipeline.yaml',
                         'third_party/dinov2/hubconf.py'):
                (root/path).parent.mkdir(parents=True, exist_ok=True)
                (root/path).touch()
            lock_path = root/'gpu.lock'
            holder = lock_path.open('a')
            fcntl.flock(holder, fcntl.LOCK_EX)
            checked, errors = [], []
            def check_gpu(_):
                checked.append(holder.closed)
                return 'GPU-test'
            def main():
                try:
                    runner.main()
                except RuntimeError as exc:
                    errors.append(str(exc))
            argv = ['run.py', '--object', 'chair', '--attempt', 'a01', '--wait-gpu']
            env = dict(VIEWFORGE_ROOT=str(root), VIEWFORGE_GPU_LOCK=str(lock_path))
            with patch.dict(runner.os.environ, env), patch.object(sys, 'argv', argv), \
                 patch.object(runner, 'input_manifest', return_value=dict(images=[{}])), \
                 patch.object(runner, 'check_gpu', side_effect=check_gpu), \
                 patch.object(runner, 'stage_inputs', side_effect=RuntimeError('stop here')):
                thread = threading.Thread(target=main)
                thread.start()
                time.sleep(.2)
                self.assertEqual(checked, [])
                holder.close()
                thread.join(5)
            self.assertEqual((checked, errors), ([True], ['stop here']))

    def test_trellis_waits_for_both_locks_before_checking_memory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shared = root/'gpu.lock'
            room = root/'runtime/locks/gpu-GPU-test.lock'
            room.parent.mkdir(parents=True)
            holder = room.open('a')
            fcntl.flock(holder, fcntl.LOCK_EX)
            resolved, checked, errors = threading.Event(), [], []

            def locked(path):
                with path.open('a') as probe:
                    try:
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:
                        return True
                    return False

            def query(command, **_):
                if '--query-gpu=uuid' in command:
                    resolved.set()
                    return 'GPU-test\n'
                self.assertIn('--query-gpu=uuid,memory.free', command)
                checked.append((holder.closed, locked(shared), locked(room)))
                return f'GPU-test, {24576 if holder.closed else 512}\n'

            def main():
                try:
                    runner.main()
                except Exception as exc:
                    errors.append(str(exc))

            argv = ['run.py', '--backend', 'trellis', '--object', 'chair', '--wait-gpu']
            env = dict(VIEWFORGE_ROOT=str(root), VIEWFORGE_GPU_LOCK=str(shared), CUDA_VISIBLE_DEVICES='0')
            with patch.dict(runner.os.environ, env), patch.object(sys, 'argv', argv), \
                 patch.object(runner, 'input_manifest', return_value=dict(images=[{}])), \
                 patch('run_trellis.runtime_paths', return_value=(root, None, None)), \
                 patch.object(runner.subprocess, 'check_output', side_effect=query), \
                 patch.object(runner, 'stage_inputs', side_effect=RuntimeError('stop here')):
                thread = threading.Thread(target=main, daemon=True)
                thread.start()
                try:
                    self.assertTrue(resolved.wait(3), 'GPU identity must resolve while the room GPU is busy')
                    self.assertEqual(checked, [])
                    self.assertTrue(locked(shared))
                finally:
                    holder.close()
                    thread.join(5)
                self.assertFalse(thread.is_alive())
            self.assertEqual((checked, errors), ([(True, True, True)], ['stop here']))
            self.assertFalse(locked(shared))
            self.assertFalse(locked(room))

    def test_busy_room_lock_releases_object_lock_without_starting_trellis(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shared = root/'gpu.lock'
            room = root/'runtime/locks/gpu-GPU-test.lock'
            room.parent.mkdir(parents=True)
            argv = ['run.py', '--backend', 'trellis', '--object', 'chair']
            env = dict(VIEWFORGE_ROOT=str(root), VIEWFORGE_GPU_LOCK=str(shared))
            with room.open('a') as holder:
                fcntl.flock(holder, fcntl.LOCK_EX)
                with patch.dict(runner.os.environ, env), patch.object(sys, 'argv', argv), \
                     patch.object(runner, 'input_manifest', return_value=dict(images=[{}])), \
                     patch('run_trellis.runtime_paths', return_value=(root, None, None)), \
                     patch.object(runner, 'gpu_uuid', return_value='GPU-test'), \
                     patch.object(runner, 'check_gpu') as memory:
                    with self.assertRaises(BlockingIOError):
                        runner.main()
                    memory.assert_not_called()
                self.assertFalse((root/'runs').exists())
                with shared.open('a') as probe:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == '__main__':
    unittest.main()
