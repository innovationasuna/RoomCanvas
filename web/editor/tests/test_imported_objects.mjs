import test from 'node:test';
import assert from 'node:assert/strict';
import {forgetImportedObject} from '../imported-objects.mjs';
import {copyLayout, History} from '../layout.mjs';

test('deleting one duplicate preserves the original furniture, the other instance and undo/redo', () => {
  const ids = ['desk', 'added-1', 'added-2'];
  const entities = new Map([['desk', {added: false}], ['added-1', {added: true}], ['added-2', {added: true}]]);
  const layout = Object.fromEntries(ids.map(id => [id, {x: 0, y: 0, z: 0, yaw: 0}]));
  const history = new History(), placementSpecs = Object.fromEntries(ids.map(id => [id, {body: [id]}]));
  const moved = copyLayout(layout); moved.desk.x = .5;
  history.commit(layout, moved);
  history.future.push(copyLayout(moved));
  const state = {ids, entities, layout, history, placementSpecs};
  assert.equal(forgetImportedObject('desk', state), null);
  assert.ok(forgetImportedObject('added-2', state));
  assert.deepEqual(ids, ['desk', 'added-1']);
  assert.ok(entities.has('added-1')); assert.ok(entities.has('desk'));
  for (const snapshot of [layout, placementSpecs, ...history.past, ...history.future]) assert.equal(Object.hasOwn(snapshot, 'added-2'), false);
  const undone = history.undo(layout);
  assert.deepEqual(Object.keys(undone), ['desk', 'added-1']);
  const redone = history.redo(undone);
  assert.deepEqual(Object.keys(redone), ['desk', 'added-1']);
  assert.equal(forgetImportedObject('added-2', state), null);
});
