import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import * as THREE from '../../vendor/build/three.module.js';
import {buildCollision, collisionOwners, triangleIndex, unpackOwners} from '../collision.mjs';
import {buildTriangleIndex} from '../triangle-index.mjs';
import {createSceneGeometry} from '../scene-geometry.mjs';

function fixture() {
  const room = new THREE.Group(), entities = new Map();
  const material = new THREE.MeshBasicMaterial({side: THREE.DoubleSide});
  const floor = new THREE.Mesh(new THREE.BoxGeometry(8, .1, 8), material);
  floor.name = 'Floor0'; floor.position.y = -.05; room.add(floor);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(.2, 2, 4), material);
  wall.name = 'Wall0'; wall.position.set(2, 1, 0); room.add(wall);
  function add(id, x = 0, z = 0) {
    const group = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(.5, .5, .5), material);
    body.name = `${id}-body`; body.position.y = .25; group.add(body);
    group.position.set(x, 0, z); room.add(group);
    entities.set(id, {id, name: id, group, origin: new THREE.Vector3(x, 0, z), added: id !== 'moving'});
    return {group, body};
  }
  add('moving');
  return {room, entities, floor, wall, add, specs: [], floorY: 0, ceilingY: 3,
    owners: () => collisionOwners(THREE, room, entities, {includeQueryOnly: true})};
}

// A separate module realm is essential: an in-process mock of collision-worker
// would share its WeakMap indexes with the page and hide a missing index reply.
function threadWorker(t, {holdReplies = false} = {}) {
  const bootstrap = `import {parentPort, workerData} from 'node:worker_threads';
    globalThis.self = {postMessage: (data, transfer) => parentPort.postMessage(data, transfer)};
    await import(workerData);
    parentPort.on('message', data => self.onmessage({data}));`;
  const thread = new Worker(new URL(`data:text/javascript,${encodeURIComponent(bootstrap)}`), {
    workerData: new URL('../collision-worker.mjs', import.meta.url).href,
  });
  const sent = [], received = [], waiting = [];
  let stopped = null;
  const worker = {
    sent, received,
    postMessage(data, transfer) {sent.push(data); thread.postMessage(data, transfer);},
    terminate() {return stopped ||= thread.terminate();},
    deliver(data) {worker.onmessage?.({data});},
    reply(generation) {
      const reply = received.find(data => data.type === 'built' && data.generation === generation);
      return reply ? Promise.resolve(reply) : new Promise((resolve, reject) => waiting.push({generation, resolve, reject}));
    },
  };
  thread.on('message', data => {
    received.push(data);
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (data.type === 'built' && waiting[i].generation === data.generation) waiting.splice(i, 1)[0].resolve(data);
    }
    if (!holdReplies) worker.deliver(data);
  });
  thread.on('error', error => {
    for (const pending of waiting.splice(0)) pending.reject(error);
    worker.onerror?.(error);
  });
  t.after(() => worker.terminate());
  return worker;
}

function mockWorker() {
  return {sent: [], stopped: false,
    postMessage(data) {this.sent.push(data);},
    terminate() {this.stopped = true;},
    deliver(data) {this.onmessage?.({data});},
  };
}

function builtReply(message) {
  const indexes = unpackOwners(message.owners).map(({id, meshes}) => ({id, meshes: meshes.map(({triangles}) => {
    const {data, faces, tree} = buildTriangleIndex(triangles);
    return {data, faces, tree};
  })}));
  return {type: 'built', generation: message.generation, indexes};
}

function assertUsable(state, source) {
  const ray = state.queries.nearest(new THREE.Vector3(3, 2, 3), new THREE.Vector3(0, -1, 0));
  assert.equal(ray.object, source.floor);
  const clear = {moving: {x: 0, y: 0, z: 0, yaw: 0}};
  const blocked = {moving: {x: 1.8, y: 0, z: 0, yaw: 0}};
  assert.equal(state.collision.checkPlacement(clear, ['moving']).ok, true);
  assert.equal(state.collision.checkPlacement(blocked, ['moving']).ok, false);
  return {clear, blocked};
}

