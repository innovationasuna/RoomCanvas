// Browser regression with mocked cache endpoints: never deletes the developer's downloaded files.
import {parseArgs} from 'node:util';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  playwright: {type: 'string'}, browser: {type: 'string'}, screenshot: {type: 'string'}}});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch({headless: true, ...(values.browser ? {executablePath: values.browser} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [], clears = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/web/rooms.json', route => route.fulfill({json: {rooms: []}}));
  await page.route('**/room-reconstruction/**', route => route.fulfill({json: {jobs: [], ok: true}}));
  const initial = [
    {id: 'scan:classroom', name: 'Activity Classroom', kinds: ['房间模型', '重建回放'], files: 28, bytes: 580 * 1024**2},
    {id: 'sample:office', name: '办公室', kinds: ['房间模型'], files: 1, bytes: 36 * 1024**2},
    {id: 'catalog', name: '离线房间列表', kinds: ['列表数据'], files: 2, bytes: 4096},
  ];
  let rows = [...initial], failRead = false, failClear = false, paused = false;
  const inventory = () => ({entries: rows, total_bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    total_files: rows.reduce((sum, row) => sum + row.files, 0), background_paused: paused});
  await page.route('**/web/cache', route => route.fulfill(failRead ? {status: 500, json: {error: '无法读取本地缓存'}} : {json: inventory()}));
  await page.route('**/web/cache/clear', async route => {
    const body = route.request().postDataJSON(); clears.push(body);
    if (failClear) return route.fulfill({status: 409, json: {error: '正在下载缓存，请稍后再清理。'}});
    const removed = rows.filter(row => body.all || body.ids.includes(row.id));
    rows = rows.filter(row => !removed.includes(row)); paused = true;
    await route.fulfill({json: {cache: inventory(), removed_files: removed.reduce((sum, row) => sum + row.files, 0),
      freed_bytes: removed.reduce((sum, row) => sum + row.bytes, 0), errors: []}});
  });
  await page.goto(values.url);
  assert.equal(clears.length, 0);
  await page.locator('#open-cache').click();
  await page.locator('.cache-row').first().waitFor();
  assert.equal(await page.locator('#clear-cache-selected').isDisabled(), true);
  await page.locator('.cache-row input').first().check();
  assert.match(await page.locator('#cache-selection').innerText(), /1 项.*580.0 MiB/);
  assert.equal(await page.locator('#cache-select-all').evaluate(el => el.indeterminate), true);
  if (values.screenshot) await page.screenshot({path: values.screenshot});
  await page.setViewportSize({width: 390, height: 844});
  assert.equal(await page.locator('#cache-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  if (values.screenshot) await page.screenshot({path: values.screenshot.replace(/\.png$/, '-mobile.png')});
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#clear-cache-selected').click();
  assert.equal(clears.length, 0, 'cancelling must not issue a clear request');
  failClear = true;
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-cache-selected').click();
  await page.waitForFunction(() => !document.getElementById('cache-error').hidden);
  assert.match(await page.locator('#cache-error').innerText(), /正在下载/);
  assert.equal(await page.locator('#clear-cache-selected').isEnabled(), true);
  failClear = false;
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-cache-selected').click();
  await page.waitForFunction(() => document.querySelectorAll('.cache-row').length === 2);
  assert.deepEqual(clears.at(-1), {ids: ['scan:classroom']});
  assert.match(await page.locator('#cache-message').innerText(), /释放 580.0 MiB/);
  assert.equal(await page.locator('#cache-paused').isVisible(), true);
  await page.locator('#cache-select-all').check();
  assert.equal(await page.locator('.cache-row input:checked').count(), 2);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-cache-all').click();
  await page.waitForFunction(() => document.getElementById('cache-status').textContent.includes('没有已下载'));
  assert.deepEqual(clears.at(-1), {all: true});
  assert.equal(await page.locator('#clear-cache-all').isDisabled(), true);
  failRead = true;
  await page.locator('#refresh-cache').click();
  await page.waitForFunction(() => !document.getElementById('cache-error').hidden);
  assert.match(await page.locator('#cache-error').innerText(), /无法读取/);
  failRead = false; rows = [...initial];
  await page.locator('#refresh-cache').click();
  await page.locator('.cache-row').first().waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#open-cache').evaluate(el => el === document.activeElement), true);
  assert.deepEqual(errors, []);
  console.log('PASS cache manager: selected/all cleanup, cancellation, retry, empty state, keyboard focus, desktop/mobile layout');
} finally {
  await browser.close();
}
