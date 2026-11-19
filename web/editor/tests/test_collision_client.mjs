import test from 'node:test';
import assert from 'node:assert/strict';
import {createCollisionClient} from '../collision-client.mjs';
import {buildCollision} from '../collision.mjs';

test('incremental Worker generations settle superseded work and ignore late replies', async () => {
  const sent = [], worker = {postMessage: (data, transfer) => sent.push({data, transfer}), terminate() {this.stopped = true;}};
  const client = createCollisionClient(worker, () => {}), owner = {id: 'chair', origin: [0, 0, 0], meshes: [{name: 'body', triangles: [[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]}]};
  client.update([owner]);
  assert.equal(sent[0].data.type, 'build');
  assert.equal(sent[0].transfer.length, 2);
  worker.onmessage({data: {type: 'built', generation: 1}});
  const old = client.request({}, ['chair'], {});
  const waiting = client.request({}, ['chair'], {});
  const latest = client.request({}, ['chair'], {});
  assert.equal(await waiting, null);
  client.update([owner]);
  assert.equal(await old, null);
  assert.equal(await latest, null);
  assert.deepEqual(sent.at(-1).data.owners, []);
  assert.deepEqual(sent.at(-1).transfer, []);
  const pending = client.request({}, ['chair'], {});
  worker.onmessage({data: {type: 'built', generation: 1}});
  assert.equal(client.ready, false);
  worker.onmessage({data: {type: 'built', generation: 2}});
  const current = sent.at(-1).data;
  worker.onmessage({data: {type: 'drop', generation: 1, ticket: current.ticket, contact: {ok: true}}});
  worker.onmessage({data: {type: 'drop', generation: 2, ticket: current.ticket - 1, contact: {ok: true}}});
  worker.onmessage({data: {type: 'drop', generation: 2, ticket: current.ticket, contact: {ok: false}}});
  assert.equal((await pending).contact.ok, false);
  client.update([]);
  assert.deepEqual(sent.at(-1).data.removed, ['chair']);
  const failed = client.request({}, [], {});
  worker.onerror(new Error('worker stopped'));
  assert.equal(client.failed, true);
  assert.equal(await failed, null);
  client.dispose();
  assert.equal(worker.stopped, true);
});

test('the worker checks obstacles in the page\'s order, so both name the same one', async () => {
  const box = (x0, x1) => {
    const p = [[x0, 0, -.3], [x1, 0, -.3], [x1, .5, -.3], [x0, .5, -.3], [x0, 0, .3], [x1, 0, .3], [x1, .5, .3], [x0, .5, .3]];
    return [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[0,3,7],[0,7,4],[1,5,6],[1,6,2]].map((face) => face.map((i) => p[i]));
  };
  const owner = (id, triangles) => ({id, name: id, origin: [0, 0, 0], meshes: [{name: id, triangles}]});
  const chair = owner('chair', box(-1.1, -.9)), wall = owner('room:Wall0', box(-.4, -.05)), imported = {...owner('added-1', box(.05, .4)), added: true};
  // The page lists pieces (an import among them) before the room's fixed parts; the worker
  // receives the import last, as the only changed owner.
  const worker = {postMessage: (data) => queueMicrotask(() => globalThis.self.onmessage({data})), terminate() {}};
  globalThis.self = {postMessage: (data) => worker.onmessage({data})};
  await import('../collision-worker.mjs');
  const client = createCollisionClient(worker, () => {});
  client.update([chair, wall]);
  client.update([chair, imported, wall]);
  // Moved to meet both, which the page meets first.
  const layout = {chair: {x: 1, y: 0, z: 0, yaw: 0}, 'added-1': {x: 0, y: 0, z: 0, yaw: 0}};
  const reply = await client.request(layout, ['chair'], layout);
  const page = buildCollision([chair, imported, wall], {keepAuthoredOverlaps: true}).checkPlacement(layout, ['chair']);
  assert.equal(page.other.id, 'added-1');
  assert.deepEqual(reply.contact, {ok: page.ok, other: page.other});
});