test('a real Worker supplies collision and floor ray indexes without a page rebuild', {timeout: 5000}, async t => {
  const source = fixture(), worker = threadWorker(t), errors = [], stages = [];
  const owners = source.owners(), original = owners.map(owner => owner.meshes[0].triangles);
  const points = original.map(triangles => triangles.map(triangle => triangle.slice()));
  const geometry = createSceneGeometry(THREE, {...source, worker: () => worker,
    onError: error => errors.push(error), finishStage: (_operation, stage) => stages.push(stage)});
  t.after(() => geometry.dispose());
  let settled = false;
  const pending = geometry.rebuildCollision('initial').then(state => {settled = true; return state;});
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(stages, ['collisionGeometry', 'collisionWorkerSubmit']);
  const first = await pending, reply = await worker.reply(1);
  assert.deepEqual(errors, []);
  assert.equal(reply.audit.builtMeshes, 3);
  assert.equal(first.collision.audit.builtMeshes, 0);
  assert.equal(first.collision.audit.objects, 2, 'Floor0 is queried but is not a collision obstacle');
  assert.deepEqual(reply.indexes.map(owner => owner.id), owners.map(owner => owner.id));
  for (let i = 0; i < owners.length; i++) {
    const index = triangleIndex(original[i]);
    assert.equal(index.triangles, original[i]);
    assert.equal(index.data, reply.indexes[i].meshes[0].data, 'install the received index, including Floor0');
    for (let face = 0; face < original[i].length; face++) for (let k = 0; k < 3; k++) {
      assert.equal(index.triangles[face][k], points[i][face][k]);
    }
  }
  const movingIndex = triangleIndex(original[0]), {clear, blocked} = assertUsable(first, source);
  const contact = first.collision.checkPlacement(blocked, ['moving']);
  const drop = await first.background.request(blocked, ['moving'], clear);
  assert.deepEqual(drop.contact, {ok: contact.ok, other: contact.other});

  const added = source.add('added', -2, -2);
  const second = await geometry.rebuildCollision('add'), secondReply = await worker.reply(2);
  assert.equal(second.queries, first.queries);
  assert.equal(second.background, first.background);
  assert.equal(second.collision.audit.builtMeshes, 0);
  assert.equal(secondReply.audit.builtMeshes, 1);
  assert.deepEqual(worker.sent.find(data => data.generation === 2 && data.type === 'update').owners.map(owner => owner.id), ['added']);
  assert.deepEqual(secondReply.indexes.map(owner => owner.id), ['added']);
  assert.equal(triangleIndex(original[0]), movingIndex);
  assert.equal(second.queries.nearest(new THREE.Vector3(-2, 2, -2), new THREE.Vector3(0, -1, 0)).object, added.body);

  added.group.removeFromParent(); source.entities.delete('added');
  const third = await geometry.rebuildCollision('remove'), thirdReply = await worker.reply(3);
  const removal = worker.sent.find(data => data.generation === 3 && data.type === 'update');
  assert.deepEqual(removal.removed, ['added']);
  assert.deepEqual(removal.owners, []);
  assert.deepEqual(thirdReply.indexes, []);
  assert.equal(thirdReply.audit.builtMeshes, 0);
  assert.equal(third.collision.audit.builtMeshes, 0);
  assert.equal(third.queries, first.queries);
  assert.equal(third.queries.nearest(new THREE.Vector3(-2, 2, -2), new THREE.Vector3(0, -1, 0)).object, source.floor);
  assert.equal(triangleIndex(original[0]), movingIndex);
  assert.deepEqual(errors, []);
});

test('superseding an unfinished first build installs only the latest Worker reply', {timeout: 5000}, async t => {
  const source = fixture(), worker = threadWorker(t, {holdReplies: true}), errors = [], stages = [];
  const owners = source.owners();
  const geometry = createSceneGeometry(THREE, {...source, worker: () => worker,
    onError: error => errors.push(error), finishStage: (operation, stage) => stages.push([operation, stage])});
  t.after(() => geometry.dispose());
  const first = geometry.rebuildCollision('old');
  let settled = false;
  const latest = geometry.rebuildCollision('latest').then(state => {settled = true; return state;});
  assert.equal(await first, null);
  const oldReply = await worker.reply(1);
  worker.deliver(oldReply);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(stages.some(([, stage]) => stage === 'collisionIndexInstall' || stage === 'collisionMainBuild'), false);
  const latestReply = await worker.reply(2);
  worker.deliver(latestReply);
  const state = await latest;
  assert.deepEqual(errors, []);
  assert.equal(state.collision.audit.builtMeshes, 0);
  for (const owner of owners) {
    const received = latestReply.indexes.find(index => index.id === owner.id);
    assert.ok(received, 'the latest reply must supply indexes that were never installed');
    assert.equal(triangleIndex(owner.meshes[0].triangles).data, received.meshes[0].data);
    assert.notEqual(triangleIndex(owner.meshes[0].triangles).data, oldReply.indexes.find(index => index.id === owner.id).meshes[0].data);
  }
  assertUsable(state, source);
});

