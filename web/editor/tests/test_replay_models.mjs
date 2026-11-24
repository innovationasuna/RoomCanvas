import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {setImmediate} from 'node:timers/promises';
import * as THREE from '../../vendor/build/three.module.js';
import {Player} from '../../replay/player.mjs';

// Use replay.html's import map to exercise RoomView with real Three objects and no WebGL context.
const hooks = registerHooks({resolve(name, context, next) {
  if (name === 'three') return next(new URL('../../vendor/build/three.module.js', import.meta.url).href, context);
  if (name.startsWith('three/addons/')) return next(new URL('../../vendor/examples/jsm/' + name.slice(13), import.meta.url).href, context);
  return next(name, context);
}});
const {RoomView} = await import('../../replay/room-view.mjs');
const {Materializer} = await import('../../replay/materialize.mjs');
const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
const {SmallItemLayer, selectPhotoItems} = await import('../../replay/small-items.mjs');
hooks.deregister();

function view() {
  const scene = new THREE.Scene();
  const forming = Object.assign(Object.create(Materializer.prototype), {
    scene, wire: 0x3fa9d6, dotMap: null, busy: new Set(), clones: new Map(), layers: new WeakMap(), spare: [], active: new Map(),
  });
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 2, 5);
  return Object.assign(Object.create(RoomView.prototype), {
    models: {}, retryAt: {}, retiring: new Set(), wanted: null, current: null, incoming: null, mix: 1, wallFades: [], boxes: {}, scene, forming,
    controls: {target: new THREE.Vector3(), update() {}}, camera, calm: {matches: true}, userHeld: true, speed: 1, time: 1,
    scaffoldReady: true, warm: async () => {}, renderer: {capabilities: {getMaxAnisotropy: () => 1}, render() {}},
  });
}
function group(name, ...parts) {
  const node = new THREE.Group();
  node.name = name;
  for (const part of parts) node.add(part);
  return node;
}
function mesh(name, material = new THREE.MeshStandardMaterial()) {
  return Object.assign(new THREE.Mesh(new THREE.BoxGeometry(), material), {name});
}
function loaded(v, key, ...parts) {
  const root = v.prepare(group(key, ...parts));
  root.visible = false;
  v.scene.add(root);
  v.models[key] = {root};
  return root;
}
function apply(v, model, quiet = false, state = {}, options = {}) {
  v.apply({model, built: new Set(), added: null, ...state}, {quiet, ...options});
}
function tick(v) {
  v.lastTick = performance.now() - 300;
  v.tick();
}
function visible(v) {
  return Object.keys(v.models).filter(key => v.models[key].root?.visible);
}

test('a paused seek emits only the destination and ordinary seeks preserve playback', () => {
  const p = Object.assign(Object.create(Player.prototype), {duration: 10, playing: true, subs: []});
  const frames = [];
  p.subs.push((t, player) => frames.push([t, player.playing]));
  p.seek(8);
  p.seek(3, {pause: true});
  assert.deepEqual(frames, [[8, true], [3, false]]);
});

test('assembly hides the old item even while its support forms, and seeking back restores the mask', () => {
  const v = view(), id = 'TissueBox0';
  const support = group('Table0', mesh('Tabletop'), group(id, mesh('OldBlock')));
  const authored = loaded(v, 'final', support);
  const rebuilt = loaded(v, 'small_objects', group(id, mesh('PhotoMesh')));
  const options = {addedAll: ['Table0']};
  const assembly = {added: new Set(['Table0']), hiddenNodes: [id]};
  const visibleMesh = (root, name) => {
    const visible = [];
    root.traverseVisible(node => visible.push(node.name));
    return visible.includes(name);
  };
  apply(v, 'final', true, assembly, options);
  assert.equal(visibleMesh(authored, 'Tabletop'), true);
  assert.equal(visibleMesh(authored, 'OldBlock'), false);
  v.forming.start(support, {held: true});
  assert.deepEqual(v.forming.active.get(support).meshes.map(node => node.name), ['Tabletop']);
  apply(v, 'small_objects', false, {}, options);
  assert.equal(visibleMesh(rebuilt, 'PhotoMesh'), true);
  assert.equal(visibleMesh(authored, 'OldBlock'), false);
  apply(v, 'final', true, assembly, options);
  assert.equal(visibleMesh(authored, 'OldBlock'), false);
  assert.equal(visibleMesh(rebuilt, 'PhotoMesh'), false);
  // A current-flow run can reuse this same GLB as its real finished room.
  apply(v, 'final', true, {}, options);
  assert.equal(visibleMesh(authored, 'OldBlock'), true);
  apply(v, 'final', true, assembly, options);
  assert.equal(visibleMesh(authored, 'OldBlock'), false);
});

test('masking a support preserves a separate child object through seeks', () => {
  const v = view(), support = mesh('Stand0'), lamp = group('Lamp0', mesh('Bulb'));
  lamp.userData.room_id = 'Lamp0';
  support.position.set(2, 3, 4);
  support.add(lamp, group('StandFoot', mesh('Foot')));
  const root = loaded(v, 'round0', support);
  const position = lamp.getWorldPosition(new THREE.Vector3());
  for (const [hiddenNodes, expected] of [[['Stand0'], ['Bulb']], [[], ['stand', 'Bulb', 'Foot']],
    [['Stand0', 'Lamp0'], []], [['Stand0'], ['Bulb']]]) {
    apply(v, 'round0', true, {hiddenNodes});
    const visible = [];
    root.traverseVisible(node => {if (node.isMesh && !node.userData.mask) visible.push(node === support ? 'stand' : node.name);});
    assert.deepEqual(visible.sort(), expected.sort());
    assert.ok(lamp.getWorldPosition(new THREE.Vector3()).equals(position));
  }
});

