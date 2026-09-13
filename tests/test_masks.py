"""Mask preparation contract, exercised without a model or GPU."""
from contextlib import ExitStack
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from PIL import Image
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import run as runner
import prepare_masks
from mask_state import Confirmation
from mask_images import save_prediction


class MaskTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / 'data/inputs/toy'
        (self.directory / 'images').mkdir(parents=True)
        for name in ('1', '3', '5'):
            Image.new('RGB', (19, 13), (31, 72, 93)).save(self.directory / 'images' / f'{name}.png')

    def mask(self, name, suffix='.png', size=(19, 13), mode='RGBA', alpha=255):
        target = self.directory / 'masks' / f'{name}{suffix}'
        target.parent.mkdir(exist_ok=True)
        Image.new(mode, size, (31, 72, 93, alpha) if mode == 'RGBA' else 255).save(target)
        return target

    @staticmethod
    def generate(rows):
        for row in rows:
            target = Path(row['mask'])
            target.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(row['image']) as source:
                rgba = source.convert('RGBA')
                rgba.putalpha(255)
                rgba.save(target)

    def test_probability_restores_original_rgb_and_binary_alpha(self):
        source = self.directory / 'images/1.png'
        target = self.directory / 'masks/1.png'
        probability = np.array([[0.0, 0.0001, 0.9], [0.0, 0.0001, 1.0]], dtype=np.float32)
        save_prediction(source, probability, target)
        with Image.open(source) as rgb, Image.open(target) as result:
            self.assertEqual(result.size, rgb.size)
            self.assertEqual(result.mode, 'RGBA')
            np.testing.assert_array_equal(np.asarray(result.convert('RGB')), np.asarray(rgb))
            values = np.asarray(result.getchannel('A'))
            self.assertEqual(set(np.unique(values)), {0, 255})
            self.assertTrue((values[:, 0] == 0).all())
            self.assertTrue((values[:, -1] == 255).all())
            restored = np.asarray(Image.fromarray(probability).resize(rgb.size, Image.Resampling.BICUBIC))
            np.testing.assert_array_equal(values > 0, restored >= 0.5)

    def test_probability_conversion_refuses_overwrite(self):
        target = self.mask('1')
        before = target.read_bytes()
        with self.assertRaises(FileExistsError):
            save_prediction(self.directory / 'images/1.png', np.ones((2, 2)), target)
        self.assertEqual(target.read_bytes(), before)

    def test_empty_and_nonfinite_prediction_do_not_publish(self):
        target = self.directory / 'masks/1.png'
        for probability in (np.zeros((2, 2)), np.full((2, 2), np.nan)):
            with self.subTest(probability=probability.tolist()), self.assertRaises(ValueError):
                save_prediction(self.directory / 'images/1.png', probability, target)
            self.assertFalse(target.exists())

    def test_images_without_masks_are_selectable_but_not_reconstructable(self):
        manifest = runner.selected_images(self.root, 'toy', ['5', '1'])
        self.assertEqual([row['name'] for row in manifest['images']], ['1', '5'])
        matched = runner.match_masks(manifest, allow_missing=True)
        self.assertTrue(all(row['mask'] is None for row in matched['images']))
        with self.assertRaises(ValueError):
            runner.input_manifest(self.root, 'toy', ['1', '5'])

    def test_all_existing_reused_without_model_or_gpu(self):
        paths = [self.mask(name, '_mask.png') for name in ('1', '3')]
        before = [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths]
        infer = Mock(side_effect=AssertionError('BiRefNet must not load for reuse'))
        with ExitStack() as stack:
            stack.enter_context(patch.object(runner, 'check_gpu', side_effect=AssertionError('no GPU for reuse')))
            stack.enter_context(patch.object(prepare_masks, 'check_gpu', create=True, side_effect=AssertionError('no GPU for reuse')))
            stack.enter_context(patch.object(runner.fcntl, 'flock', side_effect=AssertionError('no GPU lock for reuse')))
            result = prepare_masks.prepare(self.root, 'toy', ['1', '3'], infer=infer)
        infer.assert_not_called()
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(set(result['reused']), {'1', '3'})
        self.assertEqual(result['generated'], [])
        self.assertEqual(before, [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths])
        self.assertEqual(len(result['previews']), 2)
        for preview in result['previews']:
            with Image.open(preview['path']) as image:
                image.load()

    def test_partial_missing_only_infers_missing_and_preserves_existing(self):
        existing = self.mask('1', '_mask.png')
        before = (existing.read_bytes(), existing.stat().st_mtime_ns)
        infer = Mock(side_effect=self.generate)
        result = prepare_masks.prepare(self.root, 'toy', ['5', '1', '3'], infer=infer)
        infer.assert_called_once()
        self.assertEqual([row['name'] for row in infer.call_args.args[0]], ['3', '5'])
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['reused'], ['1'])
        self.assertEqual(set(result['generated']), {'3', '5'})
        self.assertEqual(before, (existing.read_bytes(), existing.stat().st_mtime_ns))
        manifest = runner.input_manifest(self.root, 'toy')
        for row in manifest['images']:
            with Image.open(row['mask']) as image:
                self.assertEqual(image.mode, 'RGBA')
                self.assertEqual(image.size, (19, 13))
                self.assertLessEqual(set(image.getchannel('A').getdata()), {0, 255})

    def test_duplicate_match_blocks_inference_and_keeps_files(self):
        paths = [self.mask('1'), self.mask('1', '_mask.png')]
        before = [path.read_bytes() for path in paths]
        infer = Mock()
        with self.assertRaises(ValueError):
            prepare_masks.prepare(self.root, 'toy', ['1', '3'], infer=infer)
        infer.assert_not_called()
        self.assertEqual(before, [path.read_bytes() for path in paths])

    def test_invalid_existing_masks_block_inference(self):
        for kind in ('corrupt', 'size', 'mode', 'empty'):
            with self.subTest(kind=kind):
                path = self.directory / 'masks/1.png'
                path.parent.mkdir(exist_ok=True)
                if kind == 'corrupt':
                    path.write_bytes(b'not a PNG')
                elif kind == 'size':
                    self.mask('1', size=(18, 13))
                elif kind == 'mode':
                    self.mask('1', mode='L')
                else:
                    self.mask('1', alpha=0)
                before = path.read_bytes()
                infer = Mock()
                with self.assertRaises((ValueError, OSError)):
                    prepare_masks.prepare(self.root, 'toy', ['1', '3'], infer=infer)
                infer.assert_not_called()
                self.assertEqual(path.read_bytes(), before)

    def test_inference_failure_preserves_successful_output_for_retry(self):
        def fail_after_first(rows):
            self.generate(rows[:1])
            raise RuntimeError('injected inference failure')
        with self.assertRaisesRegex(RuntimeError, 'injected'):
            prepare_masks.prepare(self.root, 'toy', ['1', '3'], infer=fail_after_first)
        saved = self.directory / 'masks/1.png'
        before = saved.read_bytes()
        infer = Mock(side_effect=self.generate)
        retry = prepare_masks.prepare(self.root, 'toy', ['1', '3'], infer=infer)
        self.assertEqual([row['name'] for row in infer.call_args.args[0]], ['3'])
        self.assertEqual(retry['status'], 'complete')
        self.assertEqual(saved.read_bytes(), before)

    def test_invalid_or_missing_generated_output_never_completes(self):
        for kind in ('missing', 'empty', 'corrupt'):
            with self.subTest(kind=kind):
                path = self.directory / 'masks/1.png'
                if path.exists():
                    path.unlink()
                def invalid(rows):
                    if kind == 'empty':
                        self.mask('1', alpha=0)
                    elif kind == 'corrupt':
                        path.parent.mkdir(exist_ok=True)
                        path.write_bytes(b'invalid generated image')
                with self.assertRaises((ValueError, OSError, RuntimeError)):
                    prepare_masks.prepare(self.root, 'toy', ['1'], infer=invalid)


