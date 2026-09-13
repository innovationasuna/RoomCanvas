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

import gradio as gr
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
import run as runner

ROOT = Path(os.environ['VIEWFORGE_ROOT']).resolve()
CODE = Path(__file__).resolve().parents[1]


def objects():
    return sorted(p.name for p in (ROOT/'data/inputs').iterdir()
                  if p.is_dir() and (p/'images').is_dir() and (p/'masks').is_dir())


def images_for(name):
    return runner.input_manifest(ROOT, name)['images'] if name else []


def choose_object(name):
    rows = images_for(name)
    names = [row['name'] for row in rows]
    return gr.update(choices=names, value=names), [(r['image'], r['name']) for r in rows], f'已选择 {len(rows)} 张照片'


def choose_images(name, selected):
    rows = [row for row in images_for(name) if row['name'] in (selected or [])]
    return [(r['image'], r['name']) for r in rows], f'已选择 {len(rows)} 张照片'


def completed_runs():
    return sorted((p.name for p in (ROOT/'runs').iterdir()
                   if (p/'reconstruction/result.ply').is_file()
                   and (p/'reconstruction/result.glb').is_file()), reverse=True)


def load_result(name, mode="GLB 网格"):
    if not name:
        return gr.update(value="", visible=True), gr.update(value=None, visible=False)
    directory = ROOT/'runs'/runner.component(name)/'reconstruction'
    if name not in completed_runs():
        raise gr.Error('找不到这次重建的模型文件')
    ply, glb = str(directory/'result.ply'), str(directory/'result.glb')
    gaussian = mode == 'Gaussian'
    url = '/gradio_api/file=' + quote(glb, safe='/')
    asset = '/gradio_api/file=' + quote(str(CODE/'scripts/assets/model-viewer.min.js'), safe='/')
    document = f'''<!doctype html><html><head><script type="module" src="{asset}"></script>
<style>body{{margin:0}}model-viewer{{width:100%;height:510px;background:#e7ece8}}</style></head>
<body><model-viewer src="{url}" camera-controls shadow-intensity="0.7" environment-image="neutral" alt="重建 GLB 网格"></model-viewer></body></html>'''
    frame = f'<iframe title="GLB 网格查看器" srcdoc="{html.escape(document, quote=True)}" style="width:100%;height:520px;border:0"></iframe>'
    return gr.update(value='' if gaussian else frame, visible=not gaussian), gr.update(value=ply if gaussian else None, visible=gaussian)


def open_result(name, mode):
    files = load_result(name, mode)
    if not name:
        return *files, '准备就绪。'
    return *files, f'正在查看已完成的重建：`{name}`。'


def run_job(name, selected):
    if not name or not selected:
        raise gr.Error('请至少选择一张照片')
    runner.input_manifest(ROOT, name, selected)
    attempt = datetime.now().strftime('web_%H%M%S_%f')
    run = ROOT/'runs'/f'{datetime.now():%Y%m%d}_{name}_{attempt}'
    log_path = ROOT/'logs'/f'{run.name}.log'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, str(CODE/'scripts/run.py'), '--object', name,
               '--attempt', attempt, '--images', *selected]
    empty = load_result(None)
    yield '正在检查输入和 GPU…', *empty, gr.update(), gr.update()
    with log_path.open('x') as log:
        process = subprocess.Popen(command, cwd=CODE, stdout=log, stderr=subprocess.STDOUT)
        while process.poll() is None:
            state = {}
            try:
                state = json.loads((run/'result.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            stage = state.get('current_stage', '')
            label = {'da3': '正在估计深度与相机', 'reconstruction': '正在重建三维模型'}.get(stage, '正在准备运行')
            yield f'{label} · {len(selected)} 张照片\n\n运行：`{run.name}`', *empty, gr.update(), gr.update()
            time.sleep(2)
    state = {}
    try:
        state = json.loads((run/'result.json').read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    if process.returncode != 0 or state.get('status') != 'complete':
        yield f'运行失败：{state.get("error", "重建未完成")}。', *empty, gr.update(), gr.update()
        return
    yield f'重建完成 · {len(selected)} 张照片\n\n运行：`{run.name}`。模型加载后可拖动旋转、滚轮缩放。', *load_result(run.name), gr.update(choices=completed_runs(), value=run.name), gr.update(value="GLB 网格")


def build_app():
    choices = objects()
    first = choices[0] if choices else None
    rows = images_for(first)
    with gr.Blocks(title='MV-SAM3D', theme=gr.themes.Soft(), css='#gaussian-preview a {display: none !important;}') as demo:
        gr.Markdown('# MV-SAM3D')
        with gr.Row():
            with gr.Column(scale=1):
                obj = gr.Dropdown(choices, value=first, label='输入物体', interactive=True)
                selected = gr.CheckboxGroup([r['name'] for r in rows], value=[r['name'] for r in rows], label='参与重建的照片', interactive=True)
                gallery = gr.Gallery([(r['image'], r['name']) for r in rows], label='已选照片', columns=4, height=280, interactive=False)
                count = gr.Markdown(f'已选择 {len(rows)} 张照片')
                start = gr.Button('开始重建', variant='primary')
                status = gr.Markdown('准备就绪。首次重建通常需要数分钟。')
            with gr.Column(scale=1):
                mode = gr.Radio(['GLB 网格', 'Gaussian'], value='GLB 网格', label='预览模式')
                mesh = gr.HTML()
                model = gr.Model3D(elem_id="gaussian-preview", show_label=False, height=520, interactive=False, visible=False)
        with gr.Accordion('查看已有结果', open=False):
            history = gr.Dropdown(completed_runs(), value=None, label='已完成的重建', interactive=True)
            refresh = gr.Button('刷新结果列表')
        obj.change(choose_object, obj, [selected, gallery, count], queue=False)
        selected.change(choose_images, [obj, selected], [gallery, count], queue=False)
        history.input(open_result, [history, mode], [mesh, model, status], queue=False)
        mode.input(open_result, [history, mode], [mesh, model, status], queue=False)
        refresh.click(lambda: gr.update(choices=completed_runs()), outputs=history, queue=False)
        start.click(run_job, [obj, selected], [status, mesh, model, history, mode], concurrency_limit=1, concurrency_id='reconstruction', api_name='reconstruct')
    return demo


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=7860)
    parser.add_argument('--host', default='127.0.0.1')
    args = parser.parse_args()
    build_app().queue().launch(server_name=args.host, server_port=args.port, share=False,
                              allowed_paths=[str(ROOT/'data/inputs'), str(ROOT/'runs'), str(CODE/'scripts/assets')], show_error=True,
                              app_kwargs={'middleware': [Middleware(GZipMiddleware, minimum_size=1024, compresslevel=3)]})
