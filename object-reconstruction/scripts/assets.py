"""重建物体的目录、尺寸和模型读取；不加载房间或保存场景布局。"""
from pathlib import Path
from urllib.parse import quote

from dimensions import read_dimensions, result_directory


class AssetsMiddleware:
    def __init__(self, app, root):
        self.app, self.root = app, Path(root)

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        path = scope['path']
        if path.startswith('/viewforge/assets/'):
            route = path[len('/viewforge/assets/'):]
        elif path.startswith('/viewforge/layouts/'):
            # 兼容已发布的 RoomCanvas 编辑器，仅保留原来的物体读取地址。
            legacy = path[len('/viewforge/layouts/'):]
            if legacy == 'catalog':
                route = 'catalog'
            elif legacy.startswith('assets/'):
                route = legacy[len('assets/'):]
            else:
                route = None
        else:
            return await self.app(scope, receive, send)

        from starlette.requests import Request
        from starlette.responses import JSONResponse, FileResponse
        from starlette.concurrency import run_in_threadpool

        request = Request(scope, receive)
        try:
            if route is None:
                response = JSONResponse(dict(error='接口不存在'), status_code=404)
            elif request.method != 'GET':
                response = JSONResponse(dict(error='物体资产仅支持读取'), status_code=405)
            elif route == 'catalog':
                runs = self.root/'runs'
                names = []
                if runs.is_dir():
                    for run in sorted(runs.iterdir(), reverse=True):
                        try:
                            result_directory(self.root, run.name)
                        except (ValueError, FileNotFoundError):
                            continue
                        names.append(run.name)
                response = JSONResponse(dict(runs=names))
            else:
                parts = route.split('/')
                if len(parts) > 2 or (len(parts) == 2 and parts[1] not in ('result.glb', 'preview.glb')):
                    raise FileNotFoundError('无效的物体资产地址')
                run = result_directory(self.root, parts[0])
                if len(parts) == 2:
                    file = run/'reconstruction'/parts[1]
                    if not file.is_file():
                        raise FileNotFoundError('没有这个模型文件')
                    response = FileResponse(file, media_type='model/gltf-binary')
                else:
                    data = await run_in_threadpool(read_dimensions, run)
                    manifest = run/'cover/preview.json'
                    if manifest.is_file():
                        viewer = '/gradio_api/file=' + quote(str(Path(__file__).parent/'assets/cover-viewer.html'), safe='/')
                        data['viewer_url'] = viewer + '?manifest=' + quote('/gradio_api/file=' + str(manifest), safe='')
                    response = JSONResponse(data)
        except FileNotFoundError as exc:
            response = JSONResponse(dict(error=str(exc)), status_code=404)
        except (ValueError, KeyError, TypeError) as exc:
            response = JSONResponse(dict(error=str(exc)), status_code=400)
        response.headers['Cache-Control'] = 'no-store'
        await response(scope, receive, send)
