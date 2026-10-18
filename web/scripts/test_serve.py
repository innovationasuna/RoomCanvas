"""python3 -m unittest discover -s web/scripts"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve import forwarded  # noqa: E402


class Forwarding(unittest.TestCase):
    def test_only_the_editor_reads_go_to_viewforge(self):
        run = '20260926_sofa_web_114146_561893'
        for path in ['/viewforge/layouts/catalog', f'/viewforge/layouts/assets/{run}',
                     f'/viewforge/layouts/assets/{run}/result.glb', f'/viewforge/layouts/assets/{run}/preview.glb?x=1']:
            self.assertEqual(forwarded(path), path.split('?')[0])
        for path in ['/web/', '/viewforge/layouts/save', '/viewforge/layouts/viewer', '/viewforge/layouts/rooms/office.glb',
                     '/viewforge/layouts/assets/../secret', f'/viewforge/layouts/assets/{run}/other.glb', '/gradio_api/file=/etc/passwd']:
            self.assertIsNone(forwarded(path))


if __name__ == '__main__':
    unittest.main()
