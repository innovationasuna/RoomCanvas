"""python3 -m unittest discover -s web/scripts"""
import sys
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import forwarded  # noqa: E402


class Forwarding(unittest.TestCase):
    def test_only_the_editor_reads_go_to_viewforge(self):
        run = '20260926_sofa_web_114146_561893'
        for path in ['/viewforge/assets/catalog', f'/viewforge/assets/{run}',
                     f'/viewforge/assets/{run}/result.glb', f'/viewforge/assets/{run}/preview.glb?x=1',
                     f'/viewforge/assets/{run}/result.ply', f'/viewforge/assets/{run}/preview.json',
                     '/viewforge/layouts/catalog', f'/viewforge/layouts/assets/{run}',
                     f'/viewforge/layouts/assets/{run}/result.glb', f'/viewforge/layouts/assets/{run}/preview.glb?x=1']:
            self.assertEqual(forwarded(path), path.split('?')[0])
        for path in ['/web/', '/viewforge/layouts/save', '/viewforge/layouts/viewer', '/viewforge/layouts/rooms/office.glb',
                     '/viewforge/layouts/assets/../secret', f'/viewforge/layouts/assets/{run}/other.glb',
                     '/viewforge/assets/../secret', f'/viewforge/assets/{run}/other.glb', '/gradio_api/file=/etc/passwd']:
            self.assertIsNone(forwarded(path))

    def test_adding_an_object_goes_to_viewforge(self):
        job, chair = 'a' * 32, quote('20261018_我的椅子_web_101010_000001')
        for path in [f'/viewforge/objects/jobs/{job}', f'/viewforge/objects/previews/20261018_101010_ab12cd34/{quote("我的椅子_001")}.png',
                     f'/viewforge/assets/{chair}', f'/viewforge/assets/{chair}/result.glb']:
            self.assertEqual(forwarded(path), path)
        for path in ['/viewforge/objects/create', '/viewforge/objects/masks', '/viewforge/objects/reconstruct', f'/viewforge/dimensions/{chair}']:
            self.assertEqual(forwarded(path, 'POST'), path)
            self.assertIsNone(forwarded(path))
        for path in ['/viewforge/layouts/save', f'/viewforge/assets/{chair}', '/viewforge/objects/jobs', f'/viewforge/dimensions/{chair}/model.glb',
                     '/viewforge/dimensions/..', '/web/editor/index.html']:
            self.assertIsNone(forwarded(path, 'POST'))
        self.assertIsNone(forwarded('/viewforge/objects/previews/x/%2E%2E%2Fsecret.png'))


if __name__ == '__main__':
    unittest.main()
