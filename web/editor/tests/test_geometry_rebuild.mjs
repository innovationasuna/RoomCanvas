import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import * as THREE from '../../vendor/build/three.module.js';
import {applyEntityPose} from '../entity-geometry.mjs';
import {createPlacement} from '../placement.mjs';
import {buildCollision, collisionOwners, packOwners} from '../collision.mjs';
import {initialLayout, copyLayout, encodeLayout, decodeLayout, History} from '../layout.mjs';
import {forgetImportedObject} from '../imported-objects.mjs';

function box(name, size, position) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.name = name;
  mesh.position.set(...position);
  return mesh;
}

test('rebuilding after import and removal preserves rendered footprints, carried supports and worker collisions across layouts', async t => {
  const room = new THREE.Group(), entities = new Map(), specs = {};
  room.add(box('Floor0', [28, .1, 28], [0, -.05, 0]), box('Obstacle', [.8, 5, 10], [8, 2.5, 0]));
  function add(id, origin, mesh) {
    const group = new THREE.Group(), shape = new THREE.Group();
    group.position.fromArray(origin);
    shape.add(mesh); group.add(shape); room.add(group);
    entities.set(id, {id, name: id, origin: group.position.clone(), group});
    specs[id] = {body: [mesh.name]};
    return shape;
  }
  const tableMesh = box('table-body', [2, 1, 1], [0, .5, 0]);
  const tableShape = add('table', [1, 0, -1], tableMesh);
  tableShape.position.x = .25; tableShape.rotation.y = .3; tableShape.scale.set(.8, 1, 1.25);
  specs.table.surfaces = ['table-body'];
  const payloadMesh = box('cup-body', [.2, .2, .2], [0, 1.1, 0]);
  add('cup', [1.25, 0, -1], payloadMesh);
  const ids = [...entities.keys()], initial = initialLayout(ids), history = new History();
  const rebuild = () => {
    const placement = createPlacement(THREE, room, entities, specs, 0, 4);
    const owners = collisionOwners(THREE, room, entities);
    return {placement, owners, collision: buildCollision(owners, {keepAuthoredOverlaps: true})};
  };
  const render = layout => {
    for (const [id, entity] of entities) applyEntityPose(entity, layout[id]);
    room.updateMatrixWorld(true);
  };
  const baseline = rebuild();
  const moved = copyLayout(initial);
  Object.assign(moved.table, {x: 2, z: 1.5, y: .4, yaw: Math.PI / 3});
  assert.deepEqual(baseline.placement.carry('table', initial, moved).moved, ['table', 'cup']);
  history.commit(initial, moved);
  const stored = copyLayout(moved); stored.table.visible = false;
  history.commit(moved, stored);
  const restored = history.undo(stored), redone = history.redo(restored);
  const importedLayout = decodeLayout(encodeLayout(restored, 'room'), 'room', ids);
  assert.deepEqual(importedLayout, moved);
  assert.deepEqual(redone, stored);

  render(moved);
  const surfacePoint = tableMesh.localToWorld(new THREE.Vector3(0, .5, 0)).toArray();
  const tableBounds = new THREE.Box3().setFromObject(tableMesh, true);
  const footprint = baseline.placement.projectedBase('table', moved);
  assert.ok(Math.abs(Math.min(...footprint.map(p => p[0])) - tableBounds.min.x) < 1e-8);
  assert.ok(Math.abs(Math.max(...footprint.map(p => p[1])) - tableBounds.max.z) < 1e-8);
  assert.equal(baseline.placement.supportAtPoint('table', surfacePoint, moved).owner, 'table');
  assert.equal(baseline.placement.assess('cup', moved).support, 'table');

  // Run the browser Worker's real message handler with a Node message port.
  const bootstrap = `
    import {parentPort, workerData} from 'node:worker_threads';
    globalThis.self = {postMessage: data => parentPort.postMessage(data)};
    await import(workerData);
    parentPort.on('message', data => self.onmessage({data}));
  `;
  const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(bootstrap)), {
    workerData: new URL('../collision-worker.mjs', import.meta.url).href,
  });
  t.after(() => worker.terminate());
  const request = async (data, transfer = []) => {
    const result = once(worker, 'message'); worker.postMessage(data, transfer); return (await result)[0];
  };
  async function verify() {
    const {placement, owners, collision} = rebuild();
    const packed = packOwners(owners);
    assert.equal((await request({type: 'build', owners: packed.owners, keepAuthoredOverlaps: true}, packed.transfer)).type, 'built');
    assert.deepEqual(placement.projectedBase('table', moved), footprint);
    assert.equal(placement.supportAtPoint('table', surfacePoint, moved).owner, 'table');
    assert.equal(placement.supportAtPoint('table', surfacePoint, stored), null);
    const blocked = copyLayout(moved); blocked.table.x = 7;
    for (const [layout, clear] of [[initial, true], [importedLayout, true], [redone, true], [blocked, false]]) {
      assert.deepEqual(placement.assess('cup', layout), baseline.placement.assess('cup', layout));
      const movedIds = ['table', 'cup'];
      const contact = collision.checkPlacement(layout, movedIds);
      assert.equal(contact.ok, clear);
      assert.deepEqual(contact, baseline.collision.checkPlacement(layout, movedIds));
      const response = await request({type: 'drop', candidate: layout, source: moved, moved: movedIds});
      assert.deepEqual(response.contact, {ok: contact.ok, other: contact.other});
      if (clear) {
        const sweep = collision.limit(moved, layout, movedIds);
        assert.deepEqual(response.sweep, {blocked: sweep.blocked, fraction: sweep.fraction, other: sweep.other});
      }
    }
  }

  const other = box('extra-contact', [.5, .5, .5], [0, .25, 0]);
  const shape = add('extra', [-7, 0, 0], other);
  entities.get('extra').added = true; ids.push('extra');
  const display = box('table-body', [1, 1, 1], [0, .5, 0]);
  display.userData.collision = false; shape.add(display);
  const duplicate = box('Floor0', [.1, .1, .1], [0, 2, 0]);
  duplicate.userData.collision = false; shape.add(duplicate);
  await verify();
  const removed = forgetImportedObject('extra', {entities, ids, layout: moved, placementSpecs: specs, history});
  removed.group.removeFromParent();
  render(redone);
  await verify();
});
