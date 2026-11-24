import test from 'node:test';
import assert from 'node:assert/strict';
import {objectLabel, metricScale, savedMeasurement, placementMatrix, sizeInMeters, readCatalog, readAsset, modelURL, loadModels} from '../object-import.mjs';

const apply = (m, [x, y, z]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('RoomCanvas reads object assets independently of the removed layout service', async () => {
  const calls = [];
  const fetcher = async (url) => {calls.push(url); return {ok: true, json: async () => ({})};};
  await readCatalog(fetcher);
  await readAsset('我的椅子', fetcher);
  assert.deepEqual(calls, ['/viewforge/assets/catalog', `/viewforge/assets/${encodeURIComponent('我的椅子')}`]);
  assert.equal(modelURL('我的椅子', 'result.glb'), `/viewforge/assets/${encodeURIComponent('我的椅子')}/result.glb`);
});

test('an older running backend supplies catalog, metadata and both models through object-only legacy reads', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return url === '/viewforge/assets/catalog' ? {ok: false, status: 404} :
      {ok: true, json: async () => ({runs: ['chair']})};
  };
  assert.deepEqual(await readCatalog(fetcher), {runs: ['chair']});
  await readAsset('我的椅子', fetcher);
  assert.deepEqual(calls, ['/viewforge/assets/catalog', '/viewforge/layouts/catalog', `/viewforge/layouts/assets/${encodeURIComponent('我的椅子')}`]);
  for (const file of ['result.glb', 'preview.glb']) {
    assert.equal(modelURL('chair', file), `/viewforge/layouts/assets/chair/${file}`);
  }
  // Once the backend is upgraded the preferred object API is selected again.
  await readCatalog(async () => ({ok: true, json: async () => ({runs: []})}));
  assert.equal(modelURL('chair', 'result.glb'), '/viewforge/assets/chair/result.glb');
});

test('connection and server errors are reported without falling back to another API', async () => {
  for (const status of [403, 500, 502]) {
    const calls = [];
    await assert.rejects(readCatalog(async (url) => {calls.push(url); return {ok: false, status};}), new RegExp(String(status)));
    assert.deepEqual(calls, ['/viewforge/assets/catalog']);
  }
});

test('older results without a light preview still import with a separate contact scene', async () => {
  const contact = {}, full = {scene: {clone: () => contact}}, light = {scene: {}};
  const load = async (url) => url.endsWith('result.glb') ? full : light;
  assert.deepEqual(await loadModels('chair', load), {full, light});
  const fallback = await loadModels('chair', async (url) => {
    if (!url.endsWith('result.glb')) throw new Error('proxy/preview 404');
    return full;
  });
  assert.equal(fallback.full, full);
  assert.equal(fallback.light.scene, contact);
  assert.notEqual(fallback.light.scene, full.scene);
});

test('independent collision geometry is preferred while display keeps the full PBR asset', async () => {
  const calls = [], full = {scene: {material: 'PBR'}}, proxy = {scene: {material: null}};
  const result = await loadModels('chair', async (url) => {
    calls.push(url);
    return url.endsWith('result.glb') ? full : proxy;
  });
  assert.deepEqual(result, {full, light: proxy});
  assert.equal(calls.length, 2);
  assert.ok(calls[1].endsWith('collision.glb'));
  const legacy = await loadModels('chair', async (url) => {
    if (url.endsWith('collision.glb')) throw new Error('legacy 404');
    return url.endsWith('result.glb') ? full : proxy;
  });
  assert.equal(legacy.light, proxy);
});

test('asset publication errors retain their actionable pending or failed state', async () => {
  for (const state of ['asset_pending', 'asset_failed']) {
    await assert.rejects(readAsset('chair', async () => ({ok: false, status: 409,
      json: async () => ({state, error: '模型尚未发布'})})),
      error => error.state === state && error.message === '模型尚未发布');
  }
});

test('an unavailable full model is still reported as an import failure', async () => {
  await assert.rejects(loadModels('chair', async () => {throw new Error('model unavailable');}), /model unavailable/);
  const response = Response.json({error: '物品重建服务暂时不可用'}, {status: 502});
  await assert.rejects(loadModels('chair', async url => {
    if (url.endsWith('result.glb')) throw Object.assign(new Error(`fetch for ${url} responded with 502`), {response});
    return {scene: {}};
  }), {message: '物品重建服务暂时不可用'});
});

test('ViewForge run ids become short names', () => {
  assert.equal(objectLabel('20260926_sofa_web_114146_561893'), 'sofa');
  assert.equal(objectLabel('20261015_roomabc_Table0_C_20261015_a01'), 'roomabc_Table0_C');
  assert.equal(objectLabel('20260913_stuffed_toy_slim_a01'), 'stuffed_toy_slim');
  assert.equal(objectLabel('20260918_Cody_walkthrough_20260918'), 'Cody_walkthrough');
});

test('one measured edge scales the model; a saved calibration is offered first', () => {
  const base = {lengths: {X: 1, Y: .4, Z: .32}};
  assert.equal(metricScale(base, 'Z', 1.6), 5);
  assert.throws(() => metricScale(base, 'Z', 0));
  assert.throws(() => metricScale(base, 'W', 1));
  assert.deepEqual(savedMeasurement({calibration: {axis: 'Z', dimensions_m: {X: 3.4, Y: 1.4, Z: 1.1}}}), {axis: 'Z', meters: 1.1});
  assert.equal(savedMeasurement({calibration: null}), null);
});

test('the placement matrix centres the footprint, stands the model on y = 0 and scales it', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const base = {transform: identity, bounds: {min: [-1, -.5, 2], max: [3, .5, 4]}};
  const m = placementMatrix(base, 2);
  assert.ok(close(apply(m, [1, -.5, 3]), [0, 0, 0]), 'bottom centre → origin');
  assert.ok(close(apply(m, [3, .5, 4]), [4, 2, 2]));
  assert.deepEqual(sizeInMeters(base, 2), [8, 2, 4]);
  // A display transform (here a quarter turn about Y, then the bounds of the turned model).
  const turn = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const turned = placementMatrix({transform: turn, bounds: {min: [0, 0, -2], max: [2, 1, 0]}}, 1);
  assert.ok(close(apply(turned, [1, 0, 0]), [-1, 0, 0]), 'the transform is applied before centring');
});
