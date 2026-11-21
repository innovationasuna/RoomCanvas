import test from 'node:test';
import assert from 'node:assert/strict';
import {releasableBytes} from '../cache-manager.mjs';

test('shared room files release space only when all links are selected', () => {
  const sample = {id: 'sample', bytes: 1024, blobs: [{id: '1:42', bytes: 1024, links: 3, refs: 1}]};
  const replay = {id: 'replay', bytes: 1024, blobs: [{id: '1:42', bytes: 1024, links: 3, refs: 2}]};
  assert.equal(releasableBytes([sample]), 0);
  assert.equal(releasableBytes([replay]), 0);
  assert.equal(releasableBytes([sample, replay]), 1024);
  // A fourth link outside the managed cache still keeps the underlying data alive.
  const external = [sample, replay].map(row => ({...row, blobs: row.blobs.map(blob => ({...blob, links: 4}))}));
  assert.equal(releasableBytes(external), 0);
});

test('independent copies on different devices and older servers remain additive', () => {
  const rows = ['1:42', '2:42'].map(id => ({bytes: 1024, blobs: [{id, bytes: 1024, links: 1, refs: 1}]}));
  assert.equal(releasableBytes(rows), 2048);
  assert.equal(releasableBytes([{id: 'old-a', bytes: 100}, {id: 'old-b', bytes: 200}]), 300);
});
