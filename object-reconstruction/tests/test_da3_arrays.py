from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from da3_arrays import depth_to_pointmap, pointmap_to_sam3d_format, pointmaps_from_depth, load_da3_arrays


class DA3ArraysTests(unittest.TestCase):
    def setUp(self):
        self.depth = np.random.default_rng(42).uniform(.1, 20, (2, 63, 84)).astype(np.float32)
        self.intrinsics = np.tile([[83.2, 0, 40.7], [0, 81.6, 30.4], [0, 0, 1]], (2, 1, 1)).astype(np.float32)

    def test_float32_camera_coordinates_match_the_old_double_grid(self):
        result = pointmaps_from_depth(self.depth, self.intrinsics)
        v, u = np.meshgrid(np.arange(63), np.arange(84), indexing='ij')
        expected = np.stack([np.stack([(u-k[0, 2])*d/k[0, 0], (v-k[1, 2])*d/k[1, 1], d], axis=-1)
                             for d, k in zip(self.depth, self.intrinsics)])
        self.assertEqual(result.dtype, np.float32)
        np.testing.assert_allclose(result, expected, rtol=2e-7, atol=2e-6)
        np.testing.assert_array_equal(result[..., 2], self.depth)
        self.assertTrue(np.all(result[:, 0, 0, :2] < 0))
        self.assertTrue(np.all(result[:, -1, -1, :2] > 0))
        self.assertTrue(np.shares_memory(pointmap_to_sam3d_format(result[0]), result))
        self.assertEqual(result.nbytes * 4, expected.nbytes * 2)

    def test_new_and_both_legacy_npz_layouts_are_consumed(self):
        points = pointmaps_from_depth(self.depth, self.intrinsics)
        with tempfile.TemporaryDirectory() as temp:
            for values in [dict(pointmaps=points), dict(pointmaps_sam3d=points.transpose(0, 3, 1, 2).astype(float)),
                           dict(pointmaps=points.astype(float), pointmaps_sam3d=points.transpose(0, 3, 1, 2).astype(float))]:
                file = Path(temp)/'output.npz'
                np.savez(file, **values, extrinsics=np.eye(4)[None].repeat(2, axis=0),
                         intrinsics=self.intrinsics, image_files=['2.jpg', '10.jpg'])
                data = load_da3_arrays(file)
                self.assertEqual(data['pointmaps_sam3d'].dtype, np.float32)
                np.testing.assert_array_equal(data['pointmaps_sam3d'], points.transpose(0, 3, 1, 2))
                self.assertEqual(data['image_files'].tolist(), ['2.jpg', '10.jpg'])
                np.testing.assert_array_equal(data['intrinsics'], self.intrinsics)

    def test_malformed_layout_and_camera_fail_before_inference(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)/'bad.npz'
            for data in (dict(depth=self.depth), dict(pointmaps=np.zeros((2, 3, 10, 10))),
                         dict(pointmaps_sam3d=np.zeros((2, 10, 10, 3)))):
                np.savez(path, **data)
                with self.assertRaises(ValueError):
                    load_da3_arrays(path)
        with self.assertRaises(ValueError):
            depth_to_pointmap(self.depth[0], np.zeros((3, 3)))


if __name__ == '__main__':
    unittest.main()
