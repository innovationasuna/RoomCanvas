"""Select existing views, reconstruct, and display results using upstream's gr.Model3D."""
import argparse
import html
from urllib.parse import quote
from datetime import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tempfile
import uuid
import fcntl
import shutil

from PIL import Image, ImageOps

import gradio as gr
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
import run as runner
from mask_state import Confirmation, selection_key
from prepare_masks import file_signatures
from import_photos import import_photos, parent_selection, source_metadata
from cover_scene import ensure_preview
from dimensions import DimensionsMiddleware
from assets import AssetsMiddleware
from objects import ObjectsMiddleware

ROOT = Path(os.environ['VIEWFORGE_ROOT']).resolve()
CODE = Path(__file__).resolve().parents[1]


def objects():
    return sorted(p.name for p in (ROOT/'data/inputs').iterdir()
                  if p.is_dir() and (p/'images').is_dir()
                  and not (p/'.viewforge-hidden').exists())


def object_choices():
    return [(f'{name}（{sum(p.is_file() and p.suffix in (".png", ".jpg") for p in (ROOT/"data/inputs"/name/"images").iterdir())} 张）', name)
            for name in objects()]


def format_duration(seconds):
    total = max(0, int(seconds))
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f'{hours:02d}:{minutes:02d}:{seconds:02d}' if hours else f'{minutes:02d}:{seconds:02d}'


def photo_preview(image):
    source = Path(image)
    stat = source.stat()
    folder = ROOT/'cache/photo_previews'/source.relative_to(ROOT/'data/inputs').parent
    target = folder/f'{source.name}.{stat.st_mtime_ns}.{stat.st_size}.jpg'
    if not target.is_file():
        folder.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as original:
            preview = ImageOps.exif_transpose(original).convert('RGB')
            preview.thumbnail((960, 960), Image.Resampling.LANCZOS)
            with tempfile.NamedTemporaryFile(dir=folder, suffix='.jpg', delete=False) as temp:
                temporary = Path(temp.name)
            try:
                preview.save(temporary, format='JPEG', quality=82, optimize=True)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    return str(target)


def images_for(name):
    # Selection changes only list files; preparation/reconstruction still decode
    # and validate the inputs. Avoid rereading every full-resolution photo here.
    if not name or not any(p.is_file() for p in (ROOT/'data/inputs'/name/'images').iterdir()):
        return []
    rows = runner.selected_images(ROOT, name, validate=False)['images']
    imported = []
    for row in rows:
        row['image'] = photo_preview(row['image'])
        row['label'] = row['name']
        if (ROOT/'data/inputs'/name/'imports'/f'{row["name"]}.json').is_file():
            meta = source_metadata(ROOT, name, row['name'])
            filename = Path(meta.get('display_name') or meta.get('original_filename') or '照片').name
            row['upload_kind'] = '补拍' if meta.get('parent_run_id') else '新图片'
            imported.append((meta.get('created_at', ''), row['name'], filename, row))
    counts = {}
    for _, _, filename, row in sorted(imported, key=lambda item: item[:2]):
        counts[filename] = counts.get(filename, 0) + 1
        suffix = f"（{counts[filename]}）" if counts[filename] > 1 else ''
        row['label'] = f'{row["upload_kind"]} · {filename}{suffix}'
    return rows


def choose_object(name, confirmation):
    confirmation.parent_run_id = None
    rows = images_for(name)
    names = [row['name'] for row in rows]
    confirmation.invalidate(name, names)
    return (gr.update(choices=[(r['label'], r['name']) for r in rows], value=names), [(r['image'], r['label']) for r in rows],
            f'已选择 {len(rows)} 张照片', gr.update(value='准备预览', interactive=True), '')


