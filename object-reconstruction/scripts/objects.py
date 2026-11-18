"""Photos → reconstructed object for RoomCanvas's editor: upload, masks, reconstruction, progress.

One photo is enough to rebuild; more angles help. 补拍 (capture) adds photos to the object of a
finished run and rebuilds on top of it (run.py --parent-run): the run's photos stay, in order,
their masks are reused, and the run's COVER suggestion says where to shoot next.

Photo import → prepare_masks.py → run.py use the existing data root, cache and GPU lock.
The service and job validation are independent of any reconstruction UI.
Jobs wait their turn for the GPU instead of failing while another job holds the lock.
Measured size is saved afterwards through /viewforge/dimensions/<run>.
"""
import asyncio
from contextlib import ExitStack
from datetime import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
import uuid

from run import CODE, component, input_manifest, match_masks, object_lease, selected_images
from roomcanvas_gpu import WAIT_SECONDS
from prepare_masks import file_signatures
from import_photos import import_photos, parent_selection

MIN_PHOTOS, MAX_PHOTOS = 1, 40
# Photo and run ids are built from the name and must stay valid names (80 characters):
# runs are <date>_<name>_web_<time> (27 more), photos <name>_001 (4 more).
MAX_NAME = 53
MAX_UPLOAD = 400 * 1024 * 1024
JOBS, JOBS_LOCK = {}, threading.Lock()


def import_uploads(root, name, uploads, room=MAX_PHOTOS, **options):
    if not MIN_PHOTOS <= len(uploads) <= room:
        raise ValueError(f'请上传 {MIN_PHOTOS}–{room} 张照片')
    filenames, paths = zip(*uploads)
    record = import_photos(root, name, paths, filenames=filenames, **options)
    if not record['images']:
        raise ValueError('；'.join(f"{row['filename']}：{row['error']}" for row in record['errors']))
    return record


def create_object(root, name, uploads):
    try:
        name = component(name)
        if len(name) > MAX_NAME:
            raise ValueError
    except ValueError as exc:
        raise ValueError(f'名称须为 1–{MAX_NAME} 个中文、字母、数字、下划线或连字符') from exc
    record = import_uploads(root, name, uploads, image_prefix=name, create=True)
    return dict(object=name, images=[r['name'] for r in record['images']], errors=record['errors'])


def parent_photos(root, run_id):
    """The object of a finished run and its photos, which a rebuild on top of it has to keep."""
    try:
        run_id = component(run_id)
        name, kept = parent_selection(root, run_id)
        input_manifest(root, name, kept)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError('这个结果不能补拍：原来的重建或照片已经不在了') from exc
    return run_id, name, kept


def add_capture(root, run_id, uploads):
    run_id, name, kept = parent_photos(root, run_id)
    # Named in upload order (capture_<time>_001…), after the object's earlier photos.
    prefix = f'capture_{datetime.now():%Y%m%d_%H%M%S_%f}'
    record = import_uploads(root, name, uploads, MAX_PHOTOS - len(kept), parent_run_id=run_id, image_prefix=prefix)
    added = [r['name'] for r in record['images']]
    return dict(object=name, parent=run_id, kept=kept, images=kept + added, added=added, errors=record['errors'])


