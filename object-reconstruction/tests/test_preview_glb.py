"""Exercise real mesh simplification, color export, and historical manifests."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from preview_glb import generate_preview
from cover_scene import ensure_preview, preview_manifest


class PreviewGLB(unittest.TestCase):
    def test_simplification_preserves_source_colors_and_scene_coordinates(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            directory = run/'reconstruction'
            directory.mkdir()
            mesh = trimesh.creation.icosphere(subdivisions=4)
            mesh.visual.vertex_colors = [25, 100, 220, 255]
            scene = trimesh.Scene()
            transform = trimesh.transformations.translation_matrix([3, -2, 7])
            scene.add_geometry(mesh, node_name='object', geom_name='geometry', transform=transform)
            source = directory/'result.glb'
            source.write_bytes(scene.export(file_type='glb'))
            original = source.read_bytes()
            result = generate_preview(run, 1000)
            self.assertLessEqual(result['preview_faces'], 1000)
            self.assertLess(result['preview_bytes'], result['source_bytes'] / 3)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(result['source_sha256'], hashlib.sha256(original).hexdigest())
            preview = trimesh.load_scene(directory/'preview.glb', process=False)
            np.testing.assert_allclose(preview.graph['object'][0], transform)
            reduced = preview.geometry['geometry']
            np.testing.assert_allclose(reduced.visual.vertex_colors,
                                       np.tile([25, 100, 220, 255], (len(reduced.vertices), 1)), atol=1)
            np.testing.assert_allclose(preview.bounds, scene.bounds, atol=.06)
            modified = (directory/'preview.glb').stat().st_mtime_ns
            self.assertEqual(generate_preview(run, 1000), result)
            self.assertEqual((directory/'preview.glb').stat().st_mtime_ns, modified)

    def test_existing_manifest_keeps_recommendation_and_full_asset(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            manifest = preview_manifest(run, recommendation=dict(id='camera'))
            (run/'cover').mkdir()
            path = run/'cover/preview.json'
            path.write_text(json.dumps(manifest))
            self.assertEqual(ensure_preview(run), path)
            (run/'reconstruction').mkdir()
            (run/'reconstruction/preview.glb').write_bytes(b'fixture')
            ensure_preview(run)
            updated = json.loads(path.read_text())
            self.assertEqual(updated['recommendation'], manifest['recommendation'])
            self.assertEqual(updated['assets']['glb'], manifest['assets']['glb'])
            self.assertEqual(updated['assets']['glb_preview']['transform'], manifest['assets']['glb']['transform'])


if __name__ == '__main__':
    unittest.main()
