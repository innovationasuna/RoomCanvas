// Browser regression: stationary hover must not redraw, and transparency must not jump on settling.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  output: {type: 'string'}, playwright: {type: 'string'}, browser: {type: 'string'}, rooms: {type: 'string', default: 'room3,office'}}});
if (!values.output) throw new Error('请指定仓库外的 --output 结果目录');
const output = resolve(values.output), repo = resolve(fileURLToPath(new URL('../../', import.meta.url)));
if (output === repo || output.startsWith(repo + '/')) throw new Error('不要把私人房间截图写入仓库');
await mkdir(output, {recursive: true});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
const report = {recordedAt: new Date().toISOString(), fixtures: [], rooms: []};
const save = async (name, data) => writeFile(join(output, name), Buffer.from(data.split(',')[1], 'base64'));
try {
  // Small deterministic fixture isolates colour blending from the intended contact AO change.
  const fixture = await browser.newPage({viewport: {width: 320, height: 240}, deviceScaleFactor: 1});
  const errors = [];
  fixture.on('pageerror', error => errors.push(String(error)));
  fixture.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
  await fixture.route('**/__lighting_stability__.html', route => route.fulfill({contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">' + JSON.stringify({imports: {
      three: new URL('vendor/build/three.module.js', values.url).href,
      'three/addons/': new URL('vendor/examples/jsm/', values.url).href,
    }}) + '</script>'}));
  await fixture.goto(new URL('__lighting_stability__.html', values.url).href);
  report.composite = await fixture.evaluate(async base => {
    const THREE = await import('three');
    const {createLightingComposite} = await import(new URL('editor/lighting-composite.mjs', base));
    const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
    renderer.setSize(320, 240); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
    const gl = renderer.getContext(), defaultSamples = gl.getParameter(gl.SAMPLES);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ede5');
    const room = new THREE.Group(); scene.add(room);
    const camera = new THREE.OrthographicCamera(-2, 2, 1.5, -1.5, .1, 20); camera.position.z = 5;
    const geometry = new THREE.PlaneGeometry(3, 2.5), back = new THREE.MeshBasicMaterial({color: 0x182f56});
    const wall = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: .16, depthWrite: false});
    room.add(new THREE.Mesh(geometry, back));
    const near = new THREE.Mesh(geometry, wall); near.position.z = .4; room.add(near);
    const composite = createLightingComposite(renderer);
    composite.render(scene, camera); const moving = renderer.domElement.toDataURL();
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
    composite.render(scene, camera, {ao: white}); const settled = renderer.domElement.toDataURL();
    const result = {moving, settled, defaultSamples, ...composite.snapshot()};
    const background = scene.background, clear = renderer.getClearColor(new THREE.Color()).getHex(), render = renderer.render;
    renderer.render = () => {throw new Error('synthetic render failure');};
    try {composite.render(scene, camera);} catch (error) {result.failure = error.message;}
    result.restored = scene.background === background && renderer.getRenderTarget() === null && renderer.getClearColor(new THREE.Color()).getHex() === clear;
    renderer.render = render;
    composite.dispose(); white.dispose();
    // Reuse the same fixture for the actual static AO controller in both algorithms.
    window.lightingFixture = {THREE, renderer, scene, room, camera, geometry, back, wall};
    return result;
  }, values.url);
  assert.equal(report.composite.moving, report.composite.settled, '透明混合／边缘在不改变遮蔽时仍跳变');
  assert.equal(report.composite.samples, report.composite.defaultSamples, 'MSAA 与屏幕不一致');
  assert.equal(report.composite.restored, true, '异常后未恢复渲染状态');
  await save('transparent-composite.png', report.composite.moving);
  delete report.composite.moving; delete report.composite.settled;
  for (const algorithm of ['gtao', 'n8ao']) {
    const before = await fixture.evaluate(async ({base, algorithm}) => {
      const f = lightingFixture;
      const {createStaticLighting} = await import(new URL('editor/static-lighting.mjs', base));
      const N8AOPass = algorithm === 'n8ao' ? (await import(new URL('vendor/n8ao/N8AOPass.js', base))).N8AOPass : null;
      f.controller = createStaticLighting({...f, roomSize: new f.THREE.Vector3(4, 3, 4), N8AOPass});
      f.controller.render();
      return {image: f.renderer.domElement.toDataURL(), lighting: f.controller.snapshot()};
    }, {base: values.url, algorithm});
    assert.equal(before.lighting.aoSize, null, '交互时分配了 AO 缓冲');
    await fixture.waitForFunction(() => lightingFixture.controller.snapshot().state === 'settled');
    const after = await fixture.evaluate(() => ({image: lightingFixture.renderer.domElement.toDataURL(), lighting: lightingFixture.controller.snapshot()}));
    const centerMaxDelta = await fixture.evaluate(async ({a, b}) => {
      const read = async url => {
        const img = await createImageBitmap(await (await fetch(url)).blob()), canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 128, 88, 64, 64, 0, 0, 64, 64); img.close();
        return ctx.getImageData(0, 0, 64, 64).data;
      };
      const aa = await read(a), bb = await read(b);
      return aa.reduce((max, v, i) => Math.max(max, Math.abs(v - bb[i])), 0);
    }, {a: before.image, b: after.image});
    assert.ok(centerMaxDelta <= 1, `透明墙平坦区域发生明暗跳变：${centerMaxDelta}`);
    await save(`${algorithm}-moving.png`, before.image); await save(`${algorithm}-settled.png`, after.image);
    report.fixtures.push({algorithm, centerMaxDelta, before: before.lighting, after: after.lighting});
    await fixture.evaluate(() => lightingFixture.controller.dispose());
  }
  assert.deepEqual(errors, []);
  await fixture.close();

  for (const room of values.rooms.split(',')) for (const algorithm of ['gtao', 'n8ao', 'off']) {
    console.log(`检查静止悬停 ${room}: ${algorithm}`);
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}, deviceScaleFactor: 1});
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.route('**/viewforge/**', route => route.fulfill({json: {runs: []}}));
    await page.goto(new URL(`editor/?room=${encodeURIComponent(room)}&lightingLab=1&ao=${algorithm}`, values.url).href);
    const settled = async () => {
      // An editor event queues rAF; do not accept the previous frame's settled flag.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => {
        if (window.roomEditorError) throw new Error(window.roomEditorError);
        const light = window.roomEditor?.snapshot().lighting;
        return light?.composite && ['settled', 'off'].includes(light.state) && light.environment.state !== 'loading';
      }, null, {timeout: 180000});
    };
    await settled();
    const initial = await page.evaluate(() => ({image: roomEditor.captureFrame(), light: roomEditor.snapshot().lighting, objects: roomEditor.snapshot().objects}));
    await page.evaluate(() => roomLightingLab.resetMetrics());
    const rect = await page.locator('#viewport canvas').boundingBox();
    // Cross actual furniture projections, empty pixels and the canvas boundary repeatedly.
    for (let sweep = 0; sweep < 2; sweep++) {
      for (const object of initial.objects) {
        const {x, y} = object.screen;
        if (x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height) await page.mouse.move(x, y);
      }
      for (let i = 0; i < 12; i++) {
        await page.mouse.move(rect.x + rect.width * (i + .5) / 12, rect.y + rect.height * .55);
        await page.waitForTimeout(50);
      }
      await page.mouse.move(0, 0);
    }
    await page.waitForTimeout(700);
    const idle = await page.evaluate(() => ({light: roomEditor.snapshot().lighting, metrics: roomLightingLab.metrics()}));
    assert.equal(idle.metrics.frames.length, 0, '鼠标悬停／离开仍触发重绘');
    assert.equal(idle.light.updates, initial.light.updates, '鼠标悬停仍触发 AO');
    assert.equal(await page.evaluate(() => roomEditor.captureFrame()), initial.image, '鼠标移动改变静止画面');
    await save(`${room}-${algorithm}-stationary.png`, initial.image);
    const state = await page.evaluate(() => roomLightingLab.captureState());
    await page.evaluate(state => roomLightingLab.orbit(state, .08), state);
    await settled();
    if (algorithm !== 'off') assert.ok((await page.evaluate(() => roomEditor.snapshot().lighting.updates)) > initial.light.updates, '相机实际移动未更新 AO');
    // Real object movement through the UI must continue drawing while AO waits for release.
    const chair = initial.objects.find(object => /Chair/i.test(object.id));
    assert.ok(chair, '场景无测试椅子');
    // The warehouse drawer may be folded; open it before choosing the real card.
    if (!await page.locator(`[data-object="${chair.id}"]`).isVisible()) await page.locator('#list-toggle').click();
    await page.locator(`[data-object="${chair.id}"]`).click();
    await settled();
    const stick = page.locator('.rc-move-stick'), box = await stick.boundingBox();
    assert.ok(box, '移动摇杆不可见');
    const start = await page.evaluate(() => ({light: roomEditor.snapshot().lighting, object: roomEditor.snapshot().objects.find(o => /Chair/i.test(o.id))}));
    await page.evaluate(() => roomLightingLab.resetMetrics());
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down();
    await page.mouse.move(box.x + box.width * .78, box.y + box.height * .4, {steps: 3});
    await page.waitForTimeout(650);
    const held = await page.evaluate(() => ({light: roomEditor.snapshot().lighting, metrics: roomLightingLab.metrics(), object: roomEditor.snapshot().objects.find(o => /Chair/i.test(o.id))}));
    assert.equal(held.light.updates, start.light.updates, '移动期间计算了 AO');
    assert.ok(held.metrics.frames.length > 1, '家具移动时未连续呈现');
    assert.notDeepEqual(held.object.bounds, start.object.bounds, '家具实际位置未变化');
    await page.mouse.up(); await settled();
    if (algorithm !== 'off') assert.ok((await page.evaluate(() => roomEditor.snapshot().lighting.updates)) > held.light.updates, '松手后没有补算 AO');
    await page.keyboard.press('Escape'); await settled();
    assert.deepEqual(errors, []);
    report.rooms.push({room, algorithm, idleFrames: idle.metrics.frames.length, hoverAOUpdates: idle.light.updates - initial.light.updates,
      heldFrames: held.metrics.frames.length, composite: idle.light.composite});
    await page.close();
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
} finally {await browser.close();}
console.log('通过：悬停零重绘、静止画面不变、统一透明混合与 MSAA、实际交互后更新。结果 ' + output);
