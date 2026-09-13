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

class CaptureWebTests(unittest.TestCase):
    def web(self, root):
        with patch.dict(os.environ, VIEWFORGE_ROOT=str(root)):
            import web
        return web

    def test_history_invalidates_pending_confirmation_and_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            web = self.web(Path(temporary))
            state = Confirmation('toy', ['1'])
            state.parent_run_id = 'old'
            token = state.begin('toy', ['1'])
            with patch.object(web, 'load_result', return_value={}):
                web.open_result('other', state)
            self.assertIsNone(state.parent_run_id)
            self.assertEqual(state.key, ('toy', ('1',)))
            self.assertFalse(state.finish(token, dict(status='complete')))

    def test_cover_retry_result_does_not_replace_changed_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root/'runs/old/logs').mkdir(parents=True)
            web = self.web(root)
            state = Confirmation('toy', ['1'])
            def complete(*args, **kwargs):
                state.invalidate('toy', ['1'])
                from types import SimpleNamespace
                return SimpleNamespace(returncode=0)
            with patch.object(web,'ROOT',root), patch.object(web,'completed_runs',return_value=['old']), patch.object(web.subprocess,'run',side_effect=complete), patch.object(web,'load_result') as load:
                web.retry_cover('old',state)
                load.assert_not_called()

    def test_new_run_becomes_next_capture_parent(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            web=self.web(root)
            state=Confirmation('toy',['1'])
            token=state.begin('toy',['1'])
            def start(command, **kwargs):
                from types import SimpleNamespace
                import json
                attempt=command[command.index('--attempt')+1]
                directory=root/'runs'/f'{web.datetime.now():%Y%m%d}_toy_{attempt}'
                directory.mkdir(parents=True)
                (directory/'result.json').write_text(json.dumps({'status':'complete'}))
                return SimpleNamespace(poll=lambda:0,returncode=0)
            with patch.object(web,'ROOT',root), patch.object(web.runner,'input_manifest',return_value={'images':[]}), patch.object(web,'file_signatures',return_value=[]), patch.object(web.subprocess,'Popen',side_effect=start), patch.object(web,'load_result',return_value={}), patch.object(web,'completed_runs',return_value=[]):
                list(web.run_job('toy',['1'],{'signatures':[]},state,token))
            self.assertTrue(state.parent_run_id.endswith(next((root/'runs').iterdir()).name))
            self.assertEqual(state.displayed_run_id,state.parent_run_id)

    def test_successful_upload_clears_file_control(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'data/inputs/toy/images'
            directory.mkdir(parents=True)
            Image.new('RGB', (2, 2)).save(directory/'1.png')
            source = root/'phone.png'
            Image.new('RGB', (2, 2)).save(source)
            web = self.web(root)
            state = Confirmation('toy', ['1'])
            with patch.object(web, 'ROOT', root):
                result = web.upload_photos([str(source)], 'toy', ['1'], state)
            self.assertEqual(len(result), 6)
            self.assertIn('value', result[-1])
            self.assertIsNone(result[-1]['value'])
            self.assertEqual(len(list(directory.iterdir())), 2)

    def test_stale_session_selection_recovers_with_preview_only(self):
        import json
        from types import SimpleNamespace
        for old_object in ('toy', 'other'):
            with self.subTest(old_object=old_object), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                web = self.web(root)
                state = Confirmation(old_object, ['1'])
                old_token = state.begin(old_object, ['1'])
                state.finish(old_token, {'status': 'complete', 'signatures': ['old']})
                state.parent_run_id = 'old-parent'
                record = {'status': 'complete', 'signatures': ['new'], 'previews': []}
                with patch.object(web, 'ROOT', root), patch.object(web.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=json.dumps(record))) as prepare, patch.object(web.subprocess, 'Popen') as reconstruct:
                    updates = list(web.main_action('toy', ['1', '2'], state))
                self.assertEqual(state.key, ('toy', ('1', '2')))
                self.assertFalse(state.current(old_token))
                self.assertEqual(state.ready, record)
                self.assertEqual(state.parent_run_id, 'old-parent' if old_object == 'toy' else None)
                self.assertEqual(updates[-1][-1]['value'], '开始重建')
                self.assertIn('prepare_masks.py', prepare.call_args.args[0][1])
                reconstruct.assert_not_called()