for (const action of ['wait', 'seek', 'dispose']) test(`a paused assembly retries a disconnected seed only while waiting: ${action}`, async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  t.mock.method(performance, 'now', () => Date.now());
  const first = Promise.withResolvers();
  const load = t.mock.method(GLTFLoader.prototype, 'loadAsync', () => first.promise);
  const v = view(), options = {modelUrl: key => key, addedAll: []};
  loaded(v, 'round5');
  loaded(v, 'final');
  apply(v, 'round5', true, {modelEvent: {round: 6}}, options);
  apply(v, 'final', true, {added: new Set()}, options);
  first.reject(new Error('offline'));
  await setImmediate();
  load.mock.mockImplementation(async () => ({scene: group('seed')}));
  t.mock.timers.tick(4999);
  assert.equal(load.mock.callCount(), 1);
  assert.equal(v.versionLabel(), '检查第 6 轮');
  if (action === 'seek') apply(v, 'round5', true, {modelEvent: {round: 6}}, options);
  if (action === 'dispose') {
    globalThis.cancelAnimationFrame = () => {};
    t.after(() => {delete globalThis.cancelAnimationFrame;});
    for (const entry of Object.values(v.models)) entry.controller = new AbortController();
    Object.assign(v, {resizeObserver: {disconnect() {}}, scaffoldController: new AbortController(),
      environmentTarget: {dispose() {}}, lights: {}});
    v.renderer.domElement = {remove() {}};
    v.renderer.dispose = v.controls.dispose = v.forming.dispose = () => {};
    await v.dispose();
  }
  const reapply = t.mock.method(v, 'apply');
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(load.mock.callCount(), action === 'wait' ? 2 : 1);
  if (action === 'wait') {
    assert.deepEqual(visible(v), ['final']);
    assert.equal(v.versionLabel(), '组装中的房间 · 按记录推算');
  } else assert.equal(reapply.mock.callCount(), 0);
  if (action === 'seek') assert.equal(v.versionLabel(), '检查第 6 轮');
});

test('seeking back, seeking into a fade, and starting a third fade settle on the requested root', () => {
  const v = view();
  for (const key of ['seed', 'final', 'round0']) loaded(v, key, mesh('object'));
  apply(v, 'seed', true);
  apply(v, 'final');
  tick(v);
  assert.ok(v.mix > 0 && v.mix < 1);
  assert.equal(v.models.final.root.userData.mask[0].visible, true);
  apply(v, 'seed', true);
  tick(v);
  assert.deepEqual([v.current, v.wanted, v.incoming, v.mix], ['seed', 'seed', null, 1]);
  assert.deepEqual(visible(v), ['seed']);
  assert.equal(v.models.final.root.userData.mask[0].visible, false);
  assert.equal(v.models.final.root.userData.fade, 1);

  apply(v, 'final');
  tick(v);
  apply(v, 'round0');
  assert.deepEqual(visible(v), ['final', 'round0']);
  assert.equal(v.models.final.root.userData.mask[0].visible, false);
  tick(v);
  apply(v, 'round0', true);
  assert.deepEqual([v.current, v.wanted, v.incoming, v.mix], ['round0', 'round0', null, 1]);
  assert.deepEqual(visible(v), ['round0']);
  apply(v, 'final');
  apply(v, null, true);
  assert.deepEqual(visible(v), []);
});

test('late GLBs use the latest timeline state and mode, including when the same request becomes animated', async (t) => {
  const v = view(), pending = new Map();
  t.mock.method(GLTFLoader.prototype, 'loadAsync', key => new Promise(resolve => pending.set(key, resolve)));
  const options = {modelUrl: key => key === 'seed' ? null : key, addedAll: ['WaterBottle1', 'TissueBox1']};
  loaded(v, 'round0', mesh('first'));
  apply(v, 'round0', true);
  apply(v, 'final', false, {added: new Set(['WaterBottle1'])}, options);
  apply(v, 'round1', true, {}, options);
  apply(v, 'final', true, {added: new Set(['TissueBox1'])}, options);
  pending.get('final')({scene: group('final', mesh('TissueBox1'), mesh('WaterBottle1'))});
  await setImmediate();
  assert.deepEqual([v.current, v.incoming], ['final', null]);
  const final = v.models.final.root;
  assert.equal(final.getObjectByName('WaterBottle1').visible, false);
  assert.equal(final.getObjectByName('TissueBox1').visible, true);
  pending.get('round1')({scene: group('round1')});
  await setImmediate();
  assert.deepEqual(visible(v), ['final']);

  apply(v, 'round2', true, {}, options);
  apply(v, 'round2', false, {}, options);
  assert.equal(final.getObjectByName('WaterBottle1').visible, false);
  pending.get('round2')({scene: group('round2')});
  await setImmediate();
  assert.deepEqual([v.current, v.incoming], ['final', 'round2']);
  assert.equal(final.getObjectByName('WaterBottle1').visible, false);
  for (let i = 0; i < 9; i++) tick(v);
  assert.deepEqual([v.current, v.incoming], ['round2', null]);
  apply(v, 'final', true, {}, options);
  assert.equal(final.getObjectByName('WaterBottle1').visible, true);
});

test('direct show waits for the active draft and a retired request cannot replace a newer generation', async (t) => {
  const v = view(), reads = [];
  t.mock.method(GLTFLoader.prototype, 'loadAsync', () => new Promise(resolve => reads.push(resolve)));
  const stale = v.show('draft-1', 'https://room.test/draft', true);
  await v.show(null, null, true);
  assert.equal(v.models['draft-1'], undefined);
  const latest = v.show('draft-1', 'https://room.test/draft', true);
  reads[1]({scene: group('new')});
  await latest;
  const old = group('old', mesh('object'));
  reads[0]({scene: old});
  await stale;
  assert.equal(old.parent, null); assert.equal(old.children.length, 0);
  assert.deepEqual([v.current, v.wanted, v.incoming, v.models['draft-1'].root.name], ['draft-1', 'draft-1', null, 'new']);
});

test('a partial seed and an active solid keep their last frame while the next root is pending', () => {
  const v = view();
  const seed = loaded(v, 'seed', mesh('Floor0'), mesh('Table0'), mesh('Chair0'));
  v.models.round0 = {}; // loading
  const options = {modelUrl: key => key === 'seed' ? key : null};
  apply(v, null, true, {shell: true, built: new Set(['Table0'])}, options);
  const table = seed.getObjectByName('Table0'), chair = seed.getObjectByName('Chair0');
  v.forming.start(table, {delay: 2});
  const effect = v.forming.active.get(table);
  apply(v, 'round0', true, {}, options);
  tick(v);
  assert.equal(table.visible, true);
  assert.equal(chair.visible, false);
  assert.equal(effect.t, -2);
  assert.equal(v.forming.active.get(table), effect);
  apply(v, 'seed', true, {}, options);
  assert.equal(chair.visible, true);
  assert.equal(v.forming.active.size, 0);
});

