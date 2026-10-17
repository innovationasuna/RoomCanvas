"""CPU tests for COVER semantics; GPU renderer parity is an explicit separate check."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

try:
    import torch
except ImportError:
    torch = None

if torch is not None:
    path = Path(__file__).resolve().parents[1] / "scripts" / "cover_core.py"
    spec = importlib.util.spec_from_file_location("cover_core_test", path)
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)


@unittest.skipIf(torch is None, "PyTorch is not installed in this interpreter")
class CoverCoreTests(unittest.TestCase):
    def test_formula_uses_occupied_directions_not_frequency(self):
        bins = torch.tensor([[1., 0., 0.], [-1., 0., 0.], [0., 1., 0.]])
        counts = torch.tensor([[0., 0., 0.], [1., 0., 0.], [0., 7., 0.], [2., 0., 0.]])
        directions = torch.tensor([[1., 0., 0.], [1., 0., 0.], [1., 0., 0.], [0., 1., 0.]])
        masks = torch.ones(4, dtype=torch.bool)
        result = core.compute_coverage_per_gaussian(counts, bins, masks, directions)
        torch.testing.assert_close(result, torch.tensor([0., 1., 0., 0.5]), atol=1e-6, rtol=0)
        torch.testing.assert_close(result, core.compute_coverage_per_gaussian(counts * 19, bins, masks, directions))

    def test_default_fibonacci_directions_are_self_binned(self):
        bins = core.fibonacci_sphere(core.N_BINS)
        self.assertEqual(tuple(bins.shape), (128, 3))
        torch.testing.assert_close(core.dir_to_bin(bins, bins), torch.arange(128))

    def test_original_reduction_keeps_opacity_weighting_and_excludes_empty_pixels(self):
        coverage = torch.tensor([[0.2, 0.4, 0.]])
        alpha = torch.tensor([[0.3, 0.5, 0.]])
        score, count = core.summarize_map(coverage, alpha)
        self.assertAlmostEqual(score, 0.3, places=6)
        self.assertEqual(count, 2)
        self.assertEqual(core.summarize_map(torch.zeros(2, 2), torch.zeros(2, 2)), (None, 0))
        with self.assertRaises(RuntimeError):
            core.summarize_map(torch.tensor([[float("nan")]]), torch.ones(1, 1))

    def test_activated_gaussian_contract_and_quaternion_normalization(self):
        gs = {"means": torch.zeros(2, 3), "quats": torch.tensor([[2., 0., 0., 0.], [0., 0., 0., 3.]]),
              "scales": torch.full((2, 3), 0.1), "opacities": torch.tensor([0.2, 0.9])}
        normalized = core.normalize_gaussians(gs)
        torch.testing.assert_close(normalized["quats"].norm(dim=-1), torch.ones(2))
        torch.testing.assert_close(normalized["scales"], gs["scales"])
        torch.testing.assert_close(normalized["opacities"], gs["opacities"])
        with self.assertRaises(ValueError):
            core.normalize_gaussians({**gs, "scales": -gs["scales"]})

    def test_observed_projection_retains_original_radius_and_all_camera_updates(self):
        gs = {"means": torch.tensor([[0., 0., 1.], [0., 1., 2.]]),
              "quats": torch.tensor([[1., 0., 0., 0.], [1., 0., 0., 0.]]),
              "scales": torch.full((2, 3), 0.1), "opacities": torch.ones(2)}
        camera = core.normalize_camera({"id": "seen", "viewmat": torch.eye(4), "K": torch.eye(3),
                                        "width": 100, "height": 100}, torch.device("cpu"))
        def project(*args, **kwargs):
            self.assertEqual(kwargs["radius_clip"], 3.)
            self.assertTrue(kwargs["packed"])
            self.assertNotIn("opacities", kwargs)
            return (torch.tensor([0, 0]), torch.tensor([0, 0]), torch.tensor([0, 1]), None, None, None, None, None)
        with patch.object(core._UPSTREAM, "fully_fused_projection", side_effect=project) as projection:
            counts, _ = core.build_coverage_counts(gs, [camera, camera])
        self.assertEqual(projection.call_count, 2)
        torch.testing.assert_close(counts.sum(-1), torch.tensor([2., 2.]))
        self.assertEqual(int((counts > 0).sum()), 2)


if __name__ == "__main__":
    unittest.main()
