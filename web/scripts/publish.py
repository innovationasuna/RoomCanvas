#!/usr/bin/env python3
"""Publish the editor beside a room directory, e.g. a new reconstruction on the server.

python3 web/scripts/publish.py --scene-dir /path/to/room     # needs Room.glb and room_objects.json
cd /path/to/room && python3 -m http.server 7870 --bind 127.0.0.1
Open http://127.0.0.1:7870/preview/editor/
"""
import argparse
import shutil
from pathlib import Path


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
    # The editor loads Three.js from ../vendor/, so it goes beside it under preview/.
    # Refresh addons too: an existing r180 preview may predate the static AO dependencies.
    shutil.copytree(web / 'vendor', preview / 'vendor', dirs_exist_ok=True)
    if "const REVISION = '180'" not in (preview / 'vendor/build/three.core.js').read_text():
        parser.error(f'{preview / "vendor"} is not Three.js r180')
    # Shared colours and icon, which the editor links as ../theme.css and ../icon.svg.
    for name in ['theme.css', 'icon.svg']:
        shutil.copy2(web / name, preview / name)
    destination = preview / 'editor'
    destination.mkdir(exist_ok=True)
    for file in (web / 'editor').iterdir():
        if file.suffix in {'.html', '.css', '.js', '.mjs'}:
            shutil.copy2(file, destination / file.name)
    print(f'Published editor: {destination}')


if __name__ == '__main__':
    main()
