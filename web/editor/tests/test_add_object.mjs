import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {MIN_PHOTOS, objectName, stageLabel, duration, follow, previewURL, startReconstruction, saveMeasurement, coverSuggestion, createObject} from '../add-object.mjs';

test('oversized uploads explain how to reduce the batch and prefer a JSON reason', async t => {
  let body = '<html>Request Entity Too Large</html>';
  class Upload {
    upload = {};
    open() {}
    send() {this.status = 413; this.responseText = body; this.onload();}
  }
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = Upload;
  t.after(() => {globalThis.XMLHttpRequest = original;});
  await assert.rejects(createObject('台灯', []), /减少照片数量或缩小照片/);
  body = JSON.stringify({error: '单张照片太大'});
  await assert.rejects(createObject('台灯', []), {message: '单张照片太大'});
});

test('object names are what the server accepts', () => {
  assert.equal(objectName('  我的 椅子 '), '我的_椅子');
  assert.equal(objectName('desk/lamp?'), 'desklamp');
  assert.equal(objectName('-.x'), '');
  assert.equal(objectName(''), '');
  assert.equal(objectName('a'.repeat(100)).length, 80);
});

test('a completed build keeps its run when reading dimensions fails and retries from the size panel', async t => {
  const vendor = new URL('../../vendor/', import.meta.url);
  const hooks = registerHooks({resolve(name, context, next) {
    if (name === 'three') return next(new URL('build/three.module.js', vendor).href, context);
    if (name.startsWith('three/addons/')) return next(new URL(name.replace('three/addons/', 'examples/jsm/'), vendor).href, context);
    return next(name, context);
  }});
  let mountAddObject;
  try {({mountAddObject} = await import('../add-object-dialog.mjs'));} finally {hooks.deregister();}
  const nodes = new Map();
  const panels = ['photos', 'masks', 'build', 'size'].map(panel => ({dataset: {panel}}));
  function get(selector) {
    if (!nodes.has(selector)) nodes.set(selector, {value: '', dataset: {}, querySelector: get,
      querySelectorAll: key => key === '[data-panel]' ? panels : [], addEventListener() {},
      replaceChildren() {}, setAttribute() {}, showModal() {this.open = true;}});
    return nodes.get(selector);
  }
  let saved = JSON.stringify({object: '椅子', build: 'build1'});
  const storage = {getItem: () => saved, setItem: (_, text) => {saved = text;}, removeItem: () => {saved = null;}};
  for (const [key, value] of Object.entries({document: {querySelector: get, createElement: () => ({})}, localStorage: storage})) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {value, configurable: true});
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  const urls = [], message = '物品重建服务暂时不可用，请稍后重试';
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return url.endsWith('/jobs/build1') ? Response.json({status: 'complete', run: 'chair1'}) :
      Response.json({error: message}, {status: 502});
  });
  mountAddObject({toast() {}});
  get('#add-object').onclick();
  await new Promise(setImmediate);
  assert.deepEqual(panels.filter(panel => !panel.hidden).map(panel => panel.dataset.panel), ['size']);
  assert.match(get('#add-size-note').textContent, new RegExp(message));
  assert.equal(get('#add-retry-size').hidden, false);
  assert.equal(get('#add-place').disabled, true);
  assert.equal(get('#add-object-label').textContent, '物品重建完成');
  assert.equal(JSON.parse(saved).run, 'chair1');
  await get('#add-retry-size').onclick();
  assert.deepEqual(urls, ['/viewforge/objects/jobs/build1', '/viewforge/assets/chair1', '/viewforge/assets/chair1']);
});

test('progress reads as the reconstruction stages', () => {
  assert.equal(stageLabel({kind: 'reconstruct', status: 'queued'}), '排队等待处理');
  assert.equal(stageLabel({kind: 'reconstruct', status: 'running', stage: 'da3'}), '分析拍摄角度');
  assert.equal(stageLabel({kind: 'reconstruct', status: 'running', stage: 'unknown'}), '准备照片');
  assert.equal(stageLabel({kind: 'masks', status: 'running'}), '正在抠图');
  assert.equal(duration(185.7), '03:05');
});

