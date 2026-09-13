"""Session-local confirmation, including changes while a queued job is running."""
from threading import RLock


def selection_key(name, selected):
    return name, tuple(sorted(selected or []))


class Confirmation:
    def __init__(self, name=None, selected=None):
        self.lock = RLock()
        self.key = selection_key(name, selected)
        self.generation = 0
        self.ready = None

    def __deepcopy__(self, memo):
        # Gradio clones the initial value for each browser session.
        return Confirmation(self.key[0], self.key[1])

    def invalidate(self, name, selected):
        with self.lock:
            self.key = selection_key(name, selected)
            self.generation += 1
            self.ready = None

    def begin(self, name, selected):
        with self.lock:
            if not name or not selected or self.key != selection_key(name, selected):
                raise ValueError('照片选择已变化，请重新准备预览')
            self.ready = None
            return self.generation, self.key

    def finish(self, token, record):
        with self.lock:
            if token != (self.generation, self.key) or record.get('status') != 'complete':
                return False
            self.ready = record
            return True

    def current(self, token):
        with self.lock:
            return token == (self.generation, self.key)

    def confirmed(self, name, selected):
        with self.lock:
            if self.key != selection_key(name, selected) or self.ready is None:
                raise ValueError('请先为当前照片准备预览并确认')
            return self.ready
