"""Local copies of finished rooms and reconstruction replays, for serve.py.

The room service's files come over an SSH tunnel that can be very slow (an AutoDL line can drop to ~16 KB/s).
A finished job's files do not change, so serve.py keeps a copy under runs/room-cache/ at the same paths as the
URLs, and the page reads that copy instead of the tunnel. With --ssh, a background download fetches what is
missing: every finished job's replay (scaffold, room models, pictures) and every finished room's files.
The JSON answers (job list, a replay's timeline, the room catalog) are always asked live; the last answer is
kept, and used when the service cannot be reached, so cached rooms and replays open with the server off.
The same content often comes under several paths (the last version of a replay is also the published room, and
may be a sample room too; jobs share some pictures). Before downloading a file, the service is asked its size and
sha256 (HEAD); a file here with the same content (in the cache, or a sample model) is linked instead, and a download
is kept only when it has that sha256. A service that does not give the sha256 (an older one) is downloaded from as
before.
"""
from contextlib import contextmanager, nullcontext
import hashlib
import http.client
import json
import mimetypes
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from fetch_samples import place, same_file  # noqa: E402

PREFIX = '/room-reconstruction/'
LIVE = {'queued', 'running', 'preparing'}
ANSWER = 'answer.json'  # a JSON answer is kept as <path>/answer.json, next to files under the same path
DIGEST = 'X-RoomCanvas-SHA256'  # room_service.py's answer to a HEAD for a file


def is_file(path):
    """A file that does not change once its job has finished (the rest are JSON answers)."""
    rest = path[len(PREFIX):]
    return rest.startswith('assets/') or '/replay/files/' in rest or '/replay/scaffold/' in rest


def local(cache, path):
    """Where a forwarded room-service path is kept; None for what is never kept (the health check)."""
    rest = path[len(PREFIX):]
    if not path.startswith(PREFIX) or '..' in rest or rest == 'health':
        return None
    return cache / rest if is_file(path) else cache / rest / ANSWER


def save(target, data):
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = tempfile.NamedTemporaryFile(dir=target.parent, delete=False)
    part = Path(temporary.name)
    try:
        with temporary:
            temporary.write(data)
        part.replace(target)
    finally:
        part.unlink(missing_ok=True)


_answer_lock = threading.Lock()
_inflight = {}


@contextmanager
def answer_writer(target):
    """If successful GETs overlap, keep the answer from the most recently started one."""
    with _answer_lock:
        state = _inflight.setdefault(target, {'started': 0, 'saved': 0, 'active': 0, 'lock': threading.Lock()})
        state['started'] += 1
        state['active'] += 1
        order = state['started']

    def publish(data):
        with state['lock']:
            if order > state['saved']:
                save(target, data)
                state['saved'] = order

    try:
        yield publish
    finally:
        with _answer_lock:
            state['active'] -= 1
            if not state['active']:
                del _inflight[target]


def job_files(job, replay):
    """The paths the replay page reads for one job: scaffold first, then room models, then pictures."""
    base = f'{PREFIX}jobs/{job}/replay'
    models = sorted((replay.get('models') or {}).items(), key=lambda kv: (kv[0] != 'seed', kv[0] != 'final', kv[0]))
    pictures = dict.fromkeys(src for e in replay.get('events', [])
                             for src in [e.get('img'), *(m.get('src') for m in e.get('media') or [] if isinstance(m, dict))]
                             if isinstance(src, str))
    return ([f'{base}/scaffold/points.bin', f'{base}/scaffold/layout.json', f'{base}/scaffold/colors.bin'],
            [f'{base}/files/{rel}' for _, rel in models],
            [f'{base}/files/{rel}' for rel in pictures])


