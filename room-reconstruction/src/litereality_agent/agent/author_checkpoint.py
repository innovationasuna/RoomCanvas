"""File-level author recovery: a manifest points to one coherent source/resource snapshot."""

from __future__ import annotations

import ast
import json
import shutil
import tempfile
from pathlib import Path

from litereality_agent import artifact_cache as cache


def files(room: Path) -> list[Path]:
    return sorted(p for p in room.rglob("*") if p.is_file()
                  and not any(part.startswith((".", "_")) for part in p.relative_to(room).parts)
                  and (p.suffix in {".py", ".json"}
                       or {"materials", "textures"}.intersection(p.relative_to(room).parts)))


def source_error(room: Path) -> str:
    if not (room / "Room.py").is_file():
        return f"missing {room / 'Room.py'}"
    try:
        for path in files(room):
            if path.suffix == ".py":
                tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
                # Material tools may create files and edit Room.py in separate tool calls. Do
                # not advance the checkpoint while its explicit local resource is absent.
                for node in ast.walk(tree):
                    if isinstance(node, ast.Constant) and isinstance(node.value, str):
                        resource = Path(node.value)
                        if (not resource.is_absolute() and resource.parts
                                and resource.parts[0] in {"materials", "textures"}
                                and resource.suffix and not (room / resource).is_file()
                                and not (path.parent / resource).is_file()):
                            return f"{path.name}: missing resource {resource}"
            elif path.suffix == ".json":
                json.loads(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError) as exc:
        return str(exc)
    return ""


def inventory(room: Path) -> dict[str, str | None]:
    return {str(p.relative_to(room)): cache.file_hash(p) for p in files(room)}


def save(room: Path, legacy: Path) -> bool:
    if (room.parent / ".author_restore_pending.json").exists() or source_error(room):
        return False
    store = legacy.with_suffix(".d")
    blobs = store / "blobs"
    try:
        blobs.mkdir(parents=True, exist_ok=True)
        mapping = inventory(room)
        for name, digest in mapping.items():
            if not isinstance(digest, str):
                return False
            blob = blobs / digest
            if cache.file_hash(blob) != digest:
                with tempfile.NamedTemporaryFile(dir=blobs, delete=False) as handle:
                    tmp = Path(handle.name)
                try:
                    shutil.copyfile(room / name, tmp)
                    if cache.file_hash(tmp) != digest:
                        return False  # an edit raced the snapshot; retain the prior manifest
                    tmp.replace(blob)
                finally:
                    tmp.unlink(missing_ok=True)
        # Both validation and the manifest are against the same file contents, not a mixture
        # of successive tool writes. Only this final pointer advertises the snapshot as valid.
        if inventory(room) != mapping or source_error(room):
            return False
        cache.atomic_json(store / "manifest.json", {"version": 1, "files": mapping})
        temporary = legacy.with_suffix(".tmp")
        try:
            shutil.copyfile(blobs / mapping["Room.py"], temporary)
            temporary.replace(legacy)
        finally:
            temporary.unlink(missing_ok=True)
        return True
    except OSError:
        return False


def restore(room: Path, legacy: Path) -> bool:
    store = legacy.with_suffix(".d")
    manifest_path = store / "manifest.json"
    manifest = cache.read_json(manifest_path)
    if not isinstance(manifest, dict):
        if manifest_path.exists():
            return False  # a damaged multi-file checkpoint must not fall back to Room.py alone
        if not legacy.is_file():
            return False
        shutil.copyfile(legacy, room / "Room.py")
        return not source_error(room)
    mapping = manifest.get("files", {})
    if manifest.get("version") != 1 or not isinstance(mapping, dict) or "Room.py" not in mapping:
        return False
    if any(not isinstance(name, str) or Path(name).is_absolute() or ".." in Path(name).parts
           or not isinstance(digest, str) or len(digest) != 64
           or any(c not in "0123456789abcdef" for c in digest)
           or cache.file_hash(store / "blobs" / digest) != digest
           for name, digest in mapping.items()):
        return False
    # Preserve the interrupted edits; restore every file before any downstream caller runs.
    pending = room.parent / ".author_restore_pending.json"
    cache.atomic_json(pending, {"checkpoint": str(store / "manifest.json")})
    backup = Path(tempfile.mkdtemp(prefix="interrupted-author-", dir=room.parent))
    for path in files(room):
        rel = path.relative_to(room)
        (backup / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, backup / rel)
        if str(rel) not in mapping:
            path.unlink()
    for name, digest in mapping.items():
        target = room / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink():
            target.unlink()
        shutil.copyfile(store / "blobs" / digest, target)
    valid = not source_error(room)
    if valid:
        pending.unlink(missing_ok=True)
    return valid


def input_fingerprint(surface_ref: Path, scan: Path, config: dict) -> str:
    return cache.fingerprint({"config": config,
                              "references": {str(p.relative_to(surface_ref)): cache.file_hash(p)
                                             for p in sorted(surface_ref.rglob("*")) if p.is_file()},
                              "capture": {str(p.relative_to(scan)): cache.file_hash(p)
                                          for p in sorted(scan.rglob("*")) if p.is_file()}})


def summary(room: Path, key: str, *, status: str, completed: list[str], pending: list[str],
            result: str = "", resumed: str = "") -> Path:
    path = room.parent / ".author_resume.json"
    store = room.parent / ".room_checkpoint.d" / "manifest.json"
    cache.atomic_json(path, {"version": 1, "input_fingerprint": key,
                            "source_resources": inventory(room), "status": status,
                            "completed": completed, "pending": pending, "summary": result,
                            "resume_check": resumed,
                            "last_valid_output": str(store) if store.is_file() else None,
                            "checkpoint_validation": "syntax and local resources; not a Blender build"})
    return path
