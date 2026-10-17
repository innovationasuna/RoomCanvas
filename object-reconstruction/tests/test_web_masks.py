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

    def test_object_choices_follow_visible_input_folders_and_show_counts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, count in (('alpha', 2), ('beta', 1), ('internal', 1)):
                directory = root/'data/inputs'/name/'images'
                directory.mkdir(parents=True)
                for index in range(count):
                    Image.new('RGB', (2, 2)).save(directory/f'{index}.png')
            (root/'data/inputs/internal/.viewforge-hidden').touch()
            web = self.web(root)
            with patch.object(web, 'ROOT', root):
                self.assertEqual(web.objects(), ['alpha', 'beta'])
                self.assertEqual(web.object_choices(), [('alpha（2 张）', 'alpha'), ('beta（1 张）', 'beta')])

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

    def test_new_run_does_not_implicitly_enter_capture_mode(self):
        import json
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            web=self.web(root)
            state=Confirmation('toy',['1'])
            token=state.begin('toy',['1'])
            def start(command, **kwargs):
                from types import SimpleNamespace
                attempt=command[command.index('--attempt')+1]
                directory=root/'runs'/f'{web.datetime.now():%Y%m%d}_toy_{attempt}'
                directory.mkdir(parents=True)
                (directory/'result.json').write_text(json.dumps({'status':'complete'}))
                return SimpleNamespace(poll=lambda:0,returncode=0)
            with patch.object(web,'ROOT',root), patch.object(web.runner,'input_manifest',return_value={'images':[]}), patch.object(web,'file_signatures',return_value=[]), patch.object(web.subprocess,'Popen',side_effect=start), patch.object(web,'load_result',return_value={}), patch.object(web,'completed_runs',return_value=[]):
                list(web.run_job('toy',['1'],{'signatures':[]},state,token))
            self.assertIsNone(state.parent_run_id)
            run_dir = next((root/'runs').iterdir())
            self.assertEqual(state.displayed_run_id, run_dir.name)

    def test_duration_format(self):
        web = self.web(Path('/unused'))
        self.assertEqual(web.format_duration(0), '00:00')
        self.assertEqual(web.format_duration(125.9), '02:05')
        self.assertEqual(web.format_duration(3661), '01:01:01')

    def test_reconstruction_tracker_reads_persisted_stage_and_timing(self):
        import json
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            run_dir = root/'runs/20260926_toy_web_example'
            run_dir.mkdir(parents=True)
            (run_dir/'result.json').write_text(json.dumps({
                'status': 'running', 'current_stage': 'reconstruction',
                'timing': {'started_at': '2026-09-26T10:00:00+08:00', 'elapsed_seconds': 125},
            }))
            web = self.web(root)
            with patch.object(web, 'ROOT', root):
                message = web.reconstruction_tracker()
            self.assertIn('阶段 2/3', message)
            self.assertIn('02:05', message)
            self.assertIn(run_dir.name, message)

    def test_capture_mode_restores_parent_views_when_selection_changes(self):
        import json
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            images = root/'data/inputs/toy/images'
            images.mkdir(parents=True)
            for name in ('1', '2', '3'):
                Image.new('RGB', (2, 2)).save(images/f'{name}.png')
            parent = root/'runs/parent'
            (parent/'reconstruction').mkdir(parents=True)
            (parent/'reconstruction/result.glb').touch()
            (parent/'inputs.json').write_text(json.dumps({
                'object': 'toy', 'input_dir': str(root/'data/inputs/toy'),
                'images': [{'name': '000001', 'source_name': '1'},
                           {'name': '000002', 'source_name': '2'}],
            }))
            web = self.web(root)
            state = Confirmation('toy', ['1', '2'])
            state.parent_run_id = 'parent'
            with patch.object(web, 'ROOT', root):
                result = web.choose_images('toy', ['3'], state)
            self.assertEqual(result[0]['value'], ['1', '2', '3'])
            self.assertEqual(state.key, ('toy', ('1', '2', '3')))
            self.assertIn('已锁定上轮 2 张照片', result[-1])

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
            state.parent_run_id = 'old-parent'
            with patch.object(web, 'ROOT', root):
                with self.assertRaisesRegex(Exception, '命名'):
                    web.upload_new_photos([str(source)], 'toy', ['1'], state)
                result = web.upload_new_photos([str(source)], 'toy', ['1'], state, 'new_toy')
            self.assertEqual(len(result), 7)
            self.assertIsNone(result[-2]['value'])
            self.assertIsNone(state.parent_run_id)
            self.assertEqual(len(list(directory.iterdir())), 1)
            new_object = result[-1]['value']
            self.assertNotEqual(new_object, 'toy')
            self.assertEqual(len(list((root/'data/inputs'/new_object/'images').iterdir())), 1)
            self.assertEqual(len(result[0]['value']), 1)
            self.assertIn('新图片', result[0]['choices'][0][0])

    def test_cancel_naming_does_not_create_or_change_object(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            web = self.web(root)
            state = Confirmation('toy', ['1'])
            with patch.object(web, 'ROOT', root):
                result = web.upload_new_photos(['temporary.png'], 'toy', ['1'], state, None)
            self.assertEqual(state.key, ('toy', ('1',)))
            self.assertFalse((root/'data/inputs').exists())
            self.assertIsNone(result[-2]['value'])

    def test_capture_upload_requires_explicit_parent_and_records_lineage(self):
        import json
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'data/inputs/toy/images'
            directory.mkdir(parents=True)
            Image.new('RGB', (2, 2)).save(directory/'1.png')
            source = root/'capture.png'
            Image.new('RGB', (2, 2)).save(source)
            web = self.web(root)
            state = Confirmation('toy', ['1'])
            with patch.object(web, 'ROOT', root):
                with self.assertRaisesRegex(Exception, '基于这次结果补拍'):
                    web.upload_capture_photos([str(source)], 'toy', ['1'], state)
                state.parent_run_id = 'parent-run'
                web.upload_capture_photos([str(source)], 'toy', ['1'], state)
            metadata = json.loads(next((root/'data/inputs/toy/imports').glob('*.json')).read_text())
            self.assertEqual(metadata['parent_run_id'], 'parent-run')

    def test_named_upload_and_archive_preserve_historical_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root/'phone.png'
            Image.new('RGB', (2, 2)).save(source)
            web = self.web(root)
            state = Confirmation()
            with patch.object(web, 'ROOT', root), patch.dict(os.environ, VIEWFORGE_GPU_LOCK=str(root/'gpu.lock')):
                updates = web.upload_new_photos([str(source)], None, [], state, 'sofa')
                self.assertEqual(updates[-1]['value'], 'sofa')
                image = root/'data/inputs/sofa/images/sofa.png'
                self.assertTrue(image.is_file())
                link = root/'runs/old/input/images/000001.png'
                link.parent.mkdir(parents=True)
                link.symlink_to(image)
                web.remove_photos('sofa', ['sofa'], state)
                self.assertFalse(image.exists())
                self.assertTrue(link.is_file())
                self.assertIn('/data/removed/', str(link.resolve()))
                self.assertEqual(web.images_for('sofa'), [])

    def test_remove_object_archives_directory_and_preserves_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root/'data/inputs/toy'
            (directory/'images').mkdir(parents=True)
            image = directory/'images/1.png'
            Image.new('RGB', (2, 2)).save(image)
            (directory/'notes.txt').write_text('keep me')
            link = root/'runs/old/input/images/000001.png'
            link.parent.mkdir(parents=True)
            link.symlink_to(image)
            web = self.web(root)
            state = Confirmation('toy', ['1'])
            state.parent_run_id = 'old'
            with patch.object(web, 'ROOT', root), patch.dict(os.environ, VIEWFORGE_GPU_LOCK=str(root/'gpu.lock')):
                updates = web.remove_object('toy', state)
                self.assertEqual(web.objects(), [])
            self.assertFalse(directory.exists())
            self.assertTrue(link.is_file())
            self.assertEqual((link.resolve().parents[1]/'notes.txt').read_text(), 'keep me')
            self.assertIsNone(updates[-1]['value'])
            self.assertIsNone(state.parent_run_id)
            self.assertEqual(updates[1], [])

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
