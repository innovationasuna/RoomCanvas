"""Content receipts for expensive, reproducible artifacts (never timestamp based)."""

from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path


def file_hash(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     delete=False) as handle:
        tmp = Path(handle.name)
        try:
            json.dump(value, handle, ensure_ascii=False, indent=2)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
    try:
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def receipt_path(output: Path) -> Path:
    return output.with_suffix(output.suffix + ".cache.json")


def matches(output: Path, key: str) -> bool:
    receipt = read_json(receipt_path(output))
    return (isinstance(receipt, dict) and receipt.get("key") == key
            and output.is_file() and output.stat().st_size > 0
            and receipt.get("output") == file_hash(output))


def record(output: Path, key: str) -> None:
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError(f"generation produced no artifact: {output}")
    atomic_json(receipt_path(output), {"version": 1, "key": key, "output": file_hash(output)})


def retire(paths: list[Path], root: Path) -> None:
    """Keep invalidated results for inspection, outside locations consumed by later stages."""
    present = [p for p in paths if p.exists() or p.is_symlink()]
    if not present:
        return
    (root / ".stale").mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="cache-", dir=root / ".stale"))
    for path in present:
        shutil.move(str(path), str(backup / path.name))


def invalidate(output: Path) -> None:
    retire([output, receipt_path(output)], output.parent)