test('matched window and exterior subtrees switch together; only the wall and unmatched geometry fade', () => {
  const v = view();
  function room(key, offset) {
    const frame = group('Window0', mesh('fixed', new THREE.MeshPhysicalMaterial({transmission: 1})),
      group('Window1', mesh('casement', new THREE.MeshPhysicalMaterial({transmission: 1}))));
    const backdrop = group('DaylightBackdrop', mesh('photo'), mesh('backing'));
    backdrop.position.z = -offset; // a replacement plate farther outside the same window
    const wall = group('Wall2', mesh('wall'), frame, backdrop);
    wall.position.z = -2;
    const moved = group('Window9', mesh('moved'));
    moved.position.set(offset, 0, -2);
    return loaded(v, key, wall, moved);
  }
  const a = room('round1', 0), b = room('round2', 3);
  apply(v, 'round1', true);
  for (const cancel of [true, false]) {
    apply(v, 'round2');
    for (let i = 0; i < 7; i++) {
      tick(v);
      for (const part of ['Window0', 'DaylightBackdrop']) {
        assert.equal(a.getObjectByName(part).visible, false);
        assert.equal(b.getObjectByName(part).visible, true);
      }
      for (const name of ['fixed', 'casement', 'photo', 'backing']) {
        const m = b.getObjectByName(name).material;
        assert.equal(m.opacity, 1); assert.equal(m.transparent, false); assert.equal(m.depthWrite, true);
      }
      assert.equal(b.getObjectByName('wall').material.opacity, v.mix);
      assert.equal(b.getObjectByName('moved').material.opacity, v.mix);
    }
    if (cancel) apply(v, 'round1', true); else tick(v);
    assert.deepEqual(visible(v), [cancel ? 'round1' : 'round2']);
    assert.equal(a.getObjectByName('Window0').visible, true);
    assert.equal(a.getObjectByName('DaylightBackdrop').visible, true);
  }
  v.camera.position.z = -5;
  tick(v);
  const photo = b.getObjectByName('photo').material;
  assert.equal(photo.opacity, b.getObjectByName('wall').material.opacity);
  assert.ok(photo.transparent && photo.opacity < 1);
});

test('forming solids omit the depth mask, follow fade state and recover the original offset', () => {
  const v = view(), original = new THREE.MeshStandardMaterial({polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 7});
  const object = mesh('object', original);
  const root = loaded(v, 'room', object, mesh('bottle', new THREE.MeshPhysicalMaterial({transmission: 0.8})));
  root.visible = true;
  assert.equal(root.userData.mask.length, 1);
  const mask = root.userData.mask[0], copy = v.forming.clipped(original, root);
  const baseVersion = original.version, copyVersion = copy.version;
  v.setFade(root, 0.2);
  v.forming.start(object, {held: true, delay: 0.5});
  assert.equal(object.material, copy);
  assert.equal(mask.visible, false);
  assert.equal(copy.transparent, true); assert.equal(copy.depthWrite, false);
  assert.equal(original.version, baseVersion + 1); assert.equal(copy.version, copyVersion + 1);
  v.forming.release();
  for (const dt of [0.5, 1, 1]) {
    v.setFade(root, 0.6);
    v.forming.update(dt);
    assert.equal(mask.visible, false);
    assert.deepEqual([copy.opacity, copy.polygonOffset, copy.polygonOffsetFactor, copy.polygonOffsetUnits], [0.6, true, -1, -4]);
    assert.equal(original.version, baseVersion + 1); assert.equal(copy.version, copyVersion + 1);
  }
  v.forming.update(2);
  assert.equal(object.material, original);
  assert.equal(mask.parent, object); assert.equal(mask.visible, true);
  v.setFade(root, 1);
  assert.equal(mask.visible, false);
  assert.deepEqual([original.polygonOffset, original.polygonOffsetFactor, original.polygonOffsetUnits], [true, 2, 7]);
  v.forming.start(object, {delay: 1});
  assert.deepEqual([copy.transparent, copy.depthWrite, copy.polygonOffsetFactor, copy.polygonOffsetUnits], [false, true, 2, 7]);
  assert.equal(copy.version, copyVersion + 2);
  v.forming.finishAll();
  assert.equal(mask.parent, object); assert.equal(mask.visible, false);
});

test('overlapping reveals restore the surviving layer and the exact base material in either finish order', () => {
  for (const first of ['parent', 'child', 'quiet seek']) {
    const v = view(), materials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
    const child = mesh('Child', materials), parent = group('Parent', child);
    const root = loaded(v, 'final', parent);
    v.calm.matches = false;
    const state = {added: new Set(['Parent', 'Child'])}, options = {addedAll: [...state.added]};
    apply(v, 'final', true, {added: new Set()}, options);
    apply(v, 'final', false, state, options);
    const mask = root.userData.mask[0];
    assert.equal(v.forming.active.size, 2);
    assert.equal(mask.userData.forming, 2);
    if (first !== 'quiet seek') {
      const remaining = first === 'parent' ? child : parent;
      const copies = v.forming.active.get(remaining).swaps[0].clones;
      v.forming.finish(first === 'parent' ? parent : child);
      assert.equal(mask.userData.forming, 1);
      copies.forEach((copy, i) => assert.ok(child.material[i] === copy));
    }
    apply(v, 'final', true, state, options);
    assert.ok(child.material === materials);
    assert.equal(mask.userData.forming, 0);
    assert.equal(v.forming.busy.size, 0);
    assert.equal(v.forming.active.size, 0);
  }
});

test('window handoff preserves delayed and sampled effects through cancellation and ends them on swap', () => {
  for (const delay of [1, 0]) {
    const v = view(), old = mesh('Window0');
    const latch = mesh('Latch');
    old.add(latch);
    loaded(v, 'seed', old);
    loaded(v, 'final', mesh('Window0'));
    apply(v, 'seed', true);
    v.forming.start(old, {delay, held: delay > 0});
    v.forming.start(latch, {delay: 1});
    latch.visible = false; // already removed by the timeline before the handoff
    if (!delay) v.forming.update(0.4);
    const effect = v.forming.active.get(old), time = effect.t, cloud = effect.cloud;
    apply(v, 'final');
    tick(v);
    assert.equal(old.visible, false);
    assert.equal(v.forming.active.has(latch), false);
    assert.ok(v.forming.active.get(old) === effect);
    assert.equal(effect.t, time);
    assert.equal(effect.held, delay > 0);
    if (cloud) assert.equal(cloud.visible, false);
    apply(v, 'pending'); // cancel the handoff, keep the outgoing frame until the replacement loads
    tick(v);
    assert.equal(old.visible, true);
    assert.equal(effect.t, time);
    if (cloud) assert.equal(cloud.visible, true);
    apply(v, 'seed');
    tick(v);
    assert.ok(effect.t > time);
    apply(v, 'final');
    for (let i = 0; i < 8; i++) tick(v);
    assert.equal(v.current, 'final');
    assert.equal(v.forming.active.size, 0);
    if (cloud) assert.equal(cloud.parent, null);
  }
});

