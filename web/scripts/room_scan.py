"""Bounded archive extraction and shared capture validation."""
import shutil
import stat
import tarfile
import zipfile
from pathlib import PurePosixPath
from litereality_agent.capture import capture_frames

MAX_EXPANDED = 8 * 1024**3
MAX_ENTRIES = 50000

SCAN_SUFFIXES = {'.usdz', '.jpg', '.jpeg', '.png', '.json', '.mp4', '.obj', '.mtl', '.txt', '.ply', '.pcd', '.heic'}
UNSAFE = '扫描包包含不安全的路径、链接、特殊文件或加密文件'


def _scan_entries(bundle):
    """Yield bounded scan entries lazily. A directory has no opener; links and devices are refused."""
    is_zip = isinstance(bundle, zipfile.ZipFile)
    for item in bundle.infolist() if is_zip else bundle:
        if is_zip:
            if stat.S_ISLNK(item.external_attr >> 16) or item.flag_bits & 1:
                raise ValueError(UNSAFE)
            yield item.filename, item.file_size, None if item.is_dir() else lambda item=item: bundle.open(item)
        else:
            if not (item.isfile() or item.isdir()):
                raise ValueError(UNSAFE)
            yield item.name, item.size, None if item.isdir() else lambda item=item: bundle.extractfile(item)


def _open_scan(archive):
    # By the leading bytes: zipfile.is_zipfile looks for a ZIP's end record near the end of the file,
    # which a tar ending with room.usdz (itself a ZIP) also has.
    archive.seek(0)
    head = archive.read(4)
    archive.seek(0)
    if head in (b'PK\x03\x04', b'PK\x05\x06'):
        return zipfile.ZipFile(archive)
    try:
        return tarfile.open(fileobj=archive, mode='r:*')
    except tarfile.TarError:
        raise ValueError('请上传 ZIP 或 tar 格式的扫描包') from None


def extract_scan(archive, destination, *, max_expanded=MAX_EXPANDED, max_entries=MAX_ENTRIES):
    """Extract bounded data only from a ZIP or tar; reject links, traversal, duplicates and multiple captures."""
    with _open_scan(archive) as bundle:
        names, expanded = set(), 0
        for count, (name, size, open_entry) in enumerate(_scan_entries(bundle), 1):
            expanded += size
            if count > max_entries or size < 0 or expanded > max_expanded:
                raise ValueError('扫描包解压后过大（上限 8 GB / 50,000 个文件）')
            path = PurePosixPath(name)
            if path.is_absolute() or '..' in path.parts or '\\' in name or ':' in name:
                raise ValueError(UNSAFE)
            if open_entry is None or '__MACOSX' in path.parts or path.name.startswith('.'):
                continue
            path = PurePosixPath(*[part for part in path.parts if part != '.'])  # tar names may start with ./
            if path.suffix.lower() not in SCAN_SUFFIXES:
                raise ValueError('扫描包只能包含扫描数据，不能包含程序或其他文件')
            if str(path).casefold() in names:
                raise ValueError('扫描包包含重复文件')
            names.add(str(path).casefold())
            target = destination.joinpath(*path.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            with open_entry() as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
    candidates = {p.parent.parent if p.parent.name == 'roomplan' else p.parent for p in destination.rglob('room.usdz')}
    if len(candidates) != 1:
        raise ValueError('请上传一个房间的完整扫描包，其中需包含 room.usdz')
    capture = candidates.pop()
    if (capture / 'scene.json').exists():
        raise ValueError('请上传原始扫描包，而不是已经生成的场景包')
    capture_frames(capture)
    return capture

