// Browser pixel regression for near-coplanar grid/floor depth at slow orbit angles.
// Start serve.py, then run with --playwright /path/to/playwright and optionally --browser /path/to/chrome.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  playwright: {type: 'string'}, browser: {type: 'string'}}});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
try {
  const page = await browser.newPage({viewport: {width: 480, height: 360}, deviceScaleFactor: 1});
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await page.route('**/__ground_grid__.html', route => route.fulfill({contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">' + JSON.stringify({imports: {
      three: new URL('vendor/build/three.module.js', values.url).href,
      'three/addons/': new URL('vendor/examples/jsm/', values.url).href,
    }}) + '</script>'}));
  await page.goto(new URL('__ground_grid__.html', values.url).href);
  const report = await page.evaluate(async base => {
    const THREE = await import('three');
    const {createGroundGrid} = await import(new URL('editor/ground-grid.mjs', base));
    const {createLightingComposite} = await import(new URL('editor/lighting-composite.mjs', base));
    const width = 480, height = 360;
    const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
    renderer.setSize(width, height); renderer.setPixelRatio(1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ede5');
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(5, 6), new THREE.MeshBasicMaterial({color: 0x153772, side: THREE.DoubleSide}));
    floor.rotation.x = -Math.PI / 2; scene.add(floor);
    const grid = createGroundGrid(THREE, {floorY: 0}); scene.add(grid);
    const composite = createLightingComposite(renderer);
    const whiteAO = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); whiteAO.needsUpdate = true;
    const gl = renderer.getContext();
    const pixels = () => {
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    const isFloor = (data, i) => data[i + 2] > 40 && data[i + 2] > data[i] * 2 && data[i + 1] < data[i + 2] * .8;
    const results = [];
    try {
      for (const pipeline of ['direct', 'composite', 'composite-ao']) {
        for (const camera of [new THREE.PerspectiveCamera(45, width / height, .02, 3000),
          new THREE.OrthographicCamera(-5, 5, 3.75, -3.75, .02, 3000)]) {
          const draw = () => pipeline === 'direct' ? renderer.render(scene, camera)
            : composite.render(scene, camera, {ao: pipeline === 'composite-ao' ? whiteAO : null});
          for (const distance of [12, 24]) for (const elevation of [.15, .65, 1.1]) for (const angle of [.12, .121, 1.35]) {
            camera.position.set(Math.sin(angle) * Math.cos(elevation) * distance, Math.sin(elevation) * distance,
              Math.cos(angle) * Math.cos(elevation) * distance); camera.lookAt(0, 0, 0);
            grid.visible = false; draw(); const off = pixels();
            grid.visible = true; draw(); const on = pixels();
            let interior = 0, leaked = 0, outsideChanged = 0;
            for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) {
              const i = (y * width + x) * 4;
              const delta = Math.max(...[0, 1, 2].map(channel => Math.abs(off[i + channel] - on[i + channel])));
              if (isFloor(off, i) && [-1, 1, -width, width].every(offset => isFloor(off, i + offset * 4))) {
                interior++; if (delta > 2) leaked++;
              } else if (!isFloor(off, i) && delta > 2) outsideChanged++;
            }
            results.push({pipeline, projection: camera.type, distance, elevation, angle, interior, leaked, outsideChanged});
          }
        }
      }
      return results;
    } finally {
      composite.dispose(); whiteAO.dispose(); grid.geometry.dispose(); grid.material.dispose();
      floor.geometry.dispose(); floor.material.dispose(); renderer.dispose();
    }
  }, values.url);
  assert.deepEqual(errors, [], 'browser/shader errors');
  assert.ok(report.every(result => result.interior > 100), 'every angle must actually sample the floor');
  assert.ok(report.every(result => result.outsideChanged > 50), 'the exterior grid must remain visible');
  assert.deepEqual(report.filter(result => result.leaked), [], 'grid pixels must not alter the covered floor');
  console.log(JSON.stringify({cases: report.length, leakingCases: 0, pipelines: ['direct', 'composite', 'composite-ao']}));
} finally {await browser.close();}