test('one matching window on a shared wall only takes over its own backdrop', () => {
  const v = view();
  function room(key, shift) {
    const parts = ['Window0', 'WindowDaylightBackdrop0', 'Window1', 'WindowDaylightBackdrop1'].map(name => mesh(name));
    for (const part of parts) if (part.name.endsWith('1')) part.position.x = 2 + shift;
    const wall = group('Wall0', ...parts);
    wall.position.z = -2;
    return loaded(v, key, wall);
  }
  const old = room('seed', 0), next = room('final', 2);
  apply(v, 'seed', true);
  apply(v, 'final');
  tick(v);
  for (const name of ['Window0', 'WindowDaylightBackdrop0', 'Window1', 'WindowDaylightBackdrop1']) {
    const matched = name.endsWith('0');
    assert.equal(old.getObjectByName(name).visible, !matched, name);
    assert.equal(next.getObjectByName(name).material.opacity, matched ? 1 : v.mix, name);
  }
});

test('window handoff requires substantial overlap along the wall and in height', () => {
  for (const [axis, offset, match] of [['x', 0.99, false], ['z', 0.99, false], ['y', 0.99, false], ['x', 0.05, true]]) {
    const v = view(), old = mesh('Window0'), next = mesh('Window0');
    old.scale[axis === 'z' ? 'x' : 'z'] = 0.02;
    next.scale.copy(old.scale);
    old.position.z = -3;
    next.position.copy(old.position);
    next.position[axis] += offset;
    loaded(v, 'seed', old);
    loaded(v, 'final', next);
    apply(v, 'seed', true);
    apply(v, 'final');
    tick(v);
    assert.equal(old.visible, !match);
    assert.equal(next.material.opacity, match ? 1 : v.mix);
  }
});

test('a handoff requires both windows to be visible in their timeline state', () => {
  for (const [hidden, nested] of [['old', false], ['new', false], ['old', true], ['new', true]]) {
    const v = view(), old = mesh('Window0'), next = mesh('Window0');
    const source = nested ? group('Frame', old) : old, target = nested ? group('Frame', next) : next;
    loaded(v, 'seed', source);
    loaded(v, 'final', target);
    const options = {modelUrl: key => key === 'seed' ? key : null, addedAll: [target.name]};
    apply(v, null, true, {shell: true, built: new Set(hidden === 'old' ? [] : [source.name])}, options);
    apply(v, 'final', false, {added: new Set(hidden === 'new' ? [] : [target.name])}, options);
    assert.equal(v.mix, 0);
    assert.equal(source.visible, hidden !== 'old');
    assert.equal(target.visible, hidden !== 'new');
    if (nested) assert.equal(old.visible, true);
    assert.equal(next.material.opacity, 0);
    tick(v);
    assert.equal(next.material.opacity, v.mix);
  }
});

test('cancelled drafts leave the scene and wall list even when a retired generation loads late', async (t) => {
  const v = view(), reads = [], seed = loaded(v, 'seed', mesh('Floor0'));
  t.mock.method(GLTFLoader.prototype, 'loadAsync', () => new Promise(resolve => reads.push(resolve)));
  apply(v, 'seed', true);
  const options = {modelUrl: key => key.startsWith('draft') ? 'https://room.test/draft' : null};
  for (const key of ['draft-1', 'draft-2', 'draft-3']) {
    apply(v, key, false, {}, options);
    reads.shift()({scene: group(key, mesh('Wall0'))});
    await setImmediate();
    assert.equal(v.incoming, key);
    const root = v.models[key].root;
    assert.ok(v.wallFades.some(w => w.root === root));
    apply(v, 'seed', true);
    await Promise.all(v.retiring);
    assert.deepEqual(Object.keys(v.models), ['seed']);
    assert.ok(v.scene.children.length === 1 && v.scene.children[0] === seed);
    assert.equal(v.wallFades.length, 0);
    assert.equal(root.children.length, 0);
  }

  apply(v, 'draft-4', false, {}, options);
  apply(v, 'seed', true);
  apply(v, 'draft-4', false, {}, options);
  assert.equal(reads.length, 2);
  const [finishOld, finishNew] = reads;
  finishNew({scene: group('new', mesh('Wall0'))});
  await setImmediate();
  const old = group('old', mesh('Wall0'));
  finishOld({scene: old});
  await setImmediate();
  assert.equal(old.children.length, 0);
  assert.equal(old.parent, null);
  assert.equal(v.models['draft-4'].root.name, 'new');
  assert.equal(v.wallFades.length, 1);

  apply(v, 'draft-5', false, {}, options);
  assert.deepEqual(visible(v), ['seed', 'draft-4']);
  apply(v, 'seed', true);
  reads.shift()({scene: group('draft-5')});
  await setImmediate();
  assert.deepEqual(Object.keys(v.models), ['seed']);
  assert.deepEqual(v.scene.children, [seed]);
});

test('overlapping drafts and final load distinct contents from the same room file', async (t) => {
  const v = view(), file = 'https://room.test/replay/files/Room.glb?job=1', reads = [];
  t.mock.method(globalThis, 'fetch', request => new Promise(resolve => {
    reads.push({url: new URL(request.url), finish(name) {
      const json = Buffer.from(JSON.stringify({asset: {version: '2.0'}, scenes: [{name}], scene: 0}));
      const bytes = Buffer.alloc(20 + Math.ceil(json.length / 4) * 4, 0x20);
      bytes.write('glTF');
      [2, bytes.length, bytes.length - 20, 0x4e4f534a].forEach((n, i) => bytes.writeUInt32LE(n, 4 + i * 4));
      json.copy(bytes, 20);
      resolve({status: 200, arrayBuffer: async () => bytes.buffer});
    }});
  }));
  const keys = ['draft1', 'draft2', 'final'];
  const pending = keys.map(key => v.show(key, file, true));
  assert.equal(new Set(reads.map(r => r.url.href)).size, 3);
  for (const {url} of reads) {
    assert.equal(url.pathname, '/replay/files/Room.glb');
    assert.equal(url.searchParams.get('job'), '1');
  }
  for (const i of [2, 0, 1]) {
    reads[i].finish(keys[i]);
    await pending[i];
  }
  assert.deepEqual(Object.keys(v.models), ['final']);
  assert.equal(v.current, 'final');
  assert.equal(v.models.final.root.name, 'final');
});

