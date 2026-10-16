import test from 'node:test';
import assert from 'node:assert/strict';
import {PlacementSession} from '../placement-session.mjs';
import {initialLayout, History, encodeLayout, decodeLayout} from '../layout.mjs';

test('preview and carried objects remain isolated from export and crash recovery until confirmation', () => {
  const ids = ['table','item'];
  const before = initialLayout(ids), session = new PlacementSession(before, 'table');
  const candidate = initialLayout(ids); candidate.table.x = 1; candidate.item.x = 1;
  session.update(candidate, true, 'supported');
  candidate.table.x = 9;
  assert.equal(session.candidate.table.x, 1);
  const recovered = decodeLayout(encodeLayout(session.committed(), 'office'), 'office', ids);
  assert.deepEqual(recovered, before);
  assert.deepEqual(session.cancel(), before);
  const committed = session.confirm(), history = new History();
  history.commit(before, committed);
  assert.equal(history.past.length, 1);
  assert.equal(committed.item.x, 1);
  assert.deepEqual(history.undo(committed), before);
  assert.deepEqual(history.redo(before), committed);
});

test('invalid placement cannot commit and cancellation preserves warehouse visibility', () => {
  const before = initialLayout(['chair']); before.chair.visible = false;
  const session = new PlacementSession(before, 'chair');
  const candidate = initialLayout(['chair']); candidate.chair.x = 7;
  session.update(candidate, false, 'outside');
  assert.equal(session.confirm(), null);
  assert.deepEqual(session.cancel(), before);
});
