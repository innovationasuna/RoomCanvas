#!/usr/bin/env python3
"""Fetch the sample rooms' models: samples/*/Room.glb are assets of a GitHub release, not files in git.

python3 scripts/fetch_samples.py                # download the models that are missing or have the wrong size
python3 scripts/fetch_samples.py office room3   # only these rooms (directory names under samples/)
python3 scripts/fetch_samples.py --verify       # also compare the sha256 of the models already here
python3 scripts/fetch_samples.py --check        # only report; exit 1 if a model is missing or wrong

samples/models.json lists each model: where it goes, the release tag and asset, its size and sha256.
A model the room cache (runs/room-cache/, see serve.py) already holds, same size and sha256, is linked from
there instead of downloaded (a hard link, or a copy across file systems); --cache <dir> looks elsewhere.
The repository is private, so the download needs a login: the gh CLI when it is logged in (gh auth login),
otherwise a token in GH_TOKEN or GITHUB_TOKEN. A download replaces Room.glb only after its size and sha256
match, so an interrupted or wrong one never does. Standard library only.
"""
import argparse
import hashlib
import http.client
import json
import os
import shutil
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
API = 'https://api.github.com'


class FetchError(Exception):
    pass


def load(root=None):
    data = json.loads((Path(root or ROOT) / 'samples/models.json').read_text())
    return data['repo'], data['models']


def room(entry):
    return Path(entry['path']).parent.name


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


_digests = {}  # (path, inode, size, mtime) -> sha256, so a file is hashed once while it stays the same


def known_sha256(path, info):
    key = (str(path), info.st_ino, info.st_size, info.st_mtime_ns)
    if key not in _digests:
        _digests[key] = sha256(path)
    return _digests[key]


def same_file(places, size, digest):
    """A file with this size and sha256 among `places` (files, and every file under a directory), or None.
    Only files of the same size are hashed; unfinished downloads (*.part) are skipped."""
    for place in map(Path, places):
        for path in sorted(place.rglob('*')) if place.is_dir() else [place]:
            try:
                info = path.lstat()
                if (stat.S_ISREG(info.st_mode) and info.st_size == size and not path.name.endswith('.part')
                        and known_sha256(path, info) == digest):
                    return path
            except OSError:  # removed while looking
                continue
    return None


def place(source, target):
    """Make `target` a file with the content of `source` without downloading it: a hard link (no extra space;
    removing one name leaves the other), or a copy where linking fails (another file system). Like a
    download, it is made beside the target and renamed, so an interrupted one never leaves a partial file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + '.part')
    part.unlink(missing_ok=True)
    try:
        try:
            os.link(source, part)
        except OSError:
            shutil.copyfile(source, part)
        os.replace(part, target)
    finally:
        part.unlink(missing_ok=True)  # left when target already was this very file


def problem(path, entry, verify=True):
    """Why the file is not the listed model, or None. The size answers first; the file is hashed only with `verify`."""
    if not path.is_file():
        return 'missing'
    size = path.stat().st_size
    if size != entry['bytes']:
        return f'{size} bytes, expected {entry["bytes"]}'
    if verify and sha256(path) != entry['sha256']:
        return 'sha256 differs'
    return None


def gh_download(repo, entry, target):
    done = subprocess.run(['gh', 'release', 'download', entry['tag'], '-R', repo, '-p', entry['asset'], '-O', str(target), '--clobber'],
                          stdin=subprocess.DEVNULL, capture_output=True, text=True)
    if done.returncode:
        raise FetchError(f'gh: {(done.stderr.strip().splitlines() or ["download failed"])[-1]}')


class DropAuth(urllib.request.HTTPRedirectHandler):
    """An asset redirects to a signed URL on another host; the token must not follow it there."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new and urlsplit(newurl).netloc != urlsplit(req.full_url).netloc:
            new.remove_header('Authorization')
        return new


def api_download(repo, entry, target, token):
    headers = {'Authorization': f'Bearer {token}', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'RoomCanvas fetch_samples.py'}
    opener = urllib.request.build_opener(DropAuth)
    try:
        release = urllib.request.Request(f'{API}/repos/{repo}/releases/tags/{entry["tag"]}', headers={**headers, 'Accept': 'application/vnd.github+json'})
        with opener.open(release, timeout=60) as response:
            ids = {asset['name']: asset['id'] for asset in json.load(response)['assets']}
        if entry['asset'] not in ids:
            raise FetchError(f'release {entry["tag"]} has no asset {entry["asset"]}')
        asset = urllib.request.Request(f'{API}/repos/{repo}/releases/assets/{ids[entry["asset"]]}', headers={**headers, 'Accept': 'application/octet-stream'})
        with opener.open(asset, timeout=60) as response, open(target, 'wb') as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
    except urllib.error.HTTPError as error:  # the path only: a redirected URL carries its signature in the query
        raise FetchError(f'GitHub answered {error.code} for {urlsplit(error.url).path}') from None
    except (OSError, ValueError, KeyError, http.client.HTTPException) as error:
        raise FetchError(f'GitHub API: {error}') from None


