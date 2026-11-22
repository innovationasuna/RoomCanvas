"""Temporary download files with process-safe recovery after abrupt exits."""
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import stat
import tempfile


def is_part(name, legacy_cache=False):
    return bool(re.fullmatch(r'\.(?:Room(?:\.glb)?|roomcanvas)-[\w-]+\.part', name)
                or (legacy_cache and re.fullmatch(r'tmp[a-z0-9_]{8}', name)))


@contextmanager
def temporary(target):
    """Hold a shared directory lock through writing, validation and publication."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    directory = os.open(target.parent, os.O_RDONLY)
    try:
        fcntl.flock(directory, fcntl.LOCK_SH)
        prefix = '.Room-' if target.name == 'Room.glb' else '.roomcanvas-'
        fd, name = tempfile.mkstemp(dir=target.parent, prefix=prefix, suffix='.part')
        os.close(fd)
        part = Path(name)
        try:
            yield part
        finally:
            part.unlink(missing_ok=True)
    finally:
        os.close(directory)


def cleanup(root, legacy_cache=False):
    """Remove abandoned parts, never following symlinks or racing an active writer."""
    root = Path(root)
    freed = removed = 0
    if root.is_symlink():
        return freed, removed
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(folder) / d).is_symlink()]
        if not any(is_part(name, legacy_cache) for name in files):
            continue
        directory = os.open(folder, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                continue
            for name in files:
                if not is_part(name, legacy_cache):
                    continue
                path = Path(folder) / name
                try:
                    info = path.lstat()
                    if stat.S_ISREG(info.st_mode):
                        path.unlink()
                        removed += 1
                        freed += info.st_size if info.st_nlink == 1 else 0
                except FileNotFoundError:
                    pass
        finally:
            os.close(directory)
    return freed, removed