test('a job is followed until it finishes, and a failure carries the server message', async () => {
  const states = [{status: 'queued'}, {status: 'running', stage: 'da3'}, {status: 'complete', run: 'r1'}];
  const seen = [];
  const fetcher = async () => ({ok: true, json: async () => states.shift()});
  const job = await follow('a'.repeat(32), (s) => seen.push(s.status), {every: 0, fetcher});
  assert.equal(job.run, 'r1');
  assert.deepEqual(seen, ['queued', 'running', 'complete']);
  const failed = async () => ({ok: true, json: async () => ({status: 'failed', error: 'GPU 显存不够'})});
  await assert.rejects(follow('b'.repeat(32), () => {}, {every: 0, fetcher: failed}), /GPU 显存不够/);
  const gone = async () => ({ok: false, status: 404, json: async () => ({error: '没有这个任务'})});
  await assert.rejects(follow('c'.repeat(32), () => {}, {every: 0, fetcher: gone}), /没有这个任务/);
});

test('requests go to the ViewForge paths serve.py forwards', async () => {
  const calls = [];
  const fetcher = async (url, init) => {calls.push([url, JSON.parse(init.body)]); return {ok: true, json: async () => ({})};};
  await startReconstruction('我的椅子', ['我的椅子_001'], 'm1', fetcher);
  await saveMeasurement('20261018_我的椅子_web_1_2', 'Z', .8, fetcher);
  assert.deepEqual(calls[0], ['/viewforge/objects/reconstruct', {object: '我的椅子', images: ['我的椅子_001'], masks: 'm1'}]);
  assert.deepEqual(calls[1], [`/viewforge/dimensions/${encodeURIComponent('20261018_我的椅子_web_1_2')}`, {axis: 'Z', value: .8, unit: 'm'}]);
  assert.equal(previewURL('previews/t1/我的椅子_001.png'), `/viewforge/objects/previews/t1/${encodeURIComponent('我的椅子_001')}.png`);
});

test('one photo is enough, and 补拍 rebuilds on top of the earlier run', async () => {
  assert.equal(MIN_PHOTOS, 1);
  const calls = [];
  const fetcher = async (url, init) => {calls.push(JSON.parse(init.body)); return {ok: true, json: async () => ({})};};
  await startReconstruction('台灯', ['台灯', 'capture_1_001'], 'm2', fetcher, '20261024_台灯_web_1');
  assert.deepEqual(calls[0], {object: '台灯', images: ['台灯', 'capture_1_001'], masks: 'm2', parent: '20261024_台灯_web_1'});
});

test('the COVER suggestion is read from the run manifest, or left out', () => {
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const manifest = {status: 'complete', assets: {glb: {transform}, glb_preview: {transform: transform.map((v, i) => i === 12 ? 2 : v)}},
    recommendation: {position: [-1.9, 0, -.7], target: [0, 0, 0], up: [0, 1, 0], fov_y: Math.PI / 12}};
  const preview = coverSuggestion(manifest);
  assert.equal(preview.transform[12], 2);
  assert.deepEqual(preview.position, [-1.9, 0, -.7]);
  assert.ok(Math.abs(preview.fovDegrees - 15) < 1e-9);
  assert.equal(coverSuggestion(manifest, 'glb').transform[12], 0);
  assert.equal(coverSuggestion({...manifest, status: 'failed'}), null);
  assert.equal(coverSuggestion({...manifest, recommendation: null}), null);
  assert.equal(coverSuggestion({...manifest, recommendation: {...manifest.recommendation, position: [1, 2]}}), null);
  assert.equal(coverSuggestion(null), null);
});