def methods(env=None):
    """The ways to download here, in order: the gh CLI when it is logged in, then a token from the environment."""
    env = os.environ if env is None else env
    found = []
    if shutil.which('gh') and subprocess.run(['gh', 'auth', 'token', '-h', 'github.com'], stdin=subprocess.DEVNULL,
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        found.append(gh_download)
    token = env.get('GH_TOKEN') or env.get('GITHUB_TOKEN')
    if token:
        found.append(lambda repo, entry, target: api_download(repo, entry, target, token))
    return found


def fetch_one(repo, entry, root, ways):
    """Download beside the model's place, check the file, then move it there; a failed download leaves nothing."""
    path = Path(root) / entry['path']
    part = path.with_name(path.name + '.part')
    path.parent.mkdir(parents=True, exist_ok=True)
    errors = []
    try:
        for way in ways:
            try:
                way(repo, entry, part)
                wrong = problem(part, entry)
                if wrong:
                    raise FetchError(f'the download is not the listed model ({wrong})')
                os.replace(part, path)
                return
            except FetchError as error:
                errors.append(str(error))
    finally:
        part.unlink(missing_ok=True)
    raise FetchError('; '.join(errors) or 'no GitHub login (gh CLI or GH_TOKEN)')


def advice(repo, entries):
    lines = ['The sample models are release assets of a private repository. Either run `gh auth login` (or set GH_TOKEN),',
             'then python3 scripts/fetch_samples.py, or download each file in a browser and save it under the name on the right:']
    return '\n'.join(lines + [f'  https://github.com/{repo}/releases/download/{entry["tag"]}/{entry["asset"]}  ->  {entry["path"]}'
                              for entry in entries])


def fetch(rooms=(), root=None, check=False, verify=False, missing_only=False, ways=None, log=print, cache=None):
    """Bring the models (of `rooms`, default all) to what samples/models.json lists and return the entries
    still missing or wrong, after saying once how to get them. `check` only reports. `missing_only`
    (serve.py at start-up) leaves a model that is here but differs alone: it may be someone's new version.
    A model already in `cache` (default runs/room-cache/) is linked from there, not downloaded."""
    root = Path(root or ROOT)
    cache = Path(cache or root / 'runs/room-cache')
    repo, models = load(root)
    unknown = sorted(set(rooms) - {room(entry) for entry in models})
    if unknown:
        raise ValueError(f'no sample model for: {", ".join(unknown)} (samples/models.json has {", ".join(map(room, models))})')
    left = []
    for entry in models:
        why = problem(root / entry['path'], entry, verify) if not rooms or room(entry) in rooms else None
        if not why:
            continue
        if missing_only and why != 'missing':
            log(f'{entry["path"]}: {why}; left as it is (python3 scripts/fetch_samples.py {room(entry)} replaces it)')
            continue
        if not check:
            same = same_file([cache], entry['bytes'], entry['sha256'])
            if same:
                place(same, root / entry['path'])
                log(f'{entry["path"]}: the same file is already in {same.parent}; linked, not downloaded')
                continue
            ways = methods() if ways is None else ways
            if ways:
                log(f'Fetching {entry["path"]} ({entry["bytes"] / 1e6:.0f} MB) from release {entry["tag"]}…')
            try:
                fetch_one(repo, entry, root, ways)
                continue
            except FetchError as error:
                why = str(error)
        log(f'{entry["path"]}: {why}')
        left.append(entry)
    if left:
        log(advice(repo, left))
    return left


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('rooms', nargs='*', metavar='ROOM', help='directory names under samples/ (default: every listed model)')
    parser.add_argument('--check', action='store_true', help='report what is missing or wrong and exit 1; download nothing')
    parser.add_argument('--verify', action='store_true', help='also compare the sha256 of the models already here')
    parser.add_argument('--cache', type=Path, help='room cache to link identical models from (default: runs/room-cache)')
    args = parser.parse_args(argv)
    try:
        left = fetch(args.rooms, check=args.check, verify=args.verify, log=lambda line: print(line, flush=True), cache=args.cache)
    except ValueError as error:
        parser.error(str(error))
    if not left:
        print('Sample models are up to date')
    return 1 if left else 0


if __name__ == '__main__':
    sys.exit(main())
