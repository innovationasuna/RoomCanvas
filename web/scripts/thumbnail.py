#!/usr/bin/env python3
"""Write thumbnail.jpg for the home page's rooms, from the editor's overall view.

python3 web/scripts/serve.py &                    # the editor must be served
python3 web/scripts/thumbnail.py                  # every room; or: --room room3
Needs Playwright with Chromium (pip install playwright && playwright install chromium) and Pillow.

Rooms come from the served list, so reconstructed rooms are included when serve.py is connected to the
room service. Their thumbnail belongs on the server, next to the published room:

python3 web/scripts/thumbnail.py --url http://127.0.0.1:17900/web/ --room scan-<job> \
    --ssh student2-8 --server-dir /home/data1/lyk/RoomCanvas
"""
import argparse
import io
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path

WEB = Path(__file__).resolve().parents[1]
ASSETS = '/room-reconstruction/assets/'  # where serve.py lists a reconstructed room
SIZE = (960, 600)
# Everything drawn over the room; the shelf and header are outside the screenshot.
HIDE = '.rc-tools, .rc-help, .rc-view-tools, .rc-controls, .rc-joysticks, .rc-toast, .rc-guide, .selection-label, .rc-drop-label { display: none !important; }'


def fit(png):
    """The room, cropped from the plain background (the top-left pixel) and centred at 16:10."""
    from PIL import Image, ImageChops
    image = Image.open(io.BytesIO(png)).convert('RGB')
    background = Image.new('RGB', image.size, image.getpixel((0, 0)))
    left, top, right, bottom = ImageChops.difference(image, background).point(lambda v: 255 if v > 12 else 0).getbbox()
    width, height = right - left, bottom - top
    width, height = max(width, height * SIZE[0] / SIZE[1]) * 1.08, max(height, width * SIZE[1] / SIZE[0]) * 1.08
    cx, cy = (left + right) / 2, (top + bottom) / 2
    canvas = Image.new('RGB', (round(width), round(height)), image.getpixel((0, 0)))
    canvas.paste(image, (round(width / 2 - cx), round(height / 2 - cy)))
    return canvas.resize(SIZE, Image.LANCZOS)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', default='http://127.0.0.1:7880/web/', help='the served web/ directory')
    parser.add_argument('--room', action='append', help='room id (default: all)')
    parser.add_argument('--ssh', help='SSH host of the room service, for reconstructed rooms')
    parser.add_argument('--server-dir', help='RoomCanvas checkout on that host')
    args = parser.parse_args()
    from playwright.sync_api import sync_playwright
    with urllib.request.urlopen(f'{args.url}rooms.json', timeout=30) as response:
        rooms = [room for room in json.load(response)['rooms'] if not args.room or room['id'] in args.room]
    remote = [room['id'] for room in rooms if room['dir'].startswith(ASSETS)]
    if remote and not (args.ssh and args.server_dir):
        raise SystemExit(f'{", ".join(remote)}: reconstructed, so the thumbnail goes to the server: pass --ssh and --server-dir')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(args=['--use-gl=angle', '--enable-unsafe-swiftshader'])
        for room in rooms:
            page = browser.new_page(viewport={'width': 1280, 'height': 1040}, device_scale_factor=1)
            page.goto(f"{args.url}editor/?room={room['id']}")
            page.wait_for_function('document.querySelector("#loading").hidden || window.roomEditorError', timeout=300_000)
            if page.evaluate('window.roomEditorError'):
                raise SystemExit(f"{room['id']}: {page.evaluate('window.roomEditorError')}")
            page.add_style_tag(content=HIDE)
            # The ground grid would leave no plain background to crop the room from.
            page.evaluate('(grid => grid && grid.checked && grid.click())(document.querySelector("#ground-grid"))')
            page.wait_for_timeout(1500)
            image = fit(page.locator('.rc-stage').screenshot(type='png'))
            if room['dir'].startswith(ASSETS):
                job = room['dir'][len(ASSETS):].strip('/')
                out = f'{args.ssh}:{args.server_dir}/runs/web-room-jobs/{job}/assets/thumbnail.jpg'
                with tempfile.TemporaryDirectory() as folder:
                    image.save(Path(folder) / 'thumbnail.jpg', quality=82)
                    subprocess.run(['scp', '-q', str(Path(folder) / 'thumbnail.jpg'), out], check=True)
            else:
                out = (WEB / room['dir'] / 'thumbnail.jpg').resolve()
                image.save(out, quality=82)
            print(f'{room["id"]}: {out}')
            page.close()
        browser.close()


if __name__ == '__main__':
    main()
