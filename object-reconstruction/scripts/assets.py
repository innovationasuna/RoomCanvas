"""重建物体的目录、尺寸和模型读取；不加载房间或保存场景布局。"""
from pathlib import Path
from urllib.parse import quote

from dimensions import read_dimensions, result_directory
from mvsam_pbr import material_capabilities
from asset_state import AssetUnavailableError, complete, preview_manifest, require_asset


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
                if len(parts) > 2 or (len(parts) == 2 and parts[1] not in ('result.glb', 'preview.glb', 'collision.glb', 'result.ply', 'preview.json')):
                    raise FileNotFoundError('无效的物体资产地址')
                run = result_directory(self.root, parts[0])
                if len(parts) == 2 and parts[1] == 'preview.json':
                    # Historical manifests may contain old UI file URLs. Serve a copy with
                    # controlled asset URLs; preserve transforms, recommendations and disk data.
                    data = preview_manifest(run)
                    if not data:
                        raise FileNotFoundError('没有这个模型的预览信息')
                    for kind, filename in [('glb', 'result.glb'), ('glb_preview', 'preview.glb'), ('collision', 'collision.glb'), ('gaussian', 'result.ply')]:
                        asset = data.get('assets', {}).get(kind)
                        if asset:
                            asset['url'] = f'/viewforge/assets/{quote(run.name, safe="")}/{filename}'
                    response = JSONResponse(data)
                elif len(parts) == 2:
                    file = run/'reconstruction'/parts[1]
                    published = require_asset(run)
                    if not file.is_file() or (published and parts[1] not in published['files']):
                        raise FileNotFoundError('没有这个模型文件')
                    if not complete(file):
                        raise AssetUnavailableError('asset_failed', '模型文件不完整，请重新重建')
                    response = FileResponse(file, media_type='model/gltf-binary' if parts[1].endswith('.glb') else 'application/octet-stream')
                else:
                    data = await run_in_threadpool(read_dimensions, run)
                    published = require_asset(run)
                    info = published.get('capabilities') if published else material_capabilities(run)
                    if info:
                        data['capabilities'] = info
                    manifest = run/'cover/preview.json'
                    if published or manifest.is_file():
                        data['manifest_url'] = f'/viewforge/assets/{quote(run.name, safe="")}/preview.json'
                    response = JSONResponse(data)
        except AssetUnavailableError as exc:
            response = JSONResponse(dict(error=str(exc), state=exc.state), status_code=409)
        except FileNotFoundError as exc:
            response = JSONResponse(dict(error=str(exc)), status_code=404)
        except (ValueError, KeyError, TypeError) as exc:
            response = JSONResponse(dict(error=str(exc)), status_code=400)
        response.headers['Cache-Control'] = 'no-store'
        await response(scope, receive, send)