class ConfirmationTests(unittest.TestCase):
    def record(self):
        return {'status': 'complete', 'images': [{'name': '1'}, {'name': '3'}]}

    def test_requires_prepare_then_binds_selection_independent_of_order(self):
        state = Confirmation('toy', ['1', '3'])
        with self.assertRaises(ValueError):
            state.confirmed('toy', ['1', '3'])
        token = state.begin('toy', ['1', '3'])
        record = self.record()
        self.assertTrue(state.finish(token, record))
        self.assertEqual(state.confirmed('toy', ['3', '1']), record)
        with self.assertRaises(ValueError):
            state.confirmed('other', ['1', '3'])
        with self.assertRaises(ValueError):
            state.confirmed('toy', ['1'])

    def test_selection_change_cancels_inflight_result_even_after_return(self):
        state = Confirmation('toy', ['1', '3'])
        old = state.begin('toy', ['1', '3'])
        state.invalidate('toy', ['1'])
        state.invalidate('toy', ['1', '3'])
        self.assertFalse(state.finish(old, self.record()))
        with self.assertRaises(ValueError):
            state.confirmed('toy', ['1', '3'])
        new = state.begin('toy', ['1', '3'])
        self.assertTrue(state.finish(new, self.record()))

    def test_change_clears_completed_confirmation(self):
        state = Confirmation('toy', ['1', '3'])
        state.finish(state.begin('toy', ['1', '3']), self.record())
        state.invalidate('other', ['1', '3'])
        with self.assertRaises(ValueError):
            state.confirmed('other', ['1', '3'])


if __name__ == '__main__':
    unittest.main()