def choose_images(name, selected, confirmation):
    selected = list(selected or [])
    with confirmation.lock:
        parent_run_id = confirmation.parent_run_id
    required = []
    if parent_run_id:
        parent_object, required = parent_selection(ROOT, parent_run_id)
        if parent_object != name:
            raise gr.Error('补拍父运行与当前物体不一致，请重新选择历史结果')
        selected = required + [item for item in selected if item not in required]
    confirmation.invalidate(name, selected)
    rows = [row for row in images_for(name) if row['name'] in selected]
    message = (f'补拍模式：已锁定上轮 {len(required)} 张照片，可继续添加新视角'
               if required else '')
    return (gr.update(value=selected), [(r['image'], r['label']) for r in rows],
            f'已选择 {len(rows)} 张照片', gr.update(value='准备预览', interactive=True), message)


def completed_runs():
    return sorted((p.name for p in (ROOT/'runs').iterdir()
                   if (p/'reconstruction/result.ply').is_file()
                   and (p/'reconstruction/result.glb').is_file()), reverse=True)


def reconstruction_tracker():
    runs = ROOT/'runs'
    if not runs.is_dir():
        return '### 重建跟踪\n暂无重建记录。'
    records = [p for p in runs.iterdir() if p.is_dir() and (p/'result.json').is_file()]
    if not records:
        return '### 重建跟踪\n暂无重建记录。'
    run = max(records, key=lambda p: (p/'result.json').stat().st_mtime_ns)
    try:
        state = json.loads((run/'result.json').read_text())
    except (OSError, json.JSONDecodeError):
        return f'### 重建跟踪\n`{run.name}` · 正在读取持久化状态…'
    timing = state.get('timing') or state.get('web_timing') or {}
    elapsed_seconds = timing.get('elapsed_seconds')
    if elapsed_seconds is None and timing.get('started_at'):
        try:
            elapsed_seconds = (datetime.now().astimezone() - datetime.fromisoformat(timing['started_at'])).total_seconds()
        except (TypeError, ValueError):
            elapsed_seconds = 0
    elapsed = format_duration(elapsed_seconds or 0)
    status = state.get('status')
    stage = state.get('current_stage')
    if status == 'failed':
        detail = f'失败：{state.get("error", "未知错误")}'
    elif state.get('cover_status') == 'running' or stage == 'cover':
        detail = '阶段 3/3 · 正在计算补拍建议'
    elif stage == 'reconstruction':
        detail = '阶段 2/3 · 正在重建三维模型'
    elif stage == 'da3':
        detail = '阶段 1/3 · 正在估计深度与相机'
    elif status in ('preparing', 'running'):
        detail = '阶段 0/3 · 正在准备输入和 GPU'
    elif status == 'complete':
        detail = ('重建完成' if state.get('cover_status') in (None, 'complete')
                  else '模型已完成，补拍建议计算失败')
    else:
        detail = f'状态：{status or "未知"}'
    return f'### 重建跟踪\n`{run.name}` · {detail} · 用时 {elapsed}'


def load_result(name, mode="GLB 网格"):
    if not name:
        return gr.update()
    if name not in completed_runs():
        raise gr.Error('找不到这次重建的模型文件')
    run = ROOT/'runs'/runner.component(name)
    manifest = ensure_preview(run)
    manifest_url = '/gradio_api/file=' + quote(str(manifest), safe='/')
    asset_url = '/gradio_api/file=' + quote(str(CODE/'scripts/assets/cover-viewer.html'), safe='/')
    version = (CODE/'scripts/assets/cover-viewer-build.json').stat().st_mtime_ns
    src = asset_url + '?v=' + str(version) + '&manifest=' + quote(manifest_url, safe='')
    return gr.update(value=f'<iframe id="viewforge-cover-viewer" title="三维模型与补拍建议" src="{html.escape(src, quote=True)}" style="width:100%;height:560px;border:0"></iframe>')


def open_result(name, confirmation):
    with confirmation.lock:
        confirmation.invalidate(*confirmation.key)
        confirmation.parent_run_id = None
        confirmation.displayed_run_id = name
    return load_result(name), (f'当前模型与建议来自：{name}' if name else ''), gr.update(value='GLB 网格')


