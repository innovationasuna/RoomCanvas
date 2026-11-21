"""Dependency receipts shared by the two resumable passes over the authored room."""

from pathlib import Path

from litereality_agent import artifact_cache as cache


def prepare(out: Path, preview: Path, frames: Path, layout: dict, code_dir: Path,
            keep: tuple[str, ...] = ()) -> str:
    """The pass's dependency key; what an earlier key made is retired. `keep` names the per-item
    outputs (items.json and folders by item id) that a new build of the room under the same code,
    photos and models leaves for the pass to reuse where an item is unchanged (`carry`)."""
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
        # Only the room was rebuilt (the check's repair, a revision): each item's own work stays,
        # and the pass keeps it for the items that are still the same (`carry`).
        rebuilt = isinstance(previous, dict) and all(
            (previous.get("dependencies") or {}).get(name) == value
            for name, value in dependencies.items() if name != "preview")
        spare = {".stale", "logs", *(keep if rebuilt else ())}
        cache.retire([p for p in out.iterdir()
                      if p.name not in spare and not p.name.startswith("attempt-")], out)
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


def carry(items: list[dict] | None, found: list[dict]) -> tuple[list[dict], list[str]]:
    """The candidates `found` in the current room, each with its earlier item (and so its work)
    when that one was the same candidate: the same fields as found now (members, box, support).
    Returns them and the ids of earlier items that are gone or changed, whose folders the pass
    retires. Without earlier items, every candidate is new."""
    before = {item["id"]: item for item in items or []}
    kept, dropped = [], []
    for candidate in found:
        old = before.get(candidate["id"])
        if old is not None and all(old.get(key) == value for key, value in candidate.items()):
            kept.append(old)
        else:
            kept.append(candidate)
            if old is not None:
                dropped.append(candidate["id"])
    dropped += sorted(set(before) - {candidate["id"] for candidate in found})
    return kept, dropped
