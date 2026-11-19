"""Real decimation: preserve thin legs, holes, support planes and PBR display data."""
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image
import trimesh

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from collision_proxy import generate_collision_proxy, quality


def furniture():
    parts = []
    tabletop = trimesh.creation.box(extents=[2., .08, 1.2])
    tabletop.apply_translation([0, 1., 0])
    parts.append(tabletop.subdivide().subdivide())
    for x in (-.85, .85):
        for z in (-.45, .45):
            leg = trimesh.creation.cylinder(radius=.025, height=.96, sections=64)
            leg.apply_transform(trimesh.transformations.rotation_matrix(np.pi/2, [1, 0, 0]))
            leg.apply_translation([x, .48, z])
            parts.append(leg)
    ring = trimesh.creation.annulus(r_min=.35, r_max=.7, height=.08, sections=128)
    ring.apply_translation([3., .7, 0])
    parts.append(ring)
    mesh = trimesh.util.concatenate(parts)
    uv = mesh.vertices[:, [0, 2]] % 1
    material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.new('RGB', (32, 32), (30, 120, 210)))
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    return trimesh.Scene(mesh)


def hits(scene, rays):
    import open3d as o3d
    query = o3d.t.geometry.RaycastingScene()
    for node in scene.graph.nodes_geometry:
        transform, name = scene.graph[node]
        mesh = scene.geometry[name].copy()
        mesh.apply_transform(transform)
        query.add_triangles(o3d.core.Tensor(mesh.vertices.astype(np.float32)),
                            o3d.core.Tensor(mesh.faces.astype(np.uint32)))
    return query.cast_rays(o3d.core.Tensor(np.array(rays, dtype=np.float32)))['t_hit'].numpy()


@unittest.skipUnless(importlib.util.find_spec('open3d'), 'requires the reconstruction environment (Open3D)')
class CollisionProxyTests(unittest.TestCase):
    def test_thin_legs_hole_support_and_display_material_survive(self):
        with tempfile.TemporaryDirectory() as temporary:
            run = Path(temporary)
            (run/'reconstruction').mkdir()
            original = furniture()
            source = run/'reconstruction/result.glb'
            source.write_bytes(original.export(file_type='glb'))
            before = source.read_bytes()
            report = generate_collision_proxy(run, 600)
            self.assertLess(report['proxy_faces'], report['source_faces']/2)
            self.assertEqual(source.read_bytes(), before)
            raw = (run/'reconstruction/collision.glb').read_bytes()
            size = struct.unpack_from('<I', raw, 12)[0]
            document = json.loads(raw[20:20+size])
            self.assertFalse(document.get('materials'))
            self.assertFalse(document.get('textures'))
            for mesh in document['meshes']:
                for primitive in mesh['primitives']:
                    self.assertNotIn('COLOR_0', primitive['attributes'])
                    self.assertNotIn('TEXCOORD_0', primitive['attributes'])
            proxy = trimesh.load_scene(run/'reconstruction/collision.glb', process=False)
            rays = [[0, 2, 0, 0, -1, 0], [.6, 2, .3, 0, -1, 0],  # tabletop support
                    [-2, .4, -.45, 1, 0, 0], [-2, .4, .45, 1, 0, 0],  # thin legs
                    [3, .7, 2, 0, 0, -1], [3.5, .7, 2, 0, 0, -1]]  # hole/ring
            expected, actual = hits(original, rays), hits(proxy, rays)
            np.testing.assert_array_equal(np.isinf(actual), np.isinf(expected))
            self.assertTrue(np.isinf(actual[-2]))
            np.testing.assert_allclose(actual[np.isfinite(actual)], expected[np.isfinite(expected)], atol=.003)
            np.testing.assert_allclose(proxy.bounds, original.bounds, atol=.003)
            modified = (run/'reconstruction/collision.glb').stat().st_mtime_ns
            self.assertEqual(generate_collision_proxy(run, 600), report)
            self.assertEqual((run/'reconstruction/collision.glb').stat().st_mtime_ns, modified)

    def test_topology_and_large_support_drift_are_rejected(self):
        source = trimesh.creation.box()
        shifted = source.copy()
        shifted.apply_translation([0, .1, 0])
        self.assertFalse(quality(source, shifted)['accepted'])
        open_box = source.copy()
        open_box.update_faces(np.arange(len(open_box.faces)-2))
        self.assertFalse(quality(source, open_box)['accepted'])


if __name__ == '__main__':
    unittest.main()