def resume_capture(run_id, confirmation):
    if not run_id:
        raise gr.Error('请先选择已完成的重建')
    name, names = parent_selection(ROOT, run_id)
    rows = images_for(name)
    available = {r['name']: r for r in rows}
    if not set(names).issubset(available):
        raise gr.Error('原运行照片已不可用')
    with confirmation.lock:
        confirmation.invalidate(name, names)
        confirmation.parent_run_id = run_id
    return (gr.update(value=name), gr.update(choices=[(r['label'], r['name']) for r in rows], value=names),
            [(available[n]['image'], available[n]['label']) for n in names],
            f'保留上轮 {len(names)} 张照片，上传补拍照片后准备预览',
            gr.update(value='准备预览', interactive=True), f'补拍基于：{run_id}')


def upload_photos(files, name, selected, confirmation, *, capture=False, image_prefix=None):
    if not files or not name:
        raise gr.Error('请选择物体并上传 JPEG/PNG 照片')
    with confirmation.lock:
        if capture and not confirmation.parent_run_id:
            raise gr.Error('请先在历史结果中点击“基于这次结果补拍”')
        if not capture:
            confirmation.parent_run_id = None
        token = (confirmation.generation, confirmation.key)
        parent = confirmation.parent_run_id if capture else None
    record = import_photos(ROOT, name, files, parent, image_prefix=image_prefix)
    with confirmation.lock:
        if not confirmation.current(token):
            return tuple(gr.update() for _ in range(6))
        names = list(selected or []) + [r['name'] for r in record['images']]
        confirmation.invalidate(name, names)
    rows = images_for(name)
    mapping = {r['name']:r for r in rows}
    errors = '; '.join(r['filename'] + ': ' + r['error'] for r in record['errors'])
    kind = '补拍照片' if capture else '新图片'
    return (gr.update(choices=[(r['label'], r['name']) for r in rows], value=names),
            [(mapping[n]['image'], mapping[n]['label']) for n in names], f'已选择 {len(names)} 张照片',
            gr.update(value='准备预览', interactive=True),
            f'已添加 {len(record["images"])} 张{kind}，请准备预览。' + errors, gr.update(value=None))


def upload_new_photos(files, name, selected, confirmation, upload_name=''):
    if upload_name is None:
        # Cancelled naming: leave the current object and its selection untouched.
        return (gr.update(), gr.update(), gr.update(), gr.update(),
                '已取消新物体上传，当前物体未改变。', gr.update(value=None), gr.update())
    if not files:
        raise gr.Error('请上传 JPEG/PNG 图片')
    # Each ordinary upload batch is a separate object, independent of the
    # currently selected object and its reconstruction lineage.
    name = upload_name.strip()
    if not name:
        raise gr.Error('请先为新物体命名，再上传图片')
    try:
        runner.component(name)
    except ValueError as exc:
        raise gr.Error('名称须为 1–80 个中文、字母、数字、下划线或连字符，不能包含路径') from exc
    if (ROOT/'data/inputs'/name).exists():
        raise gr.Error('这个物体名称已存在，请换一个名称')
    (ROOT/'data/inputs'/name/'images').mkdir(parents=True, exist_ok=False)
    result = upload_photos(files, name, [], confirmation, capture=False,
                           image_prefix=name if upload_name.strip() else None)
    return (*result, gr.update(choices=object_choices(), value=name))


def upload_capture_photos(files, name, selected, confirmation):
    return upload_photos(files, name, selected, confirmation, capture=True)


