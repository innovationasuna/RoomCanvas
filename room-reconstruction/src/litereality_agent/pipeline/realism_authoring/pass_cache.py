"""Dependency receipts shared by the two resumable post-authoring passes."""

from pathlib import Path

from litereality_agent import artifact_cache as cache


def prepare(out: Path, preview: Path, frames: Path, layout: dict, code_dir: Path) -> str:
    from litereality_agent.settings import load_settings

    settings = load_settings()
    dependencies = {
        "version": 1,
        "preview": {name: cache.file_hash(preview / name)
                    for name in ("Room.blend", "Room.glb", "room_layout.json")},
        "photos": {camera["image"]: cache.file_hash(frames / camera["image"])
                   for camera in layout.get("cameras", []) if camera.get("image")},
        "code": {p.name: cache.file_hash(p) for p in sorted(code_dir.glob("*.py"))},
        "shared_code": {name: cache.file_hash(Path(__file__).parent / name) for name in
                        ("pass_cache.py", "small_objects/evidence.py", "small_objects/candidates.py")},
        "models": {key: getattr(settings, key) for key in
                   ("agent_provider", "codex_model", "harness_model", "image_provider",
                    "image_model", "dino_model")},
    }
    key = cache.fingerprint(dependencies)
    marker = out / "dependencies.json"
    previous = cache.read_json(marker)
    if not isinstance(previous, dict) or previous.get("key") != key:
        # Legacy items without a receipt cannot prove which room they belong to. Preserve the
        # old run for inspection, but invalidate every derived stage together, before reuse.
        # attempt-NN is the server launcher's own record of this run, not a product of the pass.
        cache.retire([p for p in out.iterdir()
                      if p.name not in {".stale", "logs"} and not p.name.startswith("attempt-")], out)
        cache.atomic_json(marker, {"key": key, "dependencies": dependencies})
    return key


def bundle_matches(folder: Path, key: str, names: tuple[str, ...]) -> bool:
    receipt = cache.read_json(folder / "bundle.json")
    return (isinstance(receipt, dict) and receipt.get("key") == key
            and all((folder / name).is_file() and (folder / name).stat().st_size > 0
                    and receipt.get("outputs", {}).get(name) == cache.file_hash(folder / name)
                    for name in names))


def record_bundle(folder: Path, key: str, names: tuple[str, ...]) -> None:
    if any(not (folder / name).is_file() or not (folder / name).stat().st_size for name in names):
        raise RuntimeError(f"incomplete generated bundle: {folder}")
    cache.atomic_json(folder / "bundle.json", {
        "key": key, "outputs": {name: cache.file_hash(folder / name) for name in names}})


ROOM_FILES = ("Room.blend", "Room.glb", "room_layout.json")


def published_room(folder: Path, author_preview: Path) -> Path:
    """A pass's room_preview another pass may start from: complete as its receipt says, and made
    from the author's current preview (whose room the later pass still takes its Objects from)."""
    receipt = cache.read_json(folder / "bundle.json")
    if not (isinstance(receipt, dict) and bundle_matches(folder, receipt.get("key"), ROOM_FILES)):
        raise ValueError(f"{folder} is not a published room preview (no matching bundle.json)")
    made = cache.read_json(folder.parent / "dependencies.json")
    current = {name: cache.file_hash(author_preview / name)
               for name in ("Room.blend", "Room.glb", "room_layout.json")}
    if isinstance(made, dict) and (made.get("dependencies") or {}).get("preview") != current:
        raise ValueError(f"{folder} was made from another author room than {author_preview}; "
                         "run its pass again first")
    return folder
