"""Private service credentials shared by the gateway, backends and SSH client."""
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile
import urllib.error
import urllib.request

DEFAULT_FILE = '~/.local/state/roomcanvas/service.token'


def token_file(path=None):
    return Path(path or os.environ.get('ROOMCANVAS_TOKEN_FILE', DEFAULT_FILE)).expanduser()


def load_token(path=None, *, create=False):
    path = token_file(path)
    if create:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, name = tempfile.mkstemp(dir=path.parent, prefix='.service-token-')
        try:
            with os.fdopen(fd, 'w') as output:
                output.write(secrets.token_hex(32) + '\n')
            try:
                os.link(name, path)  # Publish a complete 0600 file, without replacing an existing token.
            except FileExistsError:
                pass
        finally:
            os.unlink(name)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError(f'Service credential must be owned by this user with mode 0600: {path}')
        return validate_token(source.read(1024).strip())


def validate_token(token):
    if not re.fullmatch(r'[0-9a-f]{64}', token):
        raise ValueError('Invalid service credential; expected a generated token file')
    return token


def authorized(headers, token):
    values = headers.get_all('Authorization', [])
    return bool(token) and len(values) == 1 and hmac.compare_digest(values[0].encode(), ('Bearer ' + token).encode())


# What a request without the service credential is told, so a page or an old client says why.
UNAUTHORIZED = json.dumps({'error': '服务器需要服务凭证：请把本机 RoomCanvas 更新到最新版本并用 serve.py --ssh 启动，'
                                    '或用 --token-file 指定凭证。'}, ensure_ascii=False).encode()


class HTTPAuth:
    """Reject before dispatch, including HEAD, health and upload requests."""
    service_token = None

    def parse_request(self):
        if not super().parse_request():
            return False
        if not authorized(self.headers, self.service_token):
            self.close_connection = True
            self.send_response(401)
            self.send_header('WWW-Authenticate', 'Bearer')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(UNAUTHORIZED)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(UNAUTHORIZED)
            return False
        return True


class AuthMiddleware:
    def __init__(self, app, token):
        self.app, self.token = app, validate_token(token)

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http':
            values = [v for k, v in scope.get('headers', []) if k.lower() == b'authorization']
            if len(values) != 1 or not hmac.compare_digest(values[0], ('Bearer ' + self.token).encode()):
                await send({'type': 'http.response.start', 'status': 401,
                            'headers': [(b'www-authenticate', b'Bearer'),
                                        (b'content-type', b'application/json; charset=utf-8'),
                                        (b'content-length', str(len(UNAUTHORIZED)).encode())]})
                await send({'type': 'http.response.body',
                            'body': b'' if scope.get('method') == 'HEAD' else UNAUTHORIZED})
                return
        await self.app(scope, receive, send)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'Service redirects are not allowed', headers, fp)


def urlopen(request, *, token=None, timeout=60):
    if token is None:
        return urllib.request.urlopen(request, timeout=timeout)
    if isinstance(request, str):
        request = urllib.request.Request(request)
    request.add_header('Authorization', 'Bearer ' + validate_token(token))
    return urllib.request.build_opener(NoRedirect).open(request, timeout=timeout)


if __name__ == '__main__':
    load_token(create=True)  # Initialize without ever printing the credential.
