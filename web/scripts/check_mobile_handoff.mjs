// Full GLB round-trip plus phone viewer / fallback / failure-retry / responsive smoke checks.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {
  url: {type: 'string', default: 'http://127.0.0.1:7880/web/editor/?room=office&ao=off'},
  share: {type: 'string', default: 'http://127.0.0.1:7881'},
  playwright: {type: 'string'}, browser: {type: 'string'}, output: {type: 'string', default: '/tmp/roomcanvas-mobile-check'},
}});
const {chromium, devices} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
await mkdir(values.output, {recursive: true});
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
try {
  const errors = [], page = await browser.newPage({viewport: {width: 1280, height: 800}});
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(values.url);
  await page.waitForFunction(() => window.roomEditor?.ready, null, {timeout: 90000});
  const before = await page.evaluate(() => window.roomEditor.snapshot());
  await page.locator('#open-help').click();
  const instructions = await page.locator('.rc-help-note').filter({hasText: 'Wi-Fi'}).innerText();
  await page.locator('[aria-label="关闭帮助"]').click();
  await page.locator('#mobile-share').click();
  assert.ok(instructions.includes(`“${await page.locator('#mobile-share').innerText()}”，再点“${await page.locator('#mobile-share-generate').innerText()}”`));
  assert.ok(await page.locator('.mobile-share-result').isHidden());
  await page.locator('#mobile-share-generate').click();
  await page.waitForFunction(() => !document.querySelector('#mobile-share-generate').disabled, null, {timeout: 120000});
  const link = await page.locator('#mobile-share-link').inputValue();
  assert.match(link, /^http:\/\/[^/]+\/s\/[a-f0-9]{32}\/$/, await page.locator('#mobile-share-status').textContent());
  const path = new URL(link).pathname;
  await page.screenshot({path: resolve(values.output, 'desktop-share.png')});
  // Read through the desktop origin for inspection (phone server separately tested below).
  const loaded = await page.evaluate(async path => {
    const {GLTFLoader} = await import('/web/vendor/examples/jsm/loaders/GLTFLoader.js');
    const id = path.split('/')[2];
    const bytes = await (await fetch(`/.roomcanvas/shares/${id}/room.glb`)).arrayBuffer();
    const gltf = await new GLTFLoader().parseAsync(bytes, ''); gltf.scene.updateMatrixWorld(true);
    const objects = [], THREE = await import('/web/vendor/build/three.module.js');
    let lighting = null;
    gltf.scene.traverse(n => {
      objects.push({name: n.userData.name || n.name, position: n.getWorldPosition(new THREE.Vector3()).toArray()});
      if (n.userData.roomcanvas) lighting = n.userData.roomcanvas.lighting;
    });
    return {objects, lighting, external: [...(gltf.parser.json.buffers || []), ...(gltf.parser.json.images || [])].some(r => r.uri && !r.uri.startsWith('data:'))};
  }, path);
  assert.equal(loaded.external, false);
  assert.equal(loaded.lighting.preset, before.lighting.time.preset);
  assert.deepEqual(loaded.lighting.grading, before.lighting.grading);
  for (const object of before.objects.filter(o => o.visible)) for (const member of object.members) {
    const exported = loaded.objects.find(o => o.name === member.name);
    assert.ok(exported, `missing ${member.name}`);
    assert.ok(exported.position.every((v, i) => Math.abs(v - member.position[i]) < 1e-4), `transform changed: ${member.name}`);
  }
  assert.deepEqual((await page.evaluate(() => window.roomEditor.snapshot())).layout, before.layout);
  await page.locator('[aria-label="关闭手机分享"]').click();
  await page.screenshot({path: resolve(values.output, 'editor-after-export.png')});

  const mobile = await browser.newPage({...devices['Pixel 7'], deviceScaleFactor: 1});
  mobile.on('pageerror', e => errors.push(e.message));
  const mobileURL = new URL(path, values.share).href;
  await mobile.goto(mobileURL);
  await mobile.locator('#open-browser:not([disabled])').waitFor();
  assert.match(await mobile.locator('#open-app').getAttribute('href'), /^roomcanvas:\/\/import\?manifest=/);
  // Keep the browser path available when the App is unavailable.
  await mobile.locator('#open-app').evaluate(a => {a.addEventListener('click', e => e.preventDefault()); a.click();});
  assert.equal(await mobile.locator('#app-hint').isVisible(), true);
  assert.equal(await mobile.locator('#open-browser').isEnabled(), true);
  await mobile.screenshot({path: resolve(values.output, 'phone-entry.png')});
  let failOnce = true;
  await mobile.route('**/room.glb', route => {
    if (failOnce) {failOnce = false; return route.fulfill({status: 503, body: 'test unavailable'});}
    return route.continue();
  });
  await mobile.locator('#open-browser').click(); await mobile.locator('#retry').waitFor({state: 'visible'});
  await mobile.locator('#retry').click(); await mobile.locator('#walk:not([disabled])').waitFor({timeout: 90000});
  assert.equal(await mobile.locator('#viewport').getAttribute('data-lighting'), loaded.lighting.preset);
  await mobile.locator('#walk').click();
  assert.equal(await mobile.locator('#touch-pad').isVisible(), true);
  await mobile.screenshot({path: resolve(values.output, 'phone-walk.png')});
  await mobile.locator('#reset').click(); await mobile.locator('#walk').click();
  assert.equal(await mobile.locator('#touch-pad').isVisible(), false);
  await mobile.locator('#back').click();
  for (const [width, height] of [[320, 720], [390, 844], [844, 390], [768, 1024]]) {
    await mobile.setViewportSize({width, height});
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow ${width}`);
  }
  const iphone = await browser.newPage({...devices['iPhone 13'], deviceScaleFactor: 1});
  iphone.on('pageerror', e => errors.push(e.message));
  await iphone.goto(mobileURL); await iphone.locator('#open-browser:not([disabled])').waitFor();
  assert.equal(await iphone.locator('#open-app').isVisible(), true);
  assert.equal(await iphone.locator('#open-app').getAttribute('aria-disabled'), 'true');
  assert.equal(await iphone.locator('#open-app').getAttribute('href'), null);
  assert.match(await iphone.locator('#app-requirement').textContent(), /当前设备不支持 Android App/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ok: true, originalObjects: before.objects.filter(o => o.visible).length, snapshotNodes: loaded.objects.length, mobileURL, screenshots: values.output}));
} finally {await browser.close();}
