"""Photos → reconstructed object for RoomCanvas's editor: upload, masks, reconstruction, progress.

One photo is enough to rebuild; more angles help. 补拍 (capture) adds photos to the object of a
finished run and rebuilds on top of it (run.py --parent-run): the run's photos stay, in order,
their masks are reused, and the run's COVER suggestion says where to shoot next.

Photo import → prepare_masks.py → run.py use the existing data root, cache and GPU lock.
The service and job validation are independent of any reconstruction UI.
Jobs wait their turn for the GPU instead of failing while another job holds the lock.
Measured size is saved afterwards through /viewforge/dimensions/<run>.
"""
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

from PIL import Image

from run import CODE, component, input_manifest
from prepare_masks import file_signatures
from import_photos import import_photos, parent_selection
from reconstruction_backends import backend_name, capabilities, pipeline_stages, run_backend, validate_selection

MIN_PHOTOS, MAX_PHOTOS = 1, 40
MAX_UPLOAD = 400 * 1024 * 1024
GPU_POLL_SECONDS = 2
JOBS, JOBS_LOCK = {}, threading.Lock()


def gpu_lock(root):
    return Path(os.environ.get('VIEWFORGE_GPU_LOCK', str(root/'cache/gpu.lock')))


def gpu_free(root):
    path = gpu_lock(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        fcntl.flock(lock, fcntl.LOCK_UN)
        return True


def check_photos(uploads, room=MAX_PHOTOS):
    """uploads: [(filename, path)]. Every photo is checked before anything is written."""
    if not MIN_PHOTOS <= len(uploads) <= room:
        raise ValueError(f'请上传 {MIN_PHOTOS}–{room} 张照片')
    for filename, path in uploads:
        try:
            with Image.open(path) as image:
                if image.format not in ('JPEG', 'PNG'):
                    raise ValueError
                image.verify()
        except Exception as exc:
            raise ValueError(f'{filename}：不是 JPEG 或 PNG 照片') from exc


def create_object(root, name, uploads):
    try:
        name = component(name)
    except ValueError as exc:
        raise ValueError('名称须为 1–80 个中文、字母、数字、下划线或连字符') from exc
    check_photos(uploads)
    directory = root/'data/inputs'/name
    if directory.exists():
        raise ValueError('这个名称已经有了，换一个')
    (directory/'images').mkdir(parents=True)
    record = import_photos(root, name, [path for _, path in uploads], image_prefix=name)
    return dict(object=name, images=[r['name'] for r in record['images']], errors=record['errors'])


def parent_photos(root, run_id):
    """The object of a finished run and its photos, which a rebuild on top of it has to keep."""
    try:
        run_id = component(run_id)
        if not capabilities(run_backend(root/'runs'/run_id))['capture']:
            raise ValueError('此单图结果不支持补拍')
        name, kept = parent_selection(root, run_id)
        input_manifest(root, name, kept)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError('这个结果不能补拍：原来的重建或照片已经不在了') from exc
    return run_id, name, kept


def add_capture(root, run_id, uploads):
    run_id, name, kept = parent_photos(root, run_id)
    check_photos(uploads, MAX_PHOTOS - len(kept))
    # Named in upload order (capture_<time>_001…), after the object's earlier photos.
    prefix = f'capture_{datetime.now():%Y%m%d_%H%M%S_%f}'
    record = import_photos(root, name, [path for _, path in uploads], parent_run_id=run_id, image_prefix=prefix)
    added = [r['name'] for r in record['images']]
    return dict(object=name, parent=run_id, kept=kept, images=kept + added, added=added, errors=record['errors'])


class Job:
    def __init__(self, kind, root, name, images, command):
        self.id = uuid.uuid4().hex
        self.kind, self.root, self.object, self.images, self.command = kind, root, name, images, command
        self.status, self.error, self.result, self.parent = 'queued', None, None, None
        self.started = time.monotonic()
        self.attempt, self.signatures = None, {}
        self.backend = None

    def view(self):
        data = dict(id=self.id, kind=self.kind, object=self.object, images=self.images,
                    status=self.status, error=self.error,
                    elapsed_seconds=round(time.monotonic() - self.started, 1))
        if self.parent:
            data['parent'] = self.parent
        if self.kind == 'reconstruct':
            if self.backend:
                data.update(backend=self.backend, pipeline_stages=pipeline_stages(self.backend))
            run = self.run_dir()
            state = {}
            if run:
                data['run'] = run.name
                try:
                    state = json.loads((run/'result.json').read_text())
                except (OSError, json.JSONDecodeError):
                    pass
            if self.status == 'running':
                data['stage'] = 'cover' if state.get('cover_status') == 'running' else state.get('current_stage', 'preparing')
        if self.result is not None:
            data.update(self.result)
        return data

    def run_dir(self):
        runs = sorted((self.root/'runs').glob(f'*_{self.object}_{self.attempt}')) if self.attempt else []
        return runs[-1] if runs else None

    def wait_for_gpu(self):
        # Whoever holds the lock (a CLI run or another job) finishes first. The script
        # then takes the lock with --wait-gpu, so losing a race to it only waits a bit longer.
        while not gpu_free(self.root):
            time.sleep(GPU_POLL_SECONDS)
        self.status = 'running'

    def work(self):
        try:
            self.wait_for_gpu()
            logs = self.root/'logs'
            logs.mkdir(parents=True, exist_ok=True)
            with (logs/f'rc_{self.kind}_{self.object}_{datetime.now():%Y%m%d_%H%M%S_%f}.log').open('x') as log:
                process = subprocess.run(self.command, cwd=CODE, stdout=subprocess.PIPE, stderr=log, text=True)
                log.write(process.stdout)
            self.finish(process)
        except Exception as exc:
            self.status, self.error = 'failed', str(exc)

    def finish(self, process):
        if self.kind == 'masks':
            try:
                record = json.loads(process.stdout.strip().splitlines()[-1])
            except (IndexError, json.JSONDecodeError):
                record = dict(status='failed', error='抠图没有输出结果')
            if process.returncode or record.get('status') != 'complete':
                raise RuntimeError(record.get('error') or '抠图未完成')
            task = Path(record['previews'][0]['path']).parent.name if record['previews'] else ''
            # name → (image, mask) signature, so reconstruction can check nothing changed since.
            self.signatures = {row['name']: sig for row, sig in zip(record['images'], record['signatures'])}
            self.result = dict(previews=[dict(name=p['name'], url=f'previews/{task}/{p["name"]}.png')
                                         for p in record['previews']])
        else:
            run = self.run_dir()
            state = json.loads((run/'result.json').read_text()) if run else {}
            if process.returncode or state.get('status') != 'complete':
                raise RuntimeError(state.get('error') or '重建未完成，详见服务器日志')
        self.status = 'complete'


def start(job):
    with JOBS_LOCK:
        JOBS[job.id] = job
    threading.Thread(target=job.work, daemon=True).start()
    return job.view()


def selection(payload):
    name = component(str(payload.get('object', '')))
    images = payload.get('images')
    if not isinstance(images, list) or len(images) < MIN_PHOTOS or not all(isinstance(i, str) for i in images):
        raise ValueError(f'至少选 {MIN_PHOTOS} 张照片')
    return name, [component(i) for i in images]


def start_masks(root, payload):
    name, images = selection(payload)
    command = [sys.executable, str(CODE/'scripts/prepare_masks.py'), '--object', name, '--images', *images, '--wait-gpu']
    return start(Job('masks', root, name, images, command))


def start_reconstruction(root, payload):
    name, images = selection(payload)
    masks = JOBS.get(str(payload.get('masks', '')))
    if masks is None or masks.kind != 'masks' or masks.status != 'complete' or masks.object != name:
        raise ValueError('请先完成抠图预览')
    if not set(images) <= set(masks.signatures):
        raise ValueError('选中的照片没有抠图预览')
    # Bind reconstruction to the exact photos and masks that were previewed.
    rows = input_manifest(root, name, images)['images']
    if any(masks.signatures[row['name']] != sig for row, sig in zip(rows, file_signatures(rows))):
        raise ValueError('照片或抠图已变化，请重新抠图')
    parent = payload.get('parent')
    backend = backend_name()
    if parent:
        parent, parent_name, kept = parent_photos(root, str(parent))
        if parent_name != name or not set(kept) <= set(images):
            raise ValueError('补拍要保留原来的照片')
        backend = run_backend(root/'runs'/parent)
    validate_selection(backend, images, parent)
    attempt = datetime.now().strftime('web_%H%M%S_%f')
    command = [sys.executable, str(CODE/'scripts/run.py'), '--object', name, '--attempt', attempt,
               '--images', *images, '--wait-gpu', *(['--parent-run', parent] if parent else [])]
    if backend != 'mvsam3d' or backend != backend_name():
        command += ['--backend', backend]
    job = Job('reconstruct', root, name, images, command)
    job.attempt, job.parent = attempt, parent or None
    job.backend = backend
    return start(job)


class ObjectsMiddleware:
    def __init__(self, app, root):
        self.app, self.root = app, Path(root)

    async def __call__(self, scope, receive, send):
        prefix = '/viewforge/objects/'
        if scope['type'] != 'http' or not scope['path'].startswith(prefix):
            return await self.app(scope, receive, send)
        from starlette.requests import Request
        from starlette.responses import JSONResponse, FileResponse
        from starlette.concurrency import run_in_threadpool
        from urllib.parse import urlsplit
        request = Request(scope, receive)
        route = scope['path'][len(prefix):]
        try:
            if request.method == 'POST':
                origin = request.headers.get('origin')
                if origin and urlsplit(origin).netloc != request.headers.get('host'):
                    raise ValueError('请在当前页面操作')
            if request.method == 'GET' and route == 'capabilities':
                response = JSONResponse(capabilities(backend_name()))
            elif request.method == 'POST' and route in ('create', 'capture'):
                if int(request.headers.get('content-length') or 0) > MAX_UPLOAD:
                    raise ValueError('照片总量过大')
                form = await request.form(max_files=MAX_PHOTOS + 1, max_fields=4, max_part_size=1024)
                staging = self.root/'cache/uploads'/uuid.uuid4().hex
                staging.mkdir(parents=True)
                try:
                    uploads = []
                    for index, upload in enumerate(form.getlist('photos')):
                        filename = Path(upload.filename or 'photo').name
                        path = staging/(f'{index:03d}_' + re.sub(r'[^\w.-]', '_', filename))
                        with path.open('xb') as out:
                            shutil.copyfileobj(upload.file, out)
                        uploads.append((filename, path))
                    if route == 'create':
                        result = await run_in_threadpool(create_object, self.root, str(form.get('name', '')), uploads)
                    else:
                        result = await run_in_threadpool(add_capture, self.root, str(form.get('run', '')), uploads)
                finally:
                    await form.close()
                    shutil.rmtree(staging, ignore_errors=True)
                response = JSONResponse(result)
            elif request.method == 'POST' and route in ('masks', 'reconstruct'):
                if request.headers.get('content-type', '').split(';')[0] != 'application/json':
                    raise ValueError('需要 JSON')
                body = await request.body()
                if len(body) > 20000:
                    raise ValueError('请求过大')
                payload = json.loads(body)
                if not isinstance(payload, dict):
                    raise ValueError('请求格式错误')
                handler = start_masks if route == 'masks' else start_reconstruction
                response = JSONResponse(await run_in_threadpool(handler, self.root, payload))
            elif request.method == 'GET' and re.fullmatch(r'jobs/[0-9a-f]{32}', route):
                job = JOBS.get(route[5:])
                if job is None:
                    raise FileNotFoundError('没有这个任务（服务可能重启过）')
                response = JSONResponse(job.view())
            elif request.method == 'GET' and re.fullmatch(r'previews/\w+/[\w.-]+\.png', route):
                _, task, filename = route.split('/')
                file = self.root/'cache/mask_previews'/task/filename
                if not file.is_file():
                    raise FileNotFoundError('没有这张预览')
                response = FileResponse(file, media_type='image/png')
            else:
                response = JSONResponse(dict(error='接口不存在'), status_code=404)
        except FileNotFoundError as exc:
            response = JSONResponse(dict(error=str(exc)), status_code=404)
        except (ValueError, KeyError, TypeError) as exc:
            response = JSONResponse(dict(error=str(exc)), status_code=400)
        response.headers['Cache-Control'] = 'no-store'
        await response(scope, receive, send)