test('the resource check can load successive drafts from one Blob URL', async t => {
  if (!globalThis.ProgressEvent) {
    globalThis.ProgressEvent = Event;
    t.after(() => {delete globalThis.ProgressEvent;});
  }
  const fixture = {asset: {version: '2.0'}, scenes: [{nodes: [0]}], nodes: [{name: 'Window0'}], scene: 0};
  const url = URL.createObjectURL(new Blob([JSON.stringify(fixture)], {type: 'model/gltf+json'}));
  t.after(() => URL.revokeObjectURL(url));
  const v = view();
  for (const key of ['draft-0', 'draft-1']) {
    await v.show(key, url, true);
    assert.equal(v.current, key);
    assert.ok(v.models[key].root.getObjectByName('Window0'));
  }
});

test('a revealed window and plate skip forming during a switch, including a reveal of their wall', () => {
  for (const renamed of [false, true]) {
    const v = view(), oldPlate = 'DaylightBackdrop', newPlate = renamed ? 'WindowDaylightBackdrop0' : oldPlate;
    const room = plate => group('Wall0', mesh('Window0'), mesh(plate), mesh('trim'));
    const old = loaded(v, 'seed', room(oldPlate)), next = loaded(v, 'final', room(newPlate));
    v.calm.matches = false;
    const addedAll = ['Wall0', 'Window0', newPlate];
    apply(v, 'seed', true);
    apply(v, 'final', false, {added: new Set(addedAll)}, {addedAll});
    tick(v);
    for (const [a, b] of [['Window0', 'Window0'], [oldPlate, newPlate]]) {
      assert.equal(old.getObjectByName(a).visible, renamed);
      const material = next.getObjectByName(b).material;
      assert.equal(material.clippingPlanes, null);
      assert.equal(material.opacity, renamed ? v.mix : 1);
      assert.equal(material.transparent, renamed);
    }
    const effect = v.forming.active.get(next.getObjectByName('Wall0'));
    assert.deepEqual(effect.meshes.map(o => o.name), ['trim']);
    assert.equal(v.forming.active.size, 1);
  }
});

test('moving the backdrop into or out of the window keeps the whole opening on the ordinary fade', () => {
  for (const childFirst of [false, true]) {
    const v = view();
    function room(child) {
      const window = mesh('Window0'), plate = mesh('DaylightBackdrop');
      const wall = group('Wall0', window);
      (child ? window : wall).add(plate);
      return wall;
    }
    const old = loaded(v, 'seed', room(childFirst)), next = loaded(v, 'final', room(!childFirst));
    apply(v, 'seed', true);
    apply(v, 'final');
    tick(v);
    for (const name of ['Window0', 'DaylightBackdrop']) {
      assert.equal(old.getObjectByName(name).visible, true);
      assert.equal(next.getObjectByName(name).material.opacity, v.mix);
    }
  }
});

test('diagonal windows fade even when their world boxes overlap', () => {
  for (const [baked, offset] of [[false, 0.8], [true, 0.8], [false, 0]]) {
    const v = view();
    function window(offset) {
      const pane = mesh('pane');
      pane.geometry.scale(2, 1, 0.04);
      const frame = group('Window0', pane);
      if (baked) pane.geometry.rotateY(Math.PI / 4);
      else frame.rotation.y = Math.PI / 4;
      frame.position.set(offset * Math.SQRT1_2, 0, -2 + offset * Math.SQRT1_2);
      return frame;
    }
    const old = window(0), next = window(offset);
    assert.ok(new THREE.Box3().setFromObject(old).intersectsBox(new THREE.Box3().setFromObject(next)));
    loaded(v, 'seed', old);
    loaded(v, 'final', next);
    apply(v, 'seed', true);
    apply(v, 'final');
    tick(v);
    assert.equal(old.visible, true);
    assert.equal(next.children[0].material.opacity, v.mix);
  }
});

test('ambiguous backdrops keep all candidate windows and plates on the ordinary fade', () => {
  for (const layout of ['shared plate', 'extra plate', 'numbered and shared', 'unknown parent']) {
    const v = view();
    function room() {
      const window = mesh('Window0'), plate = mesh('DaylightBackdrop');
      const wall = group('Wall0', window);
      if (layout === 'unknown parent') wall.add(group('Exterior', plate));
      else wall.add(plate);
      if (layout === 'shared plate') wall.add(mesh('Window1'));
      if (layout === 'extra plate') wall.add(mesh('WindowDaylightBackdrop0'));
      if (layout === 'numbered and shared') wall.add(mesh('Window1'), mesh('WindowDaylightBackdrop0'), mesh('WindowDaylightBackdrop1'));
      return wall;
    }
    const old = loaded(v, 'seed', room()), next = loaded(v, 'final', room());
    apply(v, 'seed', true);
    apply(v, 'final');
    tick(v);
    old.traverse(o => {
      if (!o.isMesh) return;
      assert.equal(o.visible, true, o.name);
      assert.equal(next.getObjectByName(o.name).material.opacity, v.mix, o.name);
    });
  }
});

test('a nested plate switches with its window only on the same named wall path', () => {
  for (const moved of [false, true]) {
    const v = view();
    const room = () => group('Wall0', group('Window0', mesh('pane'), mesh('DaylightBackdrop')));
    const old = loaded(v, 'seed', room()), wall = room();
    const next = loaded(v, 'final', moved ? group('Frame', wall) : wall);
    apply(v, 'seed', true);
    apply(v, 'final');
    tick(v);
    assert.equal(old.getObjectByName('Window0').visible, moved);
    for (const name of ['pane', 'DaylightBackdrop']) assert.equal(next.getObjectByName(name).material.opacity, moved ? v.mix : 1);
  }
});

