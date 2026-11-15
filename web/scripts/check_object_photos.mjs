// Browser regression: renamed HEIC, validated previews, mixed bad input and upload bytes.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  playwright: {type: 'string'}, browser: {type: 'string'}}});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const heic = await readFile(new URL('../editor/tests/fixtures/photo.heic', import.meta.url));
const png = await readFile(new URL('../editor/tests/fixtures/photo.png', import.meta.url));
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1200, height: 900}}), errors = [], requests = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => requests.push(request.url()));
  // Mount the real dialog in its actual markup; no model/GPU service is needed.
  await page.route('**/editor/editor.js', route => route.fulfill({contentType: 'text/javascript', body:
    "import {mountAddObject} from './add-object-dialog.mjs'; mountAddObject({toast() {}, onReady() {}}); window.photoTestReady = true;"}));
  let uploaded;
  await page.route('**/viewforge/objects/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path.endsWith('/create')) {
      uploaded = {body: [...request.postDataBuffer()], type: request.headers()['content-type']};
      await route.fulfill({json: {object: 'test', images: ['one', 'two', 'three', 'four', 'five', 'six']}});
    } else if (path.endsWith('/masks')) await route.fulfill({json: {id: 'mask-test'}});
    else await route.fulfill({json: {status: 'complete', previews: []}});
  });
  await page.goto(new URL('editor/', values.url).href);
  await page.waitForFunction(() => window.photoTestReady);
  assert.equal(requests.some(url => url.includes('vendor/heic-to/')), false, 'decoder must not load for opening the editor');
  await page.evaluate(() => document.querySelector('#add-object').click());
  await page.locator('#add-name').fill('测试椅子');
  await page.locator('#add-files').setInputFiles([
    {name: 'original.heic', mimeType: 'image/heic', buffer: heic},
    {name: 'original.heif', mimeType: 'image/heif', buffer: heic},
    {name: 'renamed.png', mimeType: 'image/png', buffer: heic},
    {name: 'renamed.jpg', mimeType: 'image/jpeg', buffer: heic},
    {name: 'normal.png', mimeType: 'image/png', buffer: png},
    {name: 'no-mime.png', mimeType: '', buffer: png},
  ]);
  await page.waitForFunction(() => document.querySelector('#add-photos').getAttribute('aria-busy') === 'false', null, {timeout: 60000});
  const previews = await page.locator('#add-photos img').evaluateAll(async images => {
    return Promise.all(images.map(async image => {
      await image.decode(); const blob = await (await fetch(image.src)).blob();
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 48;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return {width: image.naturalWidth, height: image.naturalHeight, type: blob.type,
        corners: [[10, 10], [50, 10], [10, 38], [50, 38]].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data].slice(0, 3))};
    }));
  });
  assert.equal(previews.length, 6);
  for (const [index, result] of previews.entries()) {
    assert.equal(result.type, index < 4 ? 'image/jpeg' : 'image/png');
    assert.deepEqual([result.width, result.height], [64, 48]);
    const expected = [[235, 45, 35], [40, 200, 60], [35, 60, 225], [235, 200, 30]];
    result.corners.forEach((color, i) => color.forEach((value, c) => assert.ok(Math.abs(value - expected[i][c]) < 15, 'orientation and colours must survive conversion')));
  }
  // Bad photos are reported by filename, not added as broken previews or sent later.
  await page.locator('#add-files').setInputFiles([
    {name: 'broken.png', mimeType: 'image/png', buffer: png.subarray(0, 16)},
    {name: 'broken.heic', mimeType: 'image/heic', buffer: heic.subarray(0, 32)},
  ]);
  await page.waitForFunction(() => document.querySelector('#add-photos').getAttribute('aria-busy') === 'false', null, {timeout: 60000});
  assert.match(await page.locator('#add-photos-note').textContent(), /broken.png/);
  assert.match(await page.locator('#add-photos-note').textContent(), /broken.heic/);
  assert.equal(await page.locator('#add-photos img').count(), 6);
  await page.locator('#add-name').fill('改名测试');
  assert.match(await page.locator('#add-photos-note').textContent(), /broken.heic/, 'editing the name must retain photo errors');
  await page.locator('#add-upload').click();
  await page.waitForFunction(() => !document.querySelector('[data-panel="masks"]').hidden);
  assert.ok(uploaded);
  const files = await page.evaluate(async ({body, type}) => {
    const form = await new Response(new Uint8Array(body), {headers: {'Content-Type': type}}).formData();
    return Promise.all(form.getAll('photos').map(async file => ({name: file.name, type: file.type,
      header: [...new Uint8Array(await file.slice(0, 8).arrayBuffer())]})));
  }, uploaded);
  assert.equal(files.length, 6);
  files.forEach((file, index) => {
    assert.equal(file.type, index < 4 ? 'image/jpeg' : 'image/png');
    assert.deepEqual(file.header.slice(0, 3), index < 4 ? [255, 216, 255] : [137, 80, 78]);
  });
  assert.deepEqual(errors, []);
  assert.ok(requests.every(url => url.startsWith(new URL(values.url).origin) || url.startsWith('blob:')), 'conversion must use only local resources');
  console.log('通过：HEIC/HEIF、误改 PNG/JPEG、正常 PNG、损坏照片提示、预览像素及实际上传编码；无外部请求。');
} finally {await browser.close();}
