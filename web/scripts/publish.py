#!/usr/bin/env python3
"""Publish the editor beside a room directory, e.g. a new reconstruction on the server.

python3 web/scripts/publish.py --scene-dir /path/to/room     # needs Room.glb and room_objects.json
cd /path/to/room && python3 -m http.server 7870 --bind 127.0.0.1
Open http://127.0.0.1:7870/preview/editor/

A plain static server lets the browser cache modules, so every relative module and stylesheet
reference in the published editor gets the same ?v=<hash of the editor's files>. The sources carry
none: serve.py revalidates every file, and one stamp means each module loads exactly once.
"""
import argparse
import hashlib
import re
import shutil
from pathlib import Path

# './x.mjs', "../vendor/gesture/gesture-runtime.js", "../theme.css" … in quotes, without a query
REFERENCE = re.compile(r"""(['"])((?:\./|\.\./)[\w./-]+\.(?:mjs|js|css))\1""")


def version(web):
    """A short hash of what the published editor is made of; unchanged code keeps its cache."""
    digest = hashlib.sha256()
    files = [*sorted((web / 'editor').iterdir()), web / 'theme.css', *sorted((web / 'vendor/gesture').iterdir())]
    for file in files:
        if file.is_file():
            digest.update(file.name.encode() + b'\0' + file.read_bytes())
    return digest.hexdigest()[:12]


def stamp(text, tag):
    return REFERENCE.sub(lambda m: f'{m[1]}{m[2]}?v={tag}{m[1]}', text)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--scene-dir', required=True, type=Path)
    args = parser.parse_args()
    scene_dir = args.scene_dir.expanduser().resolve()
    web = Path(__file__).resolve().parents[1]
    for name in ['Room.glb', 'room_objects.json']:
        if not (scene_dir / name).is_file():
            hint = f'; run: python3 web/scripts/room_objects.py {scene_dir}' if name == 'room_objects.json' else ''
            parser.error(f'No {name} in {scene_dir}{hint}')
    preview = scene_dir / 'preview'
    # The editor loads Three.js from ../vendor/, so it goes beside it under preview/. vendor/vision
    # is a link to gesture/public/vision (the hand tracker's model); copytree copies what it points to.
    # Refresh addons too: an existing r180 preview may predate the static AO dependencies.
    shutil.copytree(web / 'vendor', preview / 'vendor', dirs_exist_ok=True)
    if "const REVISION = '180'" not in (preview / 'vendor/build/three.core.js').read_text():
        parser.error(f'{preview / "vendor"} is not Three.js r180')
    # Shared colours and icon, which the editor links as ../theme.css and ../icon.svg.
    for name in ['theme.css', 'icon.svg']:
        shutil.copy2(web / name, preview / name)
    destination = preview / 'editor'
    destination.mkdir(exist_ok=True)
    tag = version(web)
    for file in (web / 'editor').iterdir():
        if file.suffix in {'.html', '.js', '.mjs'}:
            (destination / file.name).write_text(stamp(file.read_text(), tag))
        elif file.suffix == '.css':
            shutil.copy2(file, destination / file.name)
    print(f'Published editor: {destination} (v={tag})')


if __name__ == '__main__':
    main()