def remove_photos(name, selected, confirmation):
    if not name or not selected:
        raise gr.Error('请勾选需要移除的图片')
    directory = ROOT/'data/inputs'/runner.component(name)
    rows = runner.selected_images(ROOT, name, selected, validate=False)['images']
    if confirmation.parent_run_id:
        _, required = parent_selection(ROOT, confirmation.parent_run_id)
        if set(selected) & set(required):
            raise gr.Error('补拍模式下不能移除父运行的照片，请先重新选择物体退出补拍模式')
    lock_path = Path(os.environ.get('VIEWFORGE_GPU_LOCK', str(ROOT/'cache/gpu.lock')))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise gr.Error('当前有 GPU 任务运行，请完成后再移除图片')
        archive = ROOT/'data/removed'/name/f'{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:8]}'
        archive.mkdir(parents=True)
        for row in rows:
            image_id = runner.component(row['name'])
            paths = [Path(row['image']), directory/'imports'/f'{image_id}.json']
            paths += [directory/'masks'/f'{image_id}{suffix}' for suffix in ('.png', '_mask.png', '.jpg', '_mask.jpg')]
            paths += [directory/'originals'/f'{image_id}{suffix}' for suffix in ('.jpg', '.png')]
            for source in paths:
                if not source.exists() and not source.is_symlink():
                    continue
                target = archive/source.relative_to(directory)
                target.parent.mkdir(parents=True, exist_ok=True)
                # Preserve historical staged inputs when their source is archived.
                links = [p for p in (ROOT/'runs').glob('*/input/*/*')
                         if p.is_symlink() and p.resolve() == source.resolve()]
                shutil.move(str(source), str(target))
                for link in links:
                    link.unlink()
                    link.symlink_to(target)
    remaining = [p for p in (directory/'images').iterdir() if p.is_file()]
    confirmation.parent_run_id = None
    confirmation.invalidate(name, [])
    available = images_for(name) if remaining else []
    return (gr.update(choices=[(r['label'], r['name']) for r in available], value=[]), [],
            '已选择 0 张照片', gr.update(value='准备预览', interactive=True),
            f'已移除 {len(rows)} 张图片；可从 {archive} 恢复。',
            gr.update(choices=object_choices(), value=name))


def remove_object(name, confirmation):
    if not name:
        raise gr.Error('请先选择需要删除的物体')
    directory = ROOT/'data/inputs'/runner.component(name)
    if directory.is_symlink() or not directory.is_dir():
        raise gr.Error('物体目录不存在或不是独立素材目录')
    lock_path = Path(os.environ.get('VIEWFORGE_GPU_LOCK', str(ROOT/'cache/gpu.lock')))
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise gr.Error('当前有 GPU 任务运行，请完成后再删除物体')
        archive = ROOT/'data/removed'/name/f'{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:8]}'
        archive.parent.mkdir(parents=True, exist_ok=True)
        links = []
        for link in (ROOT/'runs').glob('*/input/*/*'):
            if link.is_symlink():
                source = link.resolve()
                if source.is_relative_to(directory):
                    links.append((link, archive/source.relative_to(directory)))
        shutil.move(str(directory), str(archive))
        for link, target in links:
            link.unlink()
            link.symlink_to(target)
    choices = object_choices()
    next_name = choices[0][1] if choices else None
    result = choose_object(next_name, confirmation)
    return (*result[:4], f'已删除物体 {name}；素材可从 {archive} 恢复，历史重建结果保留。',
            gr.update(choices=choices, value=next_name))


def retry_cover(run_id, confirmation):
    with confirmation.lock:
        token = (confirmation.generation, confirmation.key)
    if run_id not in completed_runs():
        raise gr.Error('请选择已完成的重建')
    run = ROOT/'runs'/runner.component(run_id)
    with (run/'logs/cover-retry.log').open('a') as log:
        result = subprocess.run([sys.executable, str(CODE/'scripts/run_cover.py'), '--run-dir', str(run)],
                                cwd=CODE, stdout=log, stderr=subprocess.STDOUT)
    if not confirmation.current(token):
        return gr.update(), gr.update()
    return load_result(run_id), ('补拍建议已更新' if result.returncode == 0 else '补拍建议计算失败，重建模型保留')