class Sync:
    """Downloads what the cache is missing, one file at a time, again every `every` seconds."""

    def __init__(self, backend, cache, every=300, log=print, also=(), control=None):
        self.backend, self.cache, self.every, self.log = backend, Path(cache), every, log
        self.also = [Path(place) for place in also]  # more files (the sample models) or folders to link from
        self.stopped = threading.Event()
        self.absent = set()  # files the service does not have (a room without a thumbnail): not asked again
        self.control = control

    def downloading(self):
        return self.control.download(background=True) if self.control else nullcontext(True)

    def start(self):
        threading.Thread(target=self.run, daemon=True).start()
        return self

    def stop(self):
        self.stopped.set()

    def get(self, path, timeout=60):
        with urllib.request.urlopen(self.backend + path, timeout=timeout) as response:
            return response.read()

    def identity(self, path):
        """The file's size and sha256 as the service gives them, or None when it does not (an older service).
        A 404 is raised, like the GET's."""
        try:
            with urllib.request.urlopen(urllib.request.Request(self.backend + path, method='HEAD'), timeout=60) as response:
                digest = response.headers.get(DIGEST)
                return (int(response.headers['Content-Length']), digest) if digest else None
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise
            return None  # an older service answers 501 to a HEAD

    def answer(self, path):
        with answer_writer(local(self.cache, path)) as publish:
            data = self.get(path)
            answer = json.loads(data)
            publish(data)
            return answer

    def run(self):
        while not self.stopped.is_set():
            try:
                self.once()
            # service not up yet, or the tunnel dropped mid-file (IncompleteRead): try again
            except (OSError, ValueError, KeyError, http.client.HTTPException) as error:
                self.log(f'房间缓存：暂时连不上房间服务（{error}），稍后重试')
                if self.stopped.wait(30):
                    return
                continue
            if self.stopped.wait(self.every):
                return

    def missing(self):
        jobs = self.answer(f'{PREFIX}jobs')['jobs']
        rooms = {room['dir'].rstrip('/').rsplit('/', 1)[-1] for room in self.answer(f'{PREFIX}catalog')['rooms']}
        first, models, pictures, assets = [], [], [], []
        for job in jobs:
            if self.stale(job):
                continue
            files = job_files(job['id'], self.answer(f'{PREFIX}jobs/{job["id"]}/replay'))
            first += files[0]; models += files[1]; pictures += files[2]
            if job['id'] in rooms:
                assets += [f'{PREFIX}assets/{job["id"]}/{name}' for name in ('Room.glb', 'room_objects.json', 'thumbnail.jpg')]
        return [p for p in first + models + assets + pictures if p not in self.absent and not local(self.cache, p).exists()]

    def once(self):
        with self.downloading() as allowed:
            if not allowed:
                return
            missing = self.missing()
        if not missing:
            return
        self.log(f'房间缓存：本地缺 {len(missing)} 个文件，后台下载到 {self.cache}')
        done = linked = 0
        for path in missing:
            if self.stopped.is_set():
                return
            with self.downloading() as allowed:
                if not allowed:
                    return
                try:
                    known = self.identity(path)
                    same = known and same_file([self.cache, *self.also], *known)
                    if same:
                        place(same, local(self.cache, path))
                        done += 1; linked += 1
                        self.log(f'房间缓存：{done}/{len(missing)} {path[len(PREFIX):]}（{known[0] / 1e6:.1f} MB，本机已有相同文件 {same}，未下载）')
                        continue
                    data = self.get(path, timeout=120)
                except urllib.error.HTTPError as error:
                    if error.code == 404:  # e.g. a room without a thumbnail, or a job without a scaffold
                        self.absent.add(path)
                    continue
                if known and (len(data), hashlib.sha256(data).hexdigest()) != known:
                    self.log(f'房间缓存：{path[len(PREFIX):]} 下载的内容与服务器给的 sha256 不符，未保存，稍后重试')
                    continue
                save(local(self.cache, path), data)
            done += 1
            self.log(f'房间缓存：{done}/{len(missing)} {path[len(PREFIX):]}（{len(data) / 1e6:.1f} MB）')
        self.log(f'房间缓存：下载完成（{done} 个文件' + (f'，其中 {linked} 个本机已有相同文件，未下载）' if linked else '）'))

    def stale(self, job):
        """True for a job still running. A job whose record changed since it was cached (retried) loses its
        old files, so they are downloaded again."""
        folder = self.cache / 'jobs' / job['id']
        stamp = folder / 'stamp.json'
        seen = json.loads(stamp.read_text()).get('updated') if stamp.exists() else None
        if seen is not None and seen != job.get('updated'):
            prefixes = (f'{PREFIX}jobs/{job["id"]}/', f'{PREFIX}assets/{job["id"]}/')
            self.absent = {path for path in self.absent if not path.startswith(prefixes)}
            for old in (folder / 'replay/files', folder / 'replay/scaffold', self.cache / 'assets' / job['id']):
                shutil.rmtree(old, ignore_errors=True)
            (folder / 'replay' / ANSWER).unlink(missing_ok=True)
            (folder / ANSWER).unlink(missing_ok=True)
            stamp.unlink()
        if job.get('status') in LIVE:
            return True
        save(stamp, json.dumps({'updated': job.get('updated')}).encode())
        return False


def content_type(path):
    return mimetypes.guess_type(path.name)[0] or 'application/octet-stream'

