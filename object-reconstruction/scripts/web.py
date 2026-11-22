"""RoomCanvas 物体重建 API：上传、抠图、重建、任务进度、模型与实测尺寸。"""
import argparse
import os
import sys
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Route

from assets import AssetsMiddleware
from dimensions import DimensionsMiddleware
from objects import ObjectsMiddleware

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from service_auth import AuthMiddleware, load_token


def create_app(root=None, *, token=None):
    """独立于前端启动；沿用原有数据根目录、GPU 锁和接口地址。"""
    if root is None:
        root = os.environ.get('VIEWFORGE_ROOT')
        if not root:
            raise ValueError('请设置 VIEWFORGE_ROOT 指向现有物体运行目录')
    root = Path(root).resolve()

    async def health(request):
        return JSONResponse(dict(service='roomcanvas-objects', status='ok'))

    token = load_token() if token is None else token
    return Starlette(routes=[Route('/', health), Route('/health', health)], middleware=[
        Middleware(AuthMiddleware, token=token),
        Middleware(GZipMiddleware, minimum_size=1024, compresslevel=3),
        Middleware(DimensionsMiddleware, root=root),
        Middleware(AssetsMiddleware, root=root),
        Middleware(ObjectsMiddleware, root=root),
    ])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=7862)
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--token-file', help='private service credential file')
    args = parser.parse_args()
    token = load_token(args.token_file, create=True)
    import uvicorn
    uvicorn.run(create_app(token=token), host=args.host, port=args.port)


if __name__ == '__main__':
    main()