test('the first visible room stays on screen while the next model loads', async t => {
  for (const [first, next, wait] of [['seed', 'final', 1], ['draft1', 'draft2', 9]]) {
    const v = view(), pending = new Map();
    const loader = t.mock.method(GLTFLoader.prototype, 'loadAsync', url => new Promise(resolve => pending.set(new URL(url).pathname, resolve)));
    v.wallLines = group('layout');
    v.points = {material: {userData: {reveal: {}}}};
    const state = {pointsFade: 1, walls: 1};
    const options = {modelUrl: key => [first, next].includes(key) ? 'https://room.test/' + key : null};
    apply(v, first, false, state, options);
    const finish = key => pending.get('/' + key)({scene: group(key, mesh('floor'))});
    finish(first);
    await setImmediate();
    tick(v); tick(v);
    assert.ok(v.mix > 0 && v.mix < 1);
    assert.equal(v.current, null);
    apply(v, next, false, state, options);
    for (let i = 0; i < wait; i++) {
      tick(v);
      assert.deepEqual(visible(v), [first]);
      assert.ok(v.models[first].root.getObjectByName('floor').material.opacity > 0);
      assert.equal(v.wallLines.visible, false);
      assert.equal(v.points.visible, false);
    }
    finish(next);
    await setImmediate();
    assert.equal(v.current, first);
    assert.equal(v.incoming, next);
    assert.deepEqual(visible(v), [first, next]);
    for (let i = 0; i < 8; i++) tick(v);
    assert.deepEqual(visible(v), [next]);
    if (first.startsWith('draft')) assert.equal(v.models[first], undefined);
    loader.mock.restore();
  }
});

test('forward playback keeps the fading room over its base while the third room loads', async t => {
  let finish;
  t.mock.method(GLTFLoader.prototype, 'loadAsync', () => new Promise(resolve => {finish = resolve;}));
  for (const finishFadeFirst of [false, true]) {
    const v = view(), bench = mesh('bench');
    loaded(v, 'round0', mesh('floor'));
    loaded(v, 'round1', bench);
    apply(v, 'round0', true);
    apply(v, 'round1');
    for (let i = 0; i < 7; i++) tick(v);
    assert.equal(bench.material.opacity, 0.875);
    v.physical(true);
    const lighting = t.mock.method(v, 'enablePhysical', () => {});
    apply(v, 'round2', false, {}, {modelUrl: key => key === 'round2' ? key : null});
    assert.deepEqual(visible(v), ['round0', 'round1']);
    assert.equal(bench.material.opacity, 0.875);
    if (finishFadeFirst) {
      tick(v);
      assert.deepEqual(visible(v), ['round1']);
      assert.equal(bench.material.opacity, 1);
    }
    assert.equal(lighting.mock.callCount(), 0);
    finish({scene: group('round2', mesh('floor'))});
    await setImmediate();
    assert.deepEqual([v.current, v.incoming], ['round1', 'round2']);
    assert.deepEqual(visible(v), ['round1', 'round2']);
    for (let i = 0; i < 8; i++) tick(v);
    assert.deepEqual(visible(v), ['round2']);
    assert.deepEqual(lighting.mock.calls.map(call => call.arguments[0]), [v.models.round2.root]);
  }
});

test('pausing while the third room loads keeps the bench visible until that room is ready', async t => {
  let finish;
  t.mock.method(GLTFLoader.prototype, 'loadAsync', () => new Promise(resolve => {finish = resolve;}));
  const v = view(), bench = mesh('bench');
  loaded(v, 'round0', mesh('floor'));
  loaded(v, 'round1', bench);
  apply(v, 'round0', true);
  apply(v, 'round1');
  for (let i = 0; i < 7; i++) tick(v);
  const options = {modelUrl: key => key === 'round2' ? key : null};
  apply(v, 'round2', false, {}, options);
  assert.deepEqual(visible(v), ['round0', 'round1']);
  assert.equal(bench.material.opacity, 0.875);

  v.paused = true;
  apply(v, 'round2', true, {}, options);
  tick(v);
  assert.deepEqual(visible(v), ['round0', 'round1']);
  assert.equal(bench.visible, true);
  assert.equal(bench.material.opacity, 0.875);
  finish({scene: group('round2', mesh('bench'))});
  await setImmediate();
  assert.deepEqual(visible(v), ['round2']);
  assert.equal(v.models.round2.root.getObjectByName('bench').material.opacity, 1);
});

test('returning to a cached final keeps the book added by the fading round visible on the first frame', () => {
  const v = view(), book = mesh('ShelfC1R0A_Book07'), finalBook = mesh(book.name);
  loaded(v, 'round5', mesh('floor'));
  loaded(v, 'round6', book);
  loaded(v, 'final', finalBook);
  apply(v, 'final', true);
  apply(v, 'round5', true);
  apply(v, 'round6');
  for (let i = 0; i < 7; i++) tick(v);
  assert.equal(book.material.opacity, 0.875);

  apply(v, 'final');
  assert.deepEqual(visible(v), ['round6', 'final']);
  assert.equal(book.visible, true);
  assert.equal(book.material.opacity, 1);
  assert.equal(finalBook.material.opacity, 0);
  for (let i = 0; i < 8; i++) tick(v);
  assert.deepEqual(visible(v), ['final']);
  assert.equal(finalBook.material.opacity, 1);
});

test('a picture stays in front of its board while the model fades in, and in its depth mask', () => {
  const v = view();
  const textured = () => new THREE.MeshStandardMaterial({map: new THREE.Texture()});
  const photo = Object.assign(new THREE.Mesh(new THREE.BoxGeometry(.6, .8, .0003), textured()), {name: 'poster'});
  const board = Object.assign(new THREE.Mesh(new THREE.BoxGeometry(.62, .82, .012), textured()), {name: 'board'});
  const root = loaded(v, 'room', photo, board);
  const offsets = (m) => [m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits];
  const maskOf = (o) => root.userData.mask.find((m) => m.parent === o).material;
  v.setFade(root, 0.5);
  assert.deepEqual(offsets(photo.material), [true, -2, -8]);
  assert.deepEqual(offsets(board.material), [true, -1, -4]);
  assert.deepEqual([offsets(maskOf(photo)), offsets(maskOf(board))], [[true, -2, -8], [true, -1, -4]]);
  v.setFade(root, 1);
  assert.deepEqual([offsets(photo.material), offsets(board.material)], [[true, -1, -4], [false, 0, 0]]);
});