test('superseding after a Worker reply but before installation reuses its received buffers', {timeout: 5000}, async t => {
  const source = fixture(), worker = threadWorker(t, {holdReplies: true}), errors = [], stages = [];
  const owners = source.owners();
  const geometry = createSceneGeometry(THREE, {...source, worker: () => worker,
    onError: error => errors.push(error), finishStage: (operation, stage) => stages.push([operation, stage])});
  t.after(() => geometry.dispose());
  const first = geometry.rebuildCollision('old'), firstReply = await worker.reply(1);
  worker.deliver(firstReply);
  // Do not await here: the client has resolved g1, but the service has not
  // resumed to install its buffers when g2 supersedes that continuation.
  const latest = geometry.rebuildCollision('latest');
  assert.equal(await first, null);
  assert.equal(stages.some(([, stage]) => stage === 'collisionIndexInstall' || stage === 'collisionMainBuild'), false);
  const latestReply = await worker.reply(2);
  assert.deepEqual(latestReply.indexes, []);
  assert.equal(latestReply.audit.builtMeshes, 0);
  worker.deliver(latestReply);
  const state = await latest;
  assert.deepEqual(errors, []);
  assert.equal(state.collision.audit.builtMeshes, 0);
  for (const owner of owners) {
    const received = firstReply.indexes.find(index => index.id === owner.id);
    assert.equal(triangleIndex(owner.meshes[0].triangles).data, received.meshes[0].data);
  }
  assert.deepEqual(stages.filter(([, stage]) => stage === 'collisionIndexInstall' || stage === 'collisionMainBuild'),
    [['latest', 'collisionIndexInstall'], ['latest', 'collisionMainBuild']]);
  assertUsable(state, source);
});

test('removing an owner uses installed indexes while an obsolete Worker check is still queued', async t => {
  const source = fixture(), added = source.add('added', -2, -2), worker = mockWorker(), errors = [];
  const geometry = createSceneGeometry(THREE, {...source, worker: () => worker, onError: error => errors.push(error)});
  t.after(() => geometry.dispose());
  const initial = geometry.rebuildCollision('initial');
  worker.deliver(builtReply(worker.sent[0]));
  const first = await initial;
  const obsolete = first.background.request({}, ['moving'], {});
  const drop = worker.sent.at(-1);
  added.group.removeFromParent(); source.entities.delete('added');
  const state = await geometry.rebuildCollision('remove');
  assert.equal(await obsolete, null);
  assert.equal(state.background.ready, false, 'the Worker has not processed the update yet');
  assert.equal(state.collision.audit.builtMeshes, 0);
  assert.equal(state.queries, first.queries);
  assert.equal(state.queries.nearest(new THREE.Vector3(-2, 2, -2), new THREE.Vector3(0, -1, 0)).object, source.floor);
  assertUsable(state, source);
  worker.deliver({...drop, contact: {ok: false}});
  assert.equal(state.background.ready, false);
  const update = worker.sent.at(-1);
  assert.deepEqual(update.owners, []);
  assert.deepEqual(update.indexIds, []);
  worker.deliver(builtReply(update));
  assert.equal(state.background.ready, true);
  assert.deepEqual(errors, []);
});

test('disposing a pending build settles it and does not install a late index package', async () => {
  const source = fixture(), owners = source.owners(), worker = mockWorker(), errors = [], stages = [];
  const geometry = createSceneGeometry(THREE, {...source, worker: () => worker,
    onError: error => errors.push(error), finishStage: (_operation, stage) => stages.push(stage)});
  const pending = geometry.rebuildCollision('dispose'), reply = builtReply(worker.sent[0]);
  geometry.dispose();
  assert.equal(await pending, null);
  assert.equal(worker.stopped, true);
  worker.deliver(reply);
  assert.equal(await geometry.rebuildCollision('after disposal'), null);
  assert.equal(worker.sent.length, 1);
  assert.deepEqual(stages, ['collisionGeometry', 'collisionWorkerSubmit']);
  assert.deepEqual(errors, []);
  assert.equal(buildCollision(owners).audit.builtMeshes, 3, 'late buffers were never installed');
});

for (const failure of ['construction', 'runtime', 'message decode']) {
  test(`Worker ${failure} failure falls back to usable synchronous collision and ray queries`, async t => {
    const source = fixture(), worker = mockWorker(), errors = [], error = new Error(`expected ${failure} failure`);
    const geometry = createSceneGeometry(THREE, {...source, worker: () => {
      if (failure === 'construction') throw error;
      return worker;
    }, onError: value => errors.push(value)});
    t.after(() => geometry.dispose());
    const pending = geometry.rebuildCollision('fallback');
    if (failure === 'runtime') worker.onerror(error);
    if (failure === 'message decode') worker.onmessageerror(error);
    const state = await pending;
    assert.equal(state.background, null);
    assert.equal(state.collision.audit.builtMeshes, 3);
    assert.deepEqual(errors, [error]);
    if (failure !== 'construction') assert.equal(worker.stopped, true);
    assertUsable(state, source);
  });
}
