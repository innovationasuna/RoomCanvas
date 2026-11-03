"""CPU contracts for multi-view conditioning, sparse arithmetic and hook restoration."""
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from trellis_multi import SAMPLERS, run_multi_image


class Sparse:
    def __init__(self, feats, coords):
        self.feats, self.coords = np.asarray(feats), coords

    def __mul__(self, value):
        return Sparse(self.feats * value, self.coords)

    def __add__(self, other):
        if not np.array_equal(self.coords, other.coords):
            raise ValueError('Sparse coordinates changed')
        return Sparse(self.feats + other.feats, self.coords)


class Sampler:
    def __init__(self):
        self.used = []

    def _inference_model(self, model, x_t, t, cond=None, neg_cond=None, **kwargs):
        self.used.append(float(cond[0, 0]))
        if cond.shape != (1, 1) or neg_cond.shape != (1, 1):
            raise ValueError('Native inference must retain batch size one')
        # A nonlinear native guidance rule distinguishes averaging predictions
        # from averaging features, and exercises the original sampler callback.
        result = kwargs['guidance_strength'] * cond ** 2 + neg_cond
        return Sparse(result, x_t.coords) if isinstance(x_t, Sparse) else result


class Pipeline:
    def __init__(self):
        self.encoded, self.preprocessed, self.runs = [], [], []
        self.fail = False
        for name in SAMPLERS:
            setattr(self, name, Sampler())
            setattr(self, name + '_params', dict(steps=4))

    def preprocess_image(self, image):
        self.preprocessed.append(image)
        return image

    def get_cond(self, images, resolution, include_neg_cond=True):
        self.encoded.append((list(images), resolution, include_neg_cond))
        result = dict(cond=np.asarray(images, dtype=float)[:, None])
        if include_neg_cond:
            result['neg_cond'] = np.full_like(result['cond'], -5)
        return result

    def run(self, image, *, preprocess_image=True, **kwargs):
        self.runs.append((image, preprocess_image))
        conditions = [self.get_cond([image], resolution) for resolution in (512, 1024)]
        output = {}
        for index, name in enumerate(SAMPLERS):
            if self.fail and index == 1:
                raise RuntimeError('inference failed')
            sampler = getattr(self, name)
            for condition in conditions if index == 1 else [conditions[index > 0]]:
                for _ in range(4):
                    noise = np.zeros((1, 1)) if index == 0 else Sparse([[0]], np.asarray([[0, 1, 2, 3]]))
                    output[name] = sampler._inference_model(None, noise, .7, **condition, guidance_strength=2)
        return output


def concatenate(arrays, dim):
    return np.concatenate(arrays, axis=dim)


class MultiImageTests(unittest.TestCase):
    def test_mean_of_native_guided_predictions_preserves_sparse_coordinates(self):
        pipeline = Pipeline()
        output, stats = run_multi_image(pipeline, [1, 3], concatenate=concatenate)
        for value in output.values():
            np.testing.assert_array_equal(value.feats if isinstance(value, Sparse) else value, [[5]])
            if isinstance(value, Sparse):
                np.testing.assert_array_equal(value.coords, [[0, 1, 2, 3]])
        self.assertEqual(pipeline.preprocessed, [1, 3])
        self.assertEqual(pipeline.runs, [(1, False)])
        self.assertEqual(pipeline.encoded, [([1], 512, True), ([3], 512, False),
                                           ([1], 1024, True), ([3], 1024, False)])
        self.assertEqual(stats['stages']['shape_slat_sampler']['view_forward_calls'], [8, 8])
        for name in SAMPLERS:
            self.assertNotIn('_inference_model', vars(getattr(pipeline, name)))
        self.assertNotIn('get_cond', vars(pipeline))

    def test_round_robin_uses_all_four_views_in_each_stage_and_cascade(self):
        pipeline = Pipeline()
        _, stats = run_multi_image(pipeline, [1, 2, 3, 4], mode='stochastic', concatenate=concatenate)
        for name in SAMPLERS:
            repeat = 2 if name == 'shape_slat_sampler' else 1
            self.assertEqual(getattr(pipeline, name).used, [1, 2, 3, 4] * repeat)
            self.assertEqual(stats['stages'][name]['view_forward_calls'], [repeat] * 4)

    def test_sampling_exception_restores_methods_and_allows_native_single_image(self):
        pipeline = Pipeline()
        own_condition = pipeline.get_cond
        pipeline.get_cond = own_condition
        pipeline.fail = True
        with self.assertRaisesRegex(RuntimeError, 'inference failed'):
            run_multi_image(pipeline, [1, 3], concatenate=concatenate)
        self.assertIs(vars(pipeline)['get_cond'], own_condition)
        for name in SAMPLERS:
            self.assertNotIn('_inference_model', vars(getattr(pipeline, name)))
        pipeline.fail = False
        output = pipeline.run(1)
        np.testing.assert_array_equal(output[SAMPLERS[0]], [[-3]])

    def test_invalid_or_insufficient_inputs_fail_before_changing_pipeline(self):
        for images, options in [([1], {}), (list(range(5)), {}), ([1, 2], dict(mode='unknown')),
                                ([1, 2], dict(num_samples=2)),
                                ([1, 2], dict(mode='stochastic', sparse_structure_sampler_params=dict(steps=1)))]:
            with self.subTest(images=images, options=options):
                pipeline = Pipeline()
                with self.assertRaises(ValueError):
                    run_multi_image(pipeline, images, concatenate=concatenate, **options)
                self.assertEqual(pipeline.preprocessed, [])
                self.assertEqual(pipeline.runs, [])
                self.assertNotIn('get_cond', vars(pipeline))


if __name__ == '__main__':
    unittest.main()
