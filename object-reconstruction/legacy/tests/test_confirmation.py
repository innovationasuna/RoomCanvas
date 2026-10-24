"""已弃用 Gradio 会话的历史测试；不属于正式 API 测试入口。"""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from mask_state import Confirmation

class ConfirmationTests(unittest.TestCase):
    def record(self):
        return {'status': 'complete', 'images': [{'name': '1'}, {'name': '3'}]}

    def test_requires_prepare_then_binds_selection_independent_of_order(self):
        state = Confirmation('toy', ['1', '3'])
        with self.assertRaises(ValueError):
            state.confirmed('toy', ['1', '3'])
        token = state.begin('toy', ['1', '3'])
        record = self.record()
        self.assertTrue(state.finish(token, record))
        self.assertEqual(state.confirmed('toy', ['3', '1']), record)
        with self.assertRaises(ValueError):
            state.confirmed('other', ['1', '3'])
        with self.assertRaises(ValueError):
            state.confirmed('toy', ['1'])

    def test_selection_change_cancels_inflight_result_even_after_return(self):
        state = Confirmation('toy', ['1', '3'])
        old = state.begin('toy', ['1', '3'])
        state.invalidate('toy', ['1'])
        state.invalidate('toy', ['1', '3'])
        self.assertFalse(state.finish(old, self.record()))
        with self.assertRaises(ValueError):
            state.confirmed('toy', ['1', '3'])
        new = state.begin('toy', ['1', '3'])
        self.assertTrue(state.finish(new, self.record()))

    def test_change_clears_completed_confirmation(self):
        state = Confirmation('toy', ['1', '3'])
        state.finish(state.begin('toy', ['1', '3']), self.record())
        state.invalidate('other', ['1', '3'])
        with self.assertRaises(ValueError):
            state.confirmed('other', ['1', '3'])

    def test_late_ready_cannot_restore_after_upload_selection_change(self):
        state=Confirmation('toy',['1'])
        token=state.begin('toy',['1'])
        state.invalidate('toy',['1','new'])
        self.assertFalse(state.finish(token,dict(status='complete')))