test('a picture with a plain slot gets a depth mask per slot', () => {
  const v = view();
  const geometry = new THREE.BoxGeometry(.6, .8, .0003); geometry.addGroup(0, 6, 0); geometry.addGroup(6, 30, 1);
  const sheet = Object.assign(new THREE.Mesh(geometry, [new THREE.MeshStandardMaterial({map: new THREE.Texture()}),
    new THREE.MeshStandardMaterial()]), {name: 'sheet'});
  const root = loaded(v, 'room', sheet);
  const masks = root.userData.mask.find((m) => m.parent === sheet).material;
  assert.deepEqual(masks.map((m) => [m.polygonOffsetFactor, m.polygonOffsetUnits]), [[-2, -8], [-1, -4]]);
});

test('standalone photo nodes keep their world transform, follow a moved marker and never bring its furniture', async t => {
  const json = {scenes: [{nodes: [0]}], nodes: [
    {name: 'Table0', mesh: 0, translation: [4, 0, 0], children: [1, 2, 3]},
    {name: 'Cup0', mesh: 1, children: [4]}, {name: 'Lamp0', mesh: 2}, {name: 'Cup1', mesh: 1},
    {name: 'Storage0', mesh: 3, extras: {room_id: 'Storage0'}},
  ]};
  const ids = ['Cup0', 'Cup1'];
  selectPhotoItems(json, ids);
  assert.deepEqual(json.nodes[0].children, [1, 3]);
  assert.equal(json.nodes[0].mesh, undefined);
  assert.deepEqual(json.nodes[1].children, []);

  const photo = mesh('Photo'), cup = group('Cup0', photo), nextCup = group('Cup1', mesh('Second'));
  const lateTable = group('Table0', cup, nextCup);
  lateTable.position.set(4, 1, 0);
  lateTable.rotation.y = 0.5;
  cup.scale.set(1, 2, 1);
  lateTable.updateMatrixWorld(true);
  const world = cup.matrixWorld.clone();
  const layer = new SmallItemLayer(group('donor', lateTable), ids);
  assert.deepEqual(layer.root.children.map(p => p.name).sort(), ids);

  const v = view(), photoItems = {model: 'small_objects', ids}, state = {photoItems, photoShow: 'stand-ins'};
  t.mock.method(v, 'loadPhotoItems', () => {});
  v.photoSource = {source: photoItems, layer};
  v.scene.add(layer.root);
  const old = mesh('Block'), marker = group('Cup0', old), table = group('Table0', marker);
  table.position.copy(lateTable.position);
  marker.scale.copy(cup.scale);
  loaded(v, 'seed', table);
  apply(v, 'seed', true, state);
  assert.equal(old.visible, false);
  assert.equal(cup.visible, true);
  assert.ok(cup.matrix.equals(world));
  assert.equal(nextCup.visible, false);
  const revised = group('Table0', group('Cup0', mesh('Block')), group('Cup1', mesh('Block')));
  revised.position.set(7, 1, 0);
  loaded(v, 'draft-1', revised);
  v.models['draft-1'].controller = new AbortController();
  apply(v, 'draft-1', true, state);
  assert.equal(nextCup.visible, true);
  assert.equal(cup.matrix.elements[12], 7);
  assert.equal(revised.position.x, 7);
  apply(v, 'seed', true, state);
  assert.ok(cup.matrix.equals(world));
  assert.equal(nextCup.visible, false);
  apply(v, 'seed', true, {photoItems, hiddenNodes: ids});
  assert.equal(layer.root.visible, false);
  assert.equal(old.visible, false);
  assert.equal(v.photoSource.layer, layer);
});

// A photo layer of boxes (1 m, bottom centre 0.5 m below the node), already placed as the source GLB has them.
function photoLayer(v, ids, ...parts) {
  const layer = new SmallItemLayer(group('donor', ...parts), ids);
  v.photoSource = {source: {ids}, layer};
  v.scene.add(layer.root);
  return layer;
}
const at = (x, node) => {node.position.x = x; return node;};

test('from their card the photo items stand where a version has no stand-in, unshifted', () => {
  const v = view(), ids = ['Cup0', 'Bottle0'];
  const cup = at(1, group('Cup0', mesh('PhotoCup'))), bottle = at(3, group('Bottle0', mesh('PhotoBottle')));
  bottle.position.y = 2;
  const layer = photoLayer(v, ids, cup, bottle), bottleWorld = bottle.matrix.clone();
  const block = mesh('Block'), photoItems = {ids};
  loaded(v, 'round0', at(1.5, group('Cup0', block)));
  apply(v, 'round0', true, {photoItems, photoShow: 'stand-ins'});
  assert.deepEqual([block.visible, cup.visible, bottle.visible], [false, true, false]);
  assert.equal(cup.matrix.elements[12], 1.5);
  apply(v, 'round0', true, {photoItems, photoShow: 'all'});
  assert.deepEqual([cup.visible, bottle.visible], [true, true]);
  assert.ok(bottle.matrix.equals(bottleWorld));
  apply(v, 'round0', true, {photoItems, photoShow: null, hiddenNodes: ['Cup0']});
  assert.equal(layer.root.visible, false);
});

test('an openable-parts room cut from the photo room keeps its renamed, re-localised split meshes', () => {
  const v = view(), ids = ['Cup0'], photoItems = {ids};
  const cup = group('Cup0', mesh('geometry_0'));
  const layer = photoLayer(v, ids, cup);
  // Articulation renames what it cuts off and writes its vertices around the joint.
  const flap = mesh('Cup0_Flap_1');
  flap.geometry.translate(-0.4, 0, 0);
  flap.position.x = 0.4;
  const body = mesh('Cup0_Body');
  loaded(v, 'articulated', group('Cup0', body, group('Cup0_Hinges', flap)));
  // The timeline knows it holds the photo models (see test_replay_passes), so nothing is overlaid.
  apply(v, 'articulated', true, {photoItems, photoShow: null});
  assert.deepEqual([body.visible, flap.visible, layer.root.visible], [true, true, false]);
  assert.equal(v.models.articulated.root.userData.photoSlots, null);
});

