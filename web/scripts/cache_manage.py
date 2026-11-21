#!/usr/bin/env python3
"""Inspect and remove local downloaded room files, shared by serve.py and the CLI.

python3 web/scripts/cache_manage.py list
python3 web/scripts/cache_manage.py clear sample:office
python3 web/scripts/cache_manage.py clear --all
python3 web/scripts/cache_manage.py resume
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import stat

ROOT = Path(__file__).resolve().parents[2]
JOB = re.compile(r'[0-9a-f]{32}')
SAMPLE = re.compile(r'samples/([\w-]+)/Room\.glb', re.ASCII)


class CacheBusy(Exception):
    pass


def read_json(path, default):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, type(default)) else default
    except (OSError, ValueError):
        return default


def records(path, key):
    rows = read_json(path, {}).get(key, [])
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def regular(path, anchor):
    """Never follow a symlink, including one in a parent directory."""
    try:
        relative = path.relative_to(anchor)
        current = anchor
        if current.is_symlink():
            return False
        for part in relative.parts:
            current /= part
            if current.is_symlink():
                return False
        return stat.S_ISREG(path.stat().st_mode)
    except (OSError, ValueError):
        return False


class CacheManager:
    def __init__(self, root=ROOT, cache=None):
        self.root = Path(root).resolve()
        # Keep symlinks visible so the inventory can refuse them.
        self.cache = Path(os.path.abspath(cache or self.root / 'runs/room-cache'))
        self.state = self.root / '.roomcanvas'
        self.paused = self.state / 'cache-downloads-paused'

    @contextmanager
    def lock(self, exclusive=False):
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / 'cache.lock').open('a') as lock:
            try:
                fcntl.flock(lock, (fcntl.LOCK_EX | fcntl.LOCK_NB) if exclusive else fcntl.LOCK_SH)
            except BlockingIOError:
                raise CacheBusy('正在读取或下载缓存，请稍后再清理。') from None
            yield

    @contextmanager
    def download(self, background=False):
        """Cooperate across the web server and CLI; clear never races an active writer."""
        with self.lock():
            yield not (background and self.paused.exists())

    def _entries(self):
        rooms = records(self.root / 'web/rooms.json', 'rooms')
        models = records(self.root / 'samples/models.json', 'models')
        names, entries = {}, {}
        for job in records(self.cache / 'jobs/answer.json', 'jobs'):
            if isinstance(job, dict) and JOB.fullmatch(str(job.get('id', ''))):
                names[job['id']] = job.get('name') or f'房间 {job["id"][:8]}'
        for room in rooms:
            if room.get('scan'):
                names[room['scan']] = room['name']

        def add(identifier, name, kind, path, anchor):
            if not regular(path, anchor):
                return
            row = entries.setdefault(identifier, {'id': identifier, 'name': name, 'kinds': set(), 'paths': []})
            row['kinds'].add(kind)
            row['paths'].append((path, anchor))

        for model in models:
            match = SAMPLE.fullmatch(model.get('path', ''))
            if not match:
                continue
            room = next((r for r in rooms if r.get('dir') == '../samples/' + match[1]), {})
            scan = room.get('scan', '')
            identifier = 'scan:' + scan if JOB.fullmatch(scan) else 'sample:' + match[1]
            add(identifier, room.get('name', match[1]), '房间模型', self.root / model['path'], self.root)

        for parent in ('assets', 'jobs'):
            folder = self.cache / parent
            if self.cache.is_symlink() or folder.is_symlink() or not folder.is_dir():
                continue
            for job in folder.iterdir():
                if not JOB.fullmatch(job.name) or job.is_symlink() or not job.is_dir():
                    continue
                identifier, name = 'scan:' + job.name, names.get(job.name, f'房间 {job.name[:8]}')
                if parent == 'assets':
                    for leaf in ('Room.glb', 'room_objects.json', 'thumbnail.jpg'):
                        add(identifier, name, '房间展示文件', job / leaf, self.cache)
                else:
                    for leaf in ('stamp.json', 'answer.json', 'replay/answer.json'):
                        add(identifier, name, '重建回放', job / leaf, self.cache)
                    for sub in ('replay/files', 'replay/scaffold'):
                        if (job / 'replay').is_symlink() or (job / sub).is_symlink():
                            continue
                        for directory, dirs, files in os.walk(job / sub, followlinks=False):
                            dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
                            for leaf in files:
                                add(identifier, name, '重建回放', Path(directory) / leaf, self.cache)
        for leaf in ('jobs/answer.json', 'catalog/answer.json'):
            add('catalog', '离线房间列表', '列表数据', self.cache / leaf, self.cache)
        return entries

    def inventory(self):
        rows = []
        for row in self._entries().values():
            sizes = []
            for path, anchor in row['paths']:
                try:
                    if regular(path, anchor):
                        sizes.append(path.stat().st_size)
                except FileNotFoundError:
                    pass
            if sizes:
                rows.append({'id': row['id'], 'name': row['name'], 'kinds': sorted(row['kinds']),
                             'files': len(sizes), 'bytes': sum(sizes)})
        rows.sort(key=lambda row: (row['id'] == 'catalog', row['name'], row['id']))
        return {'entries': rows, 'total_bytes': sum(r['bytes'] for r in rows),
                'total_files': sum(r['files'] for r in rows), 'background_paused': self.paused.exists()}

    def clear(self, ids=None, all=False):
        if type(all) is not bool or (all and ids) or (not all and (
                not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids))):
            raise ValueError('请选择缓存条目，或使用全部清理。')
        with self.lock(exclusive=True):
            entries = self._entries()
            selected = list(entries) if all else list(dict.fromkeys(ids))
            if any(i not in entries for i in selected):
                raise ValueError('缓存列表已变化，请刷新后重新选择。')
            # Persist before removal so another process cannot immediately refill the cache.
            self.paused.touch()
            freed, removed, errors = 0, 0, []
            for identifier in selected:
                for path, anchor in entries[identifier]['paths']:
                    try:
                        if regular(path, anchor):
                            size = path.stat().st_size
                            path.unlink()
                            freed += size
                            removed += 1
                    except FileNotFoundError:
                        pass
                    except OSError:
                        errors.append(f'{entries[identifier]["name"]}：部分文件无法清理，请检查文件权限。')
            return {'freed_bytes': freed, 'removed_files': removed, 'errors': sorted(set(errors)),
                    'cache': self.inventory()}

    def resume(self):
        with self.lock(exclusive=True):
            self.paused.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--cache', type=Path, help='use the same room-cache directory as serve.py --cache')
    sub = parser.add_subparsers(dest='command', required=True)
    listing = sub.add_parser('list', help='list downloaded files grouped by room')
    listing.add_argument('--json', action='store_true')
    clearing = sub.add_parser('clear', help='clear selected IDs from list, or --all')
    clearing.add_argument('ids', nargs='*')
    clearing.add_argument('--all', action='store_true')
    sub.add_parser('resume', help='allow background downloads again; does not start a download itself')
    args = parser.parse_args(argv)
    manager = CacheManager(cache=args.cache)
    try:
        if args.command == 'list':
            data = manager.inventory()
            if args.json:
                print(json.dumps(data, ensure_ascii=False, indent=2))
            else:
                for row in data['entries']:
                    print(f'{row["id"]}\t{row["name"]}\t{row["files"]} 个文件\t{row["bytes"] / 1024**2:.1f} MiB')
                print(f'共 {data["total_files"]} 个文件，{data["total_bytes"] / 1024**2:.1f} MiB')
        elif args.command == 'clear':
            result = manager.clear(args.ids, all=args.all)
            print(f'已清理 {result["removed_files"]} 个文件，释放 {result["freed_bytes"] / 1024**2:.1f} MiB。后台预下载已暂停。')
            if result['errors']:
                print('\n'.join(result['errors']))
                return 1
        else:
            manager.resume()
            print('已允许后台预下载；使用 --no-download 启动的服务仍保持按需下载。')
    except (ValueError, OSError, CacheBusy) as error:
        parser.exit(1, f'{error}\n')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
