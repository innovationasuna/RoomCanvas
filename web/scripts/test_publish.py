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
MODULE = re.compile(r"""['"](\./[\w./-]+\.(?:mjs|js))\?v=([\w.-]+)['"]""")


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
            # Follow published imports, including dynamic imports and the Worker's
            # new URL(...). Extraction must keep the complete module graph present
            # and on one version, without requiring a specific entry-file layout.
            tag = tags.pop()

            def reachable(entry):
                visited, pending = set(), [editor / entry]
                while pending:
                    file = pending.pop().resolve()
                    if file in visited:
                        continue
                    self.assertTrue(file.is_file(), file)
                    visited.add(file)
                    for reference, module_tag in MODULE.findall(file.read_text()):
                        self.assertEqual(module_tag, tag, (file.name, reference))
                        pending.append(file.parent / reference)
                return {file.name for file in visited}

            self.assertLessEqual({'scene-geometry.mjs', 'collision-client.mjs', 'collision-worker.mjs',
                                  'collision.mjs', 'placement.mjs', 'entity-geometry.mjs', 'ray-queries.mjs'},
                                 reachable('scene-editor.js'))
            self.assertIn('collision.mjs', reachable('collision-worker.mjs'))
            # The hand tracker's model, which the editor reads from ../vendor/vision/.
            self.assertTrue((room / 'preview/vendor/vision/hand_landmarker.task').is_file())
            self.assertFalse((room / 'preview/vendor/vision').is_symlink())
            self.assertTrue((room / 'preview/assets/fonts/manrope-latin-400-normal.woff2').is_file())
            self.assertTrue((room / 'preview/assets/fonts/manrope-OFL.txt').is_file())


if __name__ == '__main__':
    unittest.main()