test('a separate child without extras is neither cut into the photo item nor masked with its stand-in', () => {
  const json = () => ({scenes: [{nodes: [0]}], nodes: [{name: 'Book0', mesh: 0, children: [1]}, {name: 'Bookmark0', mesh: 1}]});
  const unbounded = json(), bounded = json(), objects = new Set(['Book0', 'Bookmark0']);
  selectPhotoItems(unbounded, ['Book0']);
  selectPhotoItems(bounded, ['Book0'], objects);
  assert.deepEqual([unbounded.nodes[0].children, bounded.nodes[0].children], [[1], []]);

  const v = view(), ids = ['Book0'], photoItems = {ids, objects};
  const book = group('Book0', mesh('PhotoBook'));
  photoLayer(v, ids, book);
  const world = book.matrix.clone();
  const old = mesh('OldBook'), mark = at(5, mesh('Bookmark0'));
  old.add(mark);
  loaded(v, 'round0', group('Book0', old));
  apply(v, 'round0', true, {photoItems, photoShow: 'all'});
  assert.deepEqual([old.visible, mark.visible, book.visible], [false, true, true]);
  assert.ok(book.matrix.equals(world));  // the bookmark's mesh is not part of the anchor
});

test('a merged item is anchored on its whole group, also when a member leaves or returns on rewind', () => {
  const v = view(), ids = ['Book0'], photoItems = {ids, members: {Book0: ['Book0', 'Book1']}};
  // Generation fitted the photo model to the offset stack: its centre is between the two books.
  const book = at(0.045, group('Book0', mesh('PhotoStack')));
  photoLayer(v, ids, book);
  const world = book.matrix.clone();
  const first = mesh('First'), second = mesh('Second'), member = at(0.09, group('Book1', second));
  loaded(v, 'round0', group('Book0', first), member);
  const state = {photoItems, photoShow: 'all', hiddenNodes: ['Book0', 'Book1']};
  apply(v, 'round0', true, state);
  assert.deepEqual([first.visible, second.visible, book.visible], [false, false, true]);
  assert.ok(book.matrix.equals(world));
  member.visible = false;  // this version's state does not show the second book
  apply(v, 'round0', true, state);
  assert.ok(Math.abs(book.matrix.elements[12]) < 1e-9);
  member.visible = true;
  apply(v, 'round0', true, state);
  assert.ok(book.matrix.equals(world));
});

test('the photo layer keeps the outgoing placement until the incoming room is the one shown', () => {
  const v = view(), ids = ['Cup0'], photoItems = {ids}, state = {photoItems, photoShow: 'all'};
  const cup = group('Cup0', mesh('Photo'));
  const layer = photoLayer(v, ids, cup);
  for (const [k, x] of [['round0', 0], ['round1', 1], ['round2', 2], ['final', 3]]) loaded(v, k, at(x, group('Cup0', mesh('Block'))));
  loaded(v, 'articulated', group('Cup0', mesh('OwnPhoto')));
  const x = () => cup.matrix.elements[12];
  apply(v, 'round0', true, state);
  // Playback: the next round fades in over the current one.
  apply(v, 'round1', false, state);
  assert.deepEqual([v.current, v.incoming, x()], ['round0', 'round1', 0]);
  while (v.incoming) {tick(v); apply(v, 'round1', false, state);}
  assert.deepEqual([v.current, x()], ['round1', 1]);
  // A live update replaces the target while it fades: the room taking over brings its placement.
  apply(v, 'round2', false, state);
  tick(v);
  apply(v, 'final', false, state);
  assert.deepEqual([v.current, v.incoming, x()], ['round2', 'final', 2]);
  // Rewinding mid-fade shows the destination at once.
  apply(v, 'round0', true, state);
  assert.deepEqual([v.current, v.incoming, x(), layer.root.visible], ['round0', null, 0, true]);
  // A room holding its own photo models takes the layer away only once it is shown.
  apply(v, 'final', true, state);
  apply(v, 'articulated', false, {photoItems, photoShow: null});
  assert.deepEqual([v.incoming, layer.root.visible, cup.visible, x()], ['articulated', true, true, 3]);
  while (v.incoming) {tick(v); apply(v, 'articulated', false, {photoItems, photoShow: null});}
  assert.equal(layer.root.visible, false);
});

test('a withdrawn photo source cancels its download and frees what was parsed', async t => {
  const bin = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const text = JSON.stringify({asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0]}], nodes: [{name: 'Cup0', mesh: 0}],
    meshes: [{primitives: [{attributes: {POSITION: 0}}]}], bufferViews: [{buffer: 0, byteLength: 36}], buffers: [{byteLength: 36}],
    accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0]}]});
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4));
  const chunk = (type, data) => Buffer.concat([Buffer.from(new Uint32Array([data.length, type]).buffer), data]);
  const body = Buffer.concat([chunk(0x4E4F534A, json), chunk(0x004E4942, bin)]);
  const glb = Buffer.concat([Buffer.from(new Uint32Array([0x46546C67, 2, 12 + body.length]).buffer), body]);
  const reply = Promise.withResolvers();
  // A late reply arrives whether or not the request was aborted.
  const requests = t.mock.method(globalThis, 'fetch', () => reply.promise);
  const disposed = t.mock.method(THREE.BufferGeometry.prototype, 'dispose');
  const v = view(), photoItems = {model: 'small_objects', ids: ['Cup0']};
  const options = {modelUrl: key => key === 'small_objects' ? 'http://room.test/so.glb' : null};
  loaded(v, 'round0', group('Cup0', mesh('Block')));
  const children = v.scene.children.length;
  apply(v, 'round0', true, {photoItems, photoShow: 'all'}, options);
  const {signal} = requests.mock.calls[0].arguments[1];
  apply(v, 'round0', true, {photoItems, photoShow: null}, options);  // an ordinary rewind keeps it
  assert.deepEqual([signal.aborted, requests.mock.callCount()], [false, 1]);
  apply(v, 'round0', true, {photoItems: null}, options);
  assert.deepEqual([signal.aborted, v.photoSource, v.photoRetry], [true, null, null]);
  const before = disposed.mock.callCount();
  reply.resolve(new Response(glb));
  for (let i = 0; i < 50 && disposed.mock.callCount() === before; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(disposed.mock.callCount() > before);
  assert.equal(v.scene.children.length, children);
  assert.equal(v.photoSource, null);
});
