import test from 'node:test';
import assert from 'node:assert/strict';
import {scanError, jobDescription} from '../room-reconstruction.mjs';
test('scan input rejects photos, empty and oversized archives', () => {
  for (const name of ['客厅.zip', 'Room_3934.tar', 'scan.tar.gz', 'scan.TGZ']) assert.equal(scanError({name, size: 100}, '客厅'), '');
  for (const file of [null, {name: 'x.jpg', size: 1}, {name: 'x.zip', size: 0}, {name: 'x.zip', size: 3 * 1024 ** 3}]) assert.ok(scanError(file, '客厅'));
  assert.ok(scanError({name: 'x.zip', size: 100}, '  '));
});
test('progress reflects real stages and keeps errors distinct from completion', () => {
  assert.match(jobDescription({status: 'queued'}), /等待/);
  assert.match(jobDescription({status: 'running', stages: [{name: 'ingest', status: 'reused'}]}), /重建场景物体/);
  assert.match(jobDescription({status: 'preparing'}), /整理/);
  assert.equal(jobDescription({status: 'failed', error: '模型不可用'}), '模型不可用');
  assert.match(jobDescription({status: 'completed'}), /已加入房间列表/);
});