class Job:
    def __init__(self, kind, root, name, images, command):
        self.id = uuid.uuid4().hex
        self.kind, self.root, self.object, self.images, self.command = kind, root, name, images, command
        self.status, self.error, self.result, self.parent = 'queued', None, None, None
        self.started = time.monotonic()
        self.attempt, self.signatures = None, {}

    def view(self):
        data = dict(id=self.id, kind=self.kind, object=self.object, images=self.images,
                    status=self.status, error=self.error,
                    elapsed_seconds=round(time.monotonic() - self.started, 1))
        if self.parent:
            data['parent'] = self.parent
        if self.kind == 'reconstruct':
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

    def needs_gpu(self):
        """Masks that all exist already are only previewed, which needs no GPU."""
        if self.kind != 'masks':
            return True
        try:
            rows = match_masks(selected_images(self.root, self.object, self.images, validate=False),
                               allow_missing=True)['images']
        except (ValueError, OSError):
            return True  # prepare_masks.py reports it
        return any(row['mask'] is None for row in rows)

    def hold_gpu(self, stack):
        """Wait here, while the job still shows as queued, behind whoever holds the card (a CLI run,
        a room or another job). The script inherits the held lease and never waits again."""
        try:
            return stack.enter_context(object_lease(self.root, wait=True))
        except TimeoutError:
            raise RuntimeError(f'GPU 被其他任务占用已超过 {WAIT_SECONDS // 60} 分钟，请稍后重试') from None

    def work(self):
        try:
            with ExitStack() as stack:
                lease = self.hold_gpu(stack) if self.needs_gpu() else None
                command = self.command if lease is None else [
                    *self.command[:2], '--lock-fd', str(lease.fd), *self.command[2:]]
                self.status = 'running'
                logs = self.root/'logs'
                logs.mkdir(parents=True, exist_ok=True)
                with (logs/f'rc_{self.kind}_{self.object}_{datetime.now():%Y%m%d_%H%M%S_%f}.log').open('x') as log:
                    process = subprocess.run(command, cwd=CODE, stdout=subprocess.PIPE, stderr=log, text=True,
                                             pass_fds=lease.fds if lease else ())
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
    if parent:
        parent, parent_name, kept = parent_photos(root, str(parent))
        if parent_name != name or not set(kept) <= set(images):
            raise ValueError('补拍要保留原来的照片')
    attempt = datetime.now().strftime('web_%H%M%S_%f')
    command = [sys.executable, str(CODE/'scripts/run.py'), '--object', name, '--attempt', attempt,
               '--images', *images, '--wait-gpu', *(['--parent-run', parent] if parent else [])]
    job = Job('reconstruct', root, name, images, command)
    job.attempt, job.parent = attempt, parent or None
    return start(job)


class ObjectsMiddleware:
    def __init__(self, app, root):
        self.app, self.root = app, Path(root)
        self.upload_slots = asyncio.Semaphore(2)

    def import_form(self, route, form):
        from starlette.datastructures import UploadFile
        files = form.getlist('photos')
        if any(not isinstance(upload, UploadFile) for upload in files):
            raise ValueError('请上传照片文件')
        # Starlette already spooled these streams. The worker copies each accepted original just once.
        uploads = [(Path(upload.filename or 'photo').name, upload.file) for upload in files]
        if route == 'create':
            return create_object(self.root, str(form.get('name', '')), uploads)
        return add_capture(self.root, str(form.get('run', '')), uploads)

    async def __call__(self, scope, receive, send):
        prefix = '/viewforge/objects/'
        if scope['type'] != 'http' or not scope['path'].startswith(prefix):
            return await self.app(scope, receive, send)
        from starlette.requests import Request
        from starlette.formparsers import MultiPartException
        from starlette.exceptions import HTTPException
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
            if request.method == 'POST' and route in ('create', 'capture'):
                if int(request.headers.get('content-length') or 0) > MAX_UPLOAD:
                    raise ValueError('照片总量过大')
                received = 0
                async def read_upload():
                    nonlocal received
                    message = await receive()
                    # Multipart parsing handles this exception by closing its partial spool files.
                    if message['type'] == 'http.disconnect':
                        raise MultiPartException('上传中断，请重新提交')
                    received += len(message.get('body', b''))
                    if received > MAX_UPLOAD:
                        raise MultiPartException('照片总量过大')
                    return message

                upload = Request(scope, read_upload)
                async with self.upload_slots:
                    try:
                        async with upload.form(max_files=MAX_PHOTOS + 1, max_fields=4, max_part_size=1024) as form:
                            result = await run_in_threadpool(self.import_form, route, form)
                        response = JSONResponse(result)
                    except (MultiPartException, HTTPException) as exc:
                        message = exc.message if isinstance(exc, MultiPartException) else exc.detail
                        raise ValueError(message) from exc
                    except OSError:
                        response = JSONResponse(dict(error='照片未保存，请检查存储后重试'), status_code=500)
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
