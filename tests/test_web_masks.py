"""Exercise the actual web generator's last confirmation gate before Popen."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from mask_state import Confirmation
from prepare_masks import file_signatures
import run


class WebMaskTests(unittest.TestCase):
    def test_selection_change_before_process_start_prevents_reconstruction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'data/inputs/toy'
            for folder in ('images', 'masks'):
                (directory/folder).mkdir(parents=True)
            Image.new('RGB', (2, 2)).save(directory/'images/1.png')
            Image.new('RGBA', (2, 2), (0, 0, 0, 255)).save(directory/'masks/1.png')
            with patch.dict(os.environ, VIEWFORGE_ROOT=str(root)):
                import web
            state = Confirmation('toy', ['1'])
            ready = dict(status='complete', signatures=file_signatures(run.input_manifest(root, 'toy')['images']))
            state.finish(state.begin('toy', ['1']), ready)
            with patch.object(web, 'ROOT', root), patch.object(web.subprocess, 'Popen') as spawn:
                job = web.main_action('toy', ['1'], state)
                next(job)
                state.invalidate('toy', [])
                self.assertEqual(list(job), [])
                spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
