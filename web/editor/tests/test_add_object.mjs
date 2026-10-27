import test from 'node:test';
import assert from 'node:assert/strict';
import {MIN_PHOTOS, objectName, stageLabel, duration, follow, previewURL, startReconstruction, saveMeasurement, coverSuggestion, reconstructionStages} from '../add-object.mjs';

test('object names are what the server accepts', () => {
  assert.equal(objectName('  我的 椅子 '), '我的_椅子');
  assert.equal(objectName('desk/lamp?'), 'desklamp');
  assert.equal(objectName('-.x'), '');
  assert.equal(objectName(''), '');
  assert.equal(objectName('a'.repeat(100)).length, 80);
});

test('progress reads as the reconstruction stages', () => {
  assert.equal(stageLabel({kind: 'reconstruct', status: 'queued'}), '排队等 GPU');
  assert.equal(stageLabel({kind: 'reconstruct', status: 'running', stage: 'da3'}), '估计深度与相机');
  assert.equal(stageLabel({kind: 'reconstruct', status: 'running', stage: 'unknown'}), '准备输入');
  assert.equal(stageLabel({kind: 'masks', status: 'running'}), '正在抠图');
  assert.equal(duration(185.7), '03:05');
});

test('single-image progress does not promise DA3 or COVER stages', () => {
  assert.deepEqual(reconstructionStages({pipeline_stages: ['queued', 'preparing', 'reconstruction']}).map(([id]) => id),
    ['queued', 'preparing', 'reconstruction']);
  assert.ok(reconstructionStages({}).some(([id]) => id === 'cover'));
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
