"""python3 -m unittest discover -s web/scripts"""
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB / 'scripts'))
from publish import REFERENCE  # noqa: E402

QUERY = re.compile(r"""['"](?:\./|\.\./)[\w./-]+\.(?:mjs|js|css)\?v=([\w.-]+)['"]""")


def sources():
    return [*WEB.glob('editor/*.js'), *WEB.glob('editor/*.mjs'), WEB / 'editor/index.html', WEB / 'index.html']


class Publish(unittest.TestCase):
    def test_sources_carry_no_version_queries(self):
        # Hand-written ?v= drifted apart and loaded placement.mjs and layout.mjs two or three times.
        for file in sources():
            self.assertEqual(QUERY.findall(file.read_text()), [], file.name)

    def test_published_editor_has_one_version_and_the_hand_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            room = Path(temporary)
            (room / 'Room.glb').write_bytes(b'glTF')
            (room / 'room_objects.json').write_text('{}')
            subprocess.run([sys.executable, str(WEB / 'scripts/publish.py'), '--scene-dir', str(room)],
                           check=True, capture_output=True)
            editor = room / 'preview/editor'
            tags, unstamped = set(), []
            for file in [*editor.glob('*.js'), *editor.glob('*.mjs'), *editor.glob('*.html')]:
                text = file.read_text()
                tags.update(QUERY.findall(text))
                unstamped += [f'{file.name}: {m[2]}' for m in REFERENCE.finditer(text)]
            self.assertEqual(len(tags), 1, tags)
            self.assertEqual(unstamped, [])
            # The page and its collision worker import the very same module URL.
            tag = tags.pop()
            for name in ['scene-editor.js', 'collision-worker.mjs']:
                self.assertIn(f"'./collision.mjs?v={tag}'", (editor / name).read_text())
            # The hand tracker's model, which the editor reads from ../vendor/vision/.
            self.assertTrue((room / 'preview/vendor/vision/hand_landmarker.task').is_file())
            self.assertFalse((room / 'preview/vendor/vision').is_symlink())


if __name__ == '__main__':
    unittest.main()
