// Mobile replay picker: scroll by touch before tapping (locator.tap would scroll for us).
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {url: {type: 'string', default: 'http://127.0.0.1:7880/web/'},
  playwright: {type: 'string'}, browser: {type: 'string'}}});
const {chromium} = createRequire(import.meta.url)(values.playwright ? resolve(values.playwright) : 'playwright');
const browser = await chromium.launch(values.browser ? {executablePath: values.browser} : {});
try {
  const page = await browser.newPage({viewport: {width: 375, height: 667}, hasTouch: true, isMobile: true});
  const jobs = Array.from({length: 15}, (_, i) => ({id: i.toString(16).padStart(32, '0'), created: i, status: 'completed'}));
  await page.route('**/room-reconstruction/jobs', route => route.fulfill({json: {jobs}}));
  await page.route('**/room-reconstruction/jobs/*/replay', route => route.fulfill({status: 404, json: {}}));
  await page.goto(new URL('replay.html', values.url).href);
  const last = page.locator('.pick a').last();
  await last.waitFor();
  const list = await page.locator('#loading').boundingBox();
  const bottom = list.y + list.height;
  assert.ok((await last.boundingBox()).y > bottom);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints});
  for (let swipe = 0; swipe < 5; swipe++) {
    await touch('touchStart', [{x: 180, y: 320}]);
    for (let y = 295; y >= 95; y -= 25) await touch('touchMove', [{x: 180, y}]);
    await touch('touchEnd', []);
    const box = await last.boundingBox();
    if (box.y + box.height <= bottom + 1) break;
  }
  await page.waitForFunction(bottom => document.querySelector('.pick a:last-child').getBoundingClientRect().bottom <= bottom + 1, bottom);
  const box = await last.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForURL(url => url.searchParams.get('job') === jobs[0].id);
} finally {await browser.close();}
