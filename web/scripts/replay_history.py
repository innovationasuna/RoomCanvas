"""Read-only compatibility adapter. Legacy times are inferred, never rewritten."""
import hashlib
from functools import lru_cache
from pathlib import Path


def inferred_time(path):
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return None


@lru_cache(maxsize=4096)
def _digest(path, identity):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def file_digest(path, stat):
    return _digest(str(path), (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))


def artifact_evidence(path, row=None, *, legacy=False):
    try:
        stat = Path(path).stat()
        if row:
            # A file rewritten after its record (or recorded without a digest) is still shown at the
            # recorded time; its time is only marked unknown, never dropped.
            expected, source = row.get('artifact_digest'), 'event'
            if expected:
                actual = file_digest(path, stat)
                if actual != expected:
                    source = 'external_change'
            elif row.get('schema_version', 1) >= 2:
                source = 'missing_digest'
            return {'time': row['t'], 'source': source, 'confidence': 'recorded' if source == 'event' else 'unknown',
                    'event_id': row.get('event_id'), 'attempt_id': row.get('attempt_id')}
        if legacy:
            return {'time': stat.st_mtime, 'source': 'file_mtime', 'confidence': 'inferred'}
    except OSError:
        pass
    return {'time': None, 'source': 'missing_record', 'confidence': 'unknown'}


def legacy_rounds(scene):
    paths = sorted(Path(scene).glob('realism_authoring/acceptance/*/round_*/visual_review.json'),
                   key=lambda p: (inferred_time(p) or 0, str(p)))
    return [(inferred_time(p), p, inferred_time(p.parent / 'Room.glb'), None) for p in paths]