def run_job(name, selected, prepared, confirmation, token):
    if not name or not selected:
        raise gr.Error('请至少选择一张照片')
    inputs = runner.input_manifest(ROOT, name, selected)
    if file_signatures(inputs['images']) != prepared['signatures']:
        raise ValueError('照片或 mask 已变化，请重新准备预览')
    attempt = datetime.now().strftime('web_%H%M%S_%f')
    run = ROOT/'runs'/f'{datetime.now():%Y%m%d}_{name}_{attempt}'
    log_path = ROOT/'logs'/f'{run.name}.log'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(CODE/'scripts/run.py'), '--object', name,
               '--attempt', attempt, '--images', *selected]
    if confirmation.parent_run_id:
        command += ['--parent-run', confirmation.parent_run_id]
    started = time.monotonic()
    empty = [gr.update()]
    yield '正在检查输入和 GPU… · 已用时 00:00', *empty, gr.update(), gr.update()
    with log_path.open('x') as log:
        with confirmation.lock:
            if not confirmation.current(token):
                return
            process = subprocess.Popen(command, cwd=CODE, stdout=log, stderr=subprocess.STDOUT)
        while process.poll() is None:
            state = {}
            try:
                state = json.loads((run/'result.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            stage = ('cover' if state.get('cover_status') == 'running' else state.get('current_stage', ''))
            label = {'da3': '正在估计深度与相机', 'reconstruction': '正在重建三维模型', 'cover': '正在计算补拍建议'}.get(stage, '正在准备运行')
            elapsed = format_duration(time.monotonic() - started)
            yield f'{label} · {len(selected)} 张照片 · 已用时 {elapsed}\n\n运行：`{run.name}`。当前保留的预览仍来自上次结果。', *empty, gr.update(), gr.update()
            time.sleep(2)
    elapsed_seconds = time.monotonic() - started
    elapsed = format_duration(elapsed_seconds)
    state = {}
    try:
        state = json.loads((run/'result.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if process.returncode != 0 or state.get('status') != 'complete':
        yield f'运行失败 · 用时 {elapsed}：{state.get("error", "重建未完成")}。', *empty, gr.update(), gr.update()
        return
    with confirmation.lock:
        if not confirmation.current(token):
            return
        # A completed run is not implicitly a capture parent. Entering capture
        # mode always requires an explicit click on "基于这次结果补拍".
        confirmation.parent_run_id = None
        confirmation.displayed_run_id = run.name
    yield f'重建完成 · {len(selected)} 张照片 · 总用时 {elapsed}', load_result(run.name), gr.update(choices=completed_runs(), value=run.name), gr.update(value="GLB 网格")


def main_action(name, selected, confirmation):
    """Both phases use the same Gradio serial queue; waiting for confirmation is CPU-only."""
    if not name or not selected:
        raise gr.Error('请至少选择一张照片')
    with confirmation.lock:
        # A restored browser page can outlive its server-side session state.
        # Rebind the submitted selection, but always require a fresh preview.
        if confirmation.key != selection_key(name, selected):
            if confirmation.key[0] != name:
                confirmation.parent_run_id = None
            confirmation.invalidate(name, selected)
        try:
            prepared = confirmation.confirmed(name, selected)
        except ValueError:
            prepared = None
        token = confirmation.begin(name, selected)
    unchanged = [gr.update() for _ in range(3)]
    if prepared is not None:
        # The server-side record, rather than the button label, authorizes this run.
        try:
            for result in run_job(name, selected, prepared, confirmation, token):
                if confirmation.current(token):
                    yield (*result, gr.update(), gr.update(value='正在重建…', interactive=False))
            if confirmation.finish(token, prepared):
                yield (gr.update(), *unchanged, gr.update(), gr.update(value='开始重建', interactive=True))
        except Exception as exc:
            if confirmation.current(token):
                yield (f'重建未启动或失败：{exc}', *unchanged, gr.update(), gr.update(value='准备预览', interactive=True))
        return
    yield ('正在检查并补齐 mask…' + (f' 当前模型与建议仍来自：{confirmation.displayed_run_id}' if confirmation.displayed_run_id else ''), *unchanged, gr.update(), gr.update(value='正在准备…', interactive=False))
    log_path = ROOT/'logs'/f'mask_web_{datetime.now():%Y%m%d_%H%M%S_%f}.log'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with log_path.open('x') as log:
            process = subprocess.run([sys.executable, str(CODE/'scripts/prepare_masks.py'),
                '--object', name, '--images', *selected], cwd=CODE,
                stdout=subprocess.PIPE, stderr=log, text=True)
            log.write(process.stdout)
        record = json.loads(process.stdout)
        if process.returncode or record.get('status') != 'complete':
            raise ValueError(record.get('error', 'mask 准备未完成'))
        if confirmation.finish(token, record):
            labels = {r['name']: r['label'] for r in images_for(name)} if record['previews'] else {}
            gallery = [(r['path'], labels[r['name']]) for r in record['previews']]
            yield ('',
                   *unchanged, gallery, gr.update(value='开始重建', interactive=True))
    except Exception as exc:
        if confirmation.current(token):
            yield (f'准备失败：{exc}', *unchanged, gr.update(), gr.update(value='准备预览', interactive=True))


def build_app():
    choices = object_choices()
    first = choices[0][1] if choices else None
    rows = images_for(first)
    with gr.Blocks(analytics_enabled=False, title='ViewForge', js=(CODE/'scripts/assets/gallery-retry.js').read_text(), theme=gr.themes.Soft(), css="""
footer {display:none!important}
.photo-upload-button {background:#4b5563!important;border-color:#4b5563!important;color:white!important;}
.photo-upload-button:hover {background:#4f46e5!important;border-color:#4f46e5!important;}
#new-object-name {display:none!important;}
#photo-gallery {flex-grow:0!important;min-height:0!important;height:auto!important;}
#photo-gallery .grid-wrap.fixed-height {min-height:0!important;max-height:none!important;height:auto!important;overflow-y:visible!important;}
#photo-gallery:has(.preview) {height:clamp(360px,55vh,560px)!important;}
#photo-gallery:has(.preview) .gallery-container {height:100%!important;}
#photo-gallery .grid-container {grid-template-rows:none;grid-template-columns:repeat(4,minmax(0,1fr))!important;grid-auto-rows:max-content;align-items:start;}
#photo-gallery .gallery-item {height:auto;}
#photo-gallery .thumbnail-lg {display:flex;flex-direction:column;height:auto;aspect-ratio:auto;}
#photo-gallery .thumbnail-lg > img {display:block;flex:none;width:100%;height:auto;object-fit:contain;}
#photo-gallery .caption-label {flex:none;}
#photo-gallery .caption-label {position:static;max-width:100%;width:100%;box-sizing:border-box;
    border:0;border-radius:0;padding:3px 6px;margin:0;font-size:12px;line-height:18px;
    font-weight:400;text-align:center;opacity:1;}
@media (max-width:700px) {
    #photo-gallery .grid-container {grid-template-columns:repeat(2,minmax(0,1fr))!important;}
}
""") as demo:
        confirmation = gr.State(Confirmation(first, [r['name'] for r in rows]))
        gr.Markdown('# ViewForge')
        with gr.Row():
            with gr.Column(scale=1):
                obj = gr.Dropdown(choices, value=first, label='输入物体', interactive=True, filterable=False)
                selected = gr.CheckboxGroup([(r['label'], r['name']) for r in rows], value=[r['name'] for r in rows], label='参与重建的照片', interactive=True)
                upload_name = gr.Textbox(value='', show_label=False, elem_id='new-object-name')
                with gr.Row():
                    new_uploads = gr.UploadButton('上传新图片', file_count='multiple',
                                                  file_types=['.jpg','.jpeg','.png'], type='filepath',
                                                  variant='secondary', size='lg', elem_id='new-photo-upload', elem_classes=['photo-upload-button'])
                    capture_uploads = gr.UploadButton('上传补拍图片', file_count='multiple',
                                                      file_types=['.jpg','.jpeg','.png'], type='filepath',
                                                      variant='secondary', size='lg', elem_classes=['photo-upload-button'])
                gr.Markdown('已选照片')
                gallery = gr.Gallery([(r['image'], r['label']) for r in rows], label='已选照片', elem_id='photo-gallery', show_label=False, columns=4, height='auto', interactive=False)
                count = gr.Markdown(f'已选择 {len(rows)} 张照片')
                with gr.Row():
                    delete_button = gr.Button('删除所选图片', variant='secondary')
                    delete_object_button = gr.Button('删除当前物体', variant='secondary')
                start = gr.Button('准备预览', variant='primary')
                status = gr.Markdown('')
                tracker = gr.Markdown(reconstruction_tracker(), elem_id='reconstruction-tracker')
            with gr.Column(scale=1):
                mode = gr.Radio(['GLB 网格', 'Gaussian'], value='GLB 网格', label='预览模式')
                mesh = gr.HTML()
                with gr.Accordion('查看已有结果与继续补拍', open=False):
                    history = gr.Dropdown(completed_runs(), value=None, label='已完成的重建', interactive=True)
                    refresh = gr.Button('刷新结果列表')
                    resume = gr.Button('基于这次结果补拍')
                    retry = gr.Button('重新计算补拍建议')
        # `.input` defaults to `once`: rapid changes while a callback is pending
        # would be dropped even though the checkboxes already show them.
        obj.input(choose_object, [obj, confirmation], [selected, gallery, count, start, status], queue=False, trigger_mode='always_last')
        selected.input(choose_images, [obj, selected, confirmation], [selected, gallery, count, start, status], queue=False, trigger_mode='always_last')
        new_uploads.upload(upload_new_photos, [new_uploads, obj, selected, confirmation, upload_name],
                           [selected, gallery, count, start, status, new_uploads, obj], queue=False,
                           js="(files, object, selected, state, name) => [files, object, selected, state, window.__viewforgeNameUploadedObject()]")
        delete_button.click(remove_photos, [obj, selected, confirmation],
                            [selected, gallery, count, start, status, obj],
                            queue=False, show_progress='hidden')
        delete_object_button.click(remove_object, [obj, confirmation],
                                   [selected, gallery, count, start, status, obj],
                                   queue=False, show_progress='hidden')
        capture_uploads.upload(upload_capture_photos, [capture_uploads, obj, selected, confirmation],
                               [selected, gallery, count, start, status, capture_uploads], queue=False)
        history.input(open_result, [history, confirmation], [mesh, status, mode], queue=False, trigger_mode='always_last')
        mode.input(None, [mode], js="""(mode) => { const frame=document.getElementById('viewforge-cover-viewer'); if(frame) frame.contentWindow.postMessage({type:'viewforge-mode',mode:mode==='Gaussian'?'gaussian':'glb'}, location.origin); }""", queue=False)
        refresh.click(lambda: gr.update(choices=completed_runs()), outputs=history, queue=False)
        resume.click(resume_capture, [history, confirmation], [obj, selected, gallery, count, start, status], queue=False)
        retry.click(retry_cover, [history, confirmation], [mesh, status], concurrency_limit=1, concurrency_id='reconstruction')
        start.click(main_action, [obj, selected, confirmation], [status, mesh, history, mode, gallery, start],
                    concurrency_limit=1, concurrency_id='reconstruction', trigger_mode='once',
                    show_progress='hidden', api_name='prepare_or_reconstruct')
        tracker_timer = gr.Timer(value=2.0, active=True)
        tracker_timer.tick(reconstruction_tracker, outputs=tracker, queue=False, show_progress='hidden')
        demo.load(reconstruction_tracker, outputs=tracker, queue=False, show_progress='hidden')
    return demo


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=7860)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    build_app().queue().launch(server_name=args.host, server_port=args.port, share=False, show_api=False,
                              allowed_paths=[str(ROOT/'data/inputs'), str(ROOT/'runs'), str(ROOT/'cache/mask_previews'), str(ROOT/'cache/photo_previews'), str(CODE/'scripts/assets')], show_error=True,
                              app_kwargs={'middleware': [Middleware(GZipMiddleware, minimum_size=1024, compresslevel=3),
                                                        Middleware(DimensionsMiddleware, root=ROOT),
                                                        Middleware(AssetsMiddleware, root=ROOT),
                                                        Middleware(ObjectsMiddleware, root=ROOT)]})
