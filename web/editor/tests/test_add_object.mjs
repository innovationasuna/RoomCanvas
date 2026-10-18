import test from 'node:test';
import assert from 'node:assert/strict';
import {objectName, stageLabel, duration, follow, previewURL, startReconstruction, saveMeasurement} from '../add-object.mjs';

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
