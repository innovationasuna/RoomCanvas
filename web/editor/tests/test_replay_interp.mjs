import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import * as THREE from '../../vendor/build/three.module.js';

registerHooks({resolve(id, context, next) {
  if (id === 'three') return next(new URL('../../vendor/build/three.module.js', import.meta.url).href, context);
  if (id.startsWith('three/addons/')) return next(new URL('../../vendor/examples/jsm/' + id.slice(13), import.meta.url).href, context);
  return next(id, context);
}});
const {RoomView} = await import('../../replay/room-view.mjs');
const {buildTimeline, sceneAt, readReplay} = await import('../../replay/timeline.mjs');
const group = (name, ...children) => {
  const node = new THREE.Group();
  node.name = name;
  children.forEach(child => node.add(child));
  return node;
};
const viewOf = models => Object.assign(Object.create(RoomView.prototype), {
  models, retryAt: {}, wallFades: [], objectIds: new Set(), current: 'seed', wanted: 'seed', boxes: {}, palette: {built: 0},
  forming: {active: new Map(), finishAll() {this.active.clear();}, finishModel(root) {root.traverse(o => this.active.delete(o));}},
  calm: {matches: true},
});
const applyFinal = (view, added, quiet) => view.apply({model: 'final', added, built: new Set()},
  {...view.lastOptions, quiet});
const scanBox = () => ({userData: {edges: {material: {color: new THREE.Color()}}, base: new THREE.Color()}});

test('a chair event replaces just its member boxes, including after a backward seek', () => {
  const seed = group('seed', ...['Chair4', 'Chair1', 'Chair0', 'Floor0'].map(name => group(name)));
  const view = viewOf({seed: {root: seed}});
  view.chairClusters = {ChairCluster0: ['Chair0', 'Chair4', 'Chair8'], ChairCluster1: ['Chair1']};
  for (const id of ['Chair4', 'Chair1', 'Chair0', 'Chair8']) {
    view.boxes[id] = scanBox();
  }
  const apply = (...ids) => view.apply({shell: true, model: null, built: new Set(ids), boxes: true},
    {quiet: true, modelUrl: k => k === 'seed' && 'seed.glb'});
  const boxes = () => Object.keys(view.boxes).filter(id => view.boxes[id].visible).sort();
  apply('ChairCluster0');
  assert.deepEqual(boxes(), ['Chair1', 'Chair8']); // no mesh was placed for Chair8
  assert.deepEqual(seed.children.filter(o => o.visible).map(o => o.name), ['Chair4', 'Chair0', 'Floor0']);
  const effect = {held: true, t: -0.25};
  view.forming.active.set(seed.getObjectByName('Chair4'), effect);
  view.updateChairBoxes();
  assert.deepEqual(boxes(), ['Chair1', 'Chair4', 'Chair8']);
  Object.assign(effect, {held: false, t: 0.1});
  view.updateChairBoxes();
  assert.deepEqual(boxes(), ['Chair1', 'Chair8']);
  apply('ChairCluster0', 'ChairCluster1');
  assert.deepEqual(boxes(), ['Chair8']);
  apply('ChairCluster1');
  assert.deepEqual(boxes(), ['Chair0', 'Chair4', 'Chair8']);
});

test('an older cache uses shared seed assets and leaves ambiguous groups boxed', () => {
  const a = new THREE.BoxGeometry(), b = new THREE.BoxGeometry();
  const material = () => new THREE.MeshBasicMaterial({map: new THREE.Texture()});
  const blue = material(), yellow = material();
  const chair = (id, g, m) => group(id, new THREE.Mesh(g, m));
  const root = group('seed', chair('Chair10', a, blue), chair('Chair1', b, yellow), chair('Chair0', a, blue));
  const view = viewOf({seed: {root}});
  view.objectIds = new Set(['ChairCluster0', 'ChairCluster1']);
  const shown = () => [...view.revealed(true, new Set(['ChairCluster0'])).shown].sort();
  assert.deepEqual(shown(), []); // the scan is still loading
  view.scanChairs = new Set(['Chair0', 'Chair1', 'Chair10']);
  assert.deepEqual(shown(), ['Chair0', 'Chair10', 'ChairCluster0']);
  view.objectIds = new Set(['ChairCluster0', 'ChairCluster1', 'ChairCluster2']);
  assert.deepEqual(shown(), []);
  view.objectIds = new Set(['ChairCluster0', 'ChairCluster1']);
  root.remove(root.getObjectByName('Chair0'));
  assert.deepEqual(shown(), []); // two assets and two clusters, but the lowest chair was dropped
  root.getObjectByName('Chair10').userData.source_glb = 'ChairCluster0.glb';
  root.getObjectByName('Chair1').userData.source_glb = 'ChairCluster1.glb';
  view.objectIds = new Set(view.objectIds);
  assert.deepEqual(shown(), ['Chair10', 'ChairCluster0']);
});

test('a Blender suffix identifies the same loaded node for the reveal and camera after a rewind', async () => {
  const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
  const name = 'CubbieUprightBook.001';
  const {scene: root} = await new GLTFLoader().parseAsync(JSON.stringify({
    asset: {version: '2.0'}, scenes: [{nodes: [0, 1]}],
    nodes: [{name: 'CubbieUprightBook001'}, {name, translation: [4, 0, 0]}],
  }), '');
  const [other, book] = root.children;
  assert.equal(book.userData.name, name);
  assert.notEqual(book.name, name);
  book.add(new THREE.Mesh(new THREE.BoxGeometry()));
  const view = viewOf({final: {root}});
  view.current = 'final';
  view.lastOptions = {addedAll: [name]};
  let forming;
  view.materialize = nodes => {forming = nodes;};
  for (const show of [false, true, false]) {
    forming = [];
    applyFinal(view, new Set(show ? [name] : []), !show);
    assert.equal(book.visible, show);
    assert.ok(other.visible);
    assert.deepEqual(forming, show ? [book] : []);
    assert.equal(view.boundsOf(name).getCenter(new THREE.Vector3()).x, 4);
  }
});

test('opening events keep their assembled numbers across walls and missing records', () => {
  const events = ['Wall1_Door_1', 'Wall2_Door_4', 'Wall9_Door_3', 'Wall14_Door_0', 'Wall7_Window_3', 'Wall8_Opening_2'];
  const names = ['Door1', 'Door4', 'Door3', 'Door0', 'Window3', 'Opening2'];
  const root = group('seed', ...[...names, 'Door2', 'Window0'].map(name => group(name)));
  const view = viewOf({seed: {root}});
  for (const [i, id] of events.entries()) {
    const {shown} = view.revealed(true, new Set([id]));
    assert.deepEqual([...shown], [id, names[i]]);
    assert.deepEqual(root.children.filter(o => o.visible).map(o => o.name), [names[i]]);
  }
});

test('moved seed objects stay visible while only the new supports form and rewind', () => {
  const tv = group('Television0'), cabinet = group('Storage0'), rail = group('Rail'), caster = group('Caster');
  const root = group('final', group('Floor0', group('Trolley', group('Stand', tv), caster)),
    group('Wall3', group('Mount', cabinet, rail)));
  const view = viewOf({final: {root}});
  view.objectIds = new Set(['Television0', 'Storage0']);
  view.lastOptions = {addedAll: ['Mount', 'Trolley']};
  view.current = 'final';
  let forming;
  view.materialize = nodes => {forming = nodes;};
  for (const withSeed of [false, true]) {
    if (withSeed) view.models.seed = {root: group('seed', group('Storage0', group('Television0')))};
    applyFinal(view, new Set(), true);
    for (const item of [tv, cabinet]) for (let o = item; o; o = o.parent) assert.ok(o.visible, o.name);
    assert.deepEqual([rail.visible, caster.visible], [false, false]);
    applyFinal(view, new Set(['Trolley']), false);
    assert.deepEqual(forming, [caster]);
    assert.deepEqual([rail.visible, caster.visible], [false, true]);
    applyFinal(view, null, true);
    assert.deepEqual([rail.visible, caster.visible], [true, true]);
    applyFinal(view, new Set(), true);
    assert.deepEqual([rail.visible, caster.visible], [false, false]);
  }
});

test('the version label follows visible models through loads, fades and interpolated frames', () => {
  const view = viewOf(Object.fromEntries(['seed', 'final', 'round2', 'draft42', 'small_objects', 'articulated']
    .map(key => [key, {root: group(key)}])));
  view.revealed(true, new Set());
  view.wanted = 'round2';
  assert.equal(view.versionLabel(), '第一版房间 · 按记录推算');
  view.revealed(false, new Set());
  view.incoming = 'round2';
  assert.equal(view.versionLabel(), '第一版房间 → 检查时的房间');
  view.incoming = null;
  view.current = 'final';
  view.lastOptions = {addedAll: []};
  applyFinal(view, new Set(), true);
  assert.equal(view.versionLabel(), '组装中的房间 · 按记录推算');
  applyFinal(view, null, true);
  assert.equal(view.versionLabel(), '最终房间');
  for (const [key, label] of [['draft42', '搭建中的房间'], ['small_objects', '小物品重建后'], ['articulated', '开合处理后'], [null, '']]) {
    view.current = key;
    assert.equal(view.versionLabel(), label);
  }
});

test('a mesh support forms on schedule without moving or hiding its old items', () => {
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  shelf.name = 'Shelf';
  shelf.position.set(2, 3, 4); shelf.rotation.y = 0.7; shelf.scale.set(1, 2, 3);
  const chair = group('Chair4'), door = group('Door4'), window = group('Window3');
  const tv = group('Television0'), mask = new THREE.Mesh(shelf.geometry);
  mask.userData.mask = true; mask.visible = false;
  shelf.add(chair, door, window, tv, mask);
  chair.position.set(1, 0, -2);
  const root = group('final', shelf), view = viewOf({final: {root}});
  const before = chair.getWorldPosition(new THREE.Vector3());
  view.current = 'final';
  view.objectIds = new Set(['ChairCluster0', 'Wall2_Door_4', 'Wall3_Window_3', 'Television0']);
  view.chairClusters = {ChairCluster0: ['Chair4']};
  view.lastOptions = {addedAll: ['Shelf']};
  let forming;
  view.materialize = nodes => {forming = nodes;};
  for (const withSeed of [false, true]) {
    if (withSeed) view.models.seed = {root: group('seed', group('Storage0', group('Television0')), group('Chair4'), group('Door4'), group('Window3'))};
    for (const show of [false, true, false]) {
      applyFinal(view, new Set(show ? ['Shelf'] : []), !show);
      const visible = [];
      root.traverseVisible(o => visible.push(o));
      for (const old of [chair, door, window, tv]) assert.ok(visible.includes(old), old.name);
      assert.equal(visible.includes(shelf), show);
      assert.equal(mask.parent, shelf);
      if (show) assert.deepEqual(forming, [shelf]);
      assert.ok(chair.getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-10);
    }
  }
});

test('a cluster node keeps its placed member boxes through the hold, delay and rewind', () => {
  const cluster = group('ChairCluster0', group('Chair0'), group('Chair4'));
  const view = viewOf({seed: {root: group('seed', cluster)}});
  for (const id of ['Chair0', 'Chair4', 'Chair9']) view.boxes[id] = scanBox();
  view.materialize = nodes => nodes.forEach(node => view.forming.active.set(node, {held: true, t: -0.25}));
  const apply = (built, quiet) => view.apply({shell: true, boxes: true, built: new Set(built)},
    {quiet, modelUrl: key => key === 'seed' && 'seed.glb'});
  const boxes = () => Object.values(view.boxes).map(box => box.visible);
  apply([], true);
  for (let play = 0; play < 2; play++) {
    apply(['ChairCluster0'], false);
    const effect = view.forming.active.get(cluster);
    assert.ok(effect.held);
    assert.deepEqual(boxes(), [true, true, true]);
    effect.held = false;
    view.updateChairBoxes();
    assert.deepEqual(boxes(), [true, true, true]);
    effect.t = 0.1;
    view.updateChairBoxes();
    assert.deepEqual(boxes(), [false, false, true]);
    apply([], true);
    assert.equal(cluster.visible, false);
    assert.deepEqual(boxes(), [true, true, true]);
  }
});

test('a pending check and its fade keep the outgoing interpolated room masked', async () => {
  const later = group('Later'), final = group('final', later), view = viewOf({final: {root: final}});
  const check = group('round0');
  for (const root of [final, check]) Object.assign(root.userData, {fade: 1, fadeMats: [], mask: [], windows: new Map()});
  view.current = view.wanted = 'final';
  const pending = Promise.withResolvers();
  view.model = key => {
    if (key === 'final') return Promise.resolve(view.models.final);
    view.models[key] = {};
    return pending.promise;
  };
  const options = {modelUrl: k => k !== 'seed' && k + '.glb', addedAll: ['Later']};
  const apply = (model, added, quiet = false) => view.apply({model, added, built: new Set(), modelEvent: {round: 1}}, {...options, quiet});
  apply('final', new Set(), true);
  apply('round0', null);
  assert.equal(view.versionLabel(), '组装中的房间 · 按记录推算');
  assert.equal(later.visible, false);
  view.models.round0.root = check;
  pending.resolve(view.models.round0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.incoming, 'round0');
  assert.equal(view.versionLabel(), '组装中的房间 · 按记录推算 → 检查第 1 轮');
  assert.equal(later.visible, false);
  view.swap('round0');
  assert.equal(view.versionLabel(), '检查第 1 轮');
  apply('final', null, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.versionLabel(), '最终房间');
  assert.equal(later.visible, true);
});

test('version labels use the reached publication and the round recorded within each run', () => {
  const events = [
    {model: 'articulated', joints: 2}, {model: 'round0', round: 1}, {model: 'round1', round: 1},
    {model: 'articulated', joints: 2, published: true},
    {model: 'articulated', joints: 0}, {model: 'articulated', joints: 0, published: true},
    {model: 'articulated', published: true},
  ].map((e, minute) => ({...e, stage: 'review', minute}));
  const tl = buildTimeline({events, stages: [{id: 'review'}]});
  const view = viewOf(Object.fromEntries(events.map(({model}) => [model, {root: group(model)}])));
  const labelAt = index => {
    const state = sceneAt(tl, tl.events[index].at);
    view.current = view.wanted = state.model;
    view.apply(state, {quiet: true});
    return view.versionLabel();
  };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 4, 0].map(labelAt),
    ['已装配可开合部件', '检查第 1 轮', '检查第 1 轮', '发布版（可开合）', '开合处理后', '发布版', '发布版', '开合处理后', '已装配可开合部件']);
});

test('a resaved articulated room changes the visible scene; its late receipt reuses that scene', async t => {
  const view = Object.assign(viewOf({}), {current: null, wanted: null, scene: group('scene'), retiring: new Set(),
    retryAt: {}, wallFades: [], scaffoldReady: true, warm: async () => {}, setFade() {}});
  view.prepare = root => root;
  view.forming.releaseModel = () => {};
  const options = {quiet: true, modelUrl: k => k === 'articulated' && '/files/Room.glb'};
  const requests = [], fetchData = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const response = Promise.withResolvers();
    requests.push({url, send: bytes => response.resolve(fetchData('data:application/json,' + encodeURIComponent(bytes), options))});
    return response.promise;
  });
  const file = name => JSON.stringify({asset: {version: '2.0'}, scenes: [{nodes: [0]}], nodes: [{name}]});
  const old = file('BeforeRepair'), next = file('AfterRepair');
  const apply = (bytes, evidence) => {
    const artifact_digest = createHash('sha256').update(bytes).digest('hex');
    view.apply({model: 'articulated', modelEvent: {artifact_digest, ...evidence}}, options);
  };
  async function finish(request, bytes) {
    const loaded = view.models[view.wanted].promise;
    request.send(bytes);
    await loaded;
    await new Promise(resolve => setImmediate(resolve));
  }
  apply(old, {joints: 0});
  await finish(requests[0], old);
  const before = view.models[view.current].root;
  assert.ok(before.visible && before.getObjectByName('BeforeRepair'));
  apply(next, {joints: 2});
  assert.equal(view.versionLabel(), '开合处理后');
  assert.equal(before.userData.modelEvent.joints, 0);
  assert.notEqual(requests[0].url, requests[1].url);

  // The path still serves old bytes while the file is being replaced.
  await assert.rejects(finish(requests[1], old));
  assert.equal(view.models[view.current].root, before);
  assert.equal(view.versionLabel(), '开合处理后');
  view.retryAt = {};
  apply(next, {joints: 2});
  await finish(requests[2], next);
  const after = view.models[view.current].root;
  assert.notEqual(before, after);
  assert.ok(after.visible && after.getObjectByName('AfterRepair'));
  assert.equal(view.versionLabel(), '已装配可开合部件');
  apply(next, {joints: 2, published: true});
  assert.equal(view.models[view.current].root, after);
  assert.equal(view.versionLabel(), '发布版（可开合）');
  assert.equal(requests.length, 3);
});

test('offline articulated milestones and stage text use the evidence in the saved answer', () => {
  const stage = {id: 'articulate', name: '装上可开合部件', desc: '找出柜门、抽屉等能开合的部件，装上转轴或滑轨，这就是发布的房间。'};
  const view = viewOf({articulated: {root: group('articulated')}});
  view.current = view.wanted = 'articulated';
  for (const [name, minute] of [['Activity Classroom', 1807.303], ['Room_3934', 512.264]]) {
    const event = {id: 'articulated', stage: 'articulate', model: 'articulated', minute, kind: 'milestone',
      say: '装好可开合部件，这就是发布的房间', source: 'legacy_projection', confidence: 'inferred'};
    const data = readReplay({name, stages: [stage], events: [event]});
    const tl = buildTimeline(data);
    view.apply(sceneAt(tl, tl.duration), {quiet: true});
    assert.deepEqual([view.versionLabel(), tl.events[0].say, tl.stageAt(tl.duration).name, tl.stageAt(tl.duration).desc],
      ['开合处理后', '完成开合处理', '处理可开合部件', '检查柜门和抽屉，按需添加转轴或滑轨。']);
    const events = [{...event, joints: 2}, {...event, published: true}, {...event, say: '这次处理了抽屉'}];
    assert.deepEqual(readReplay({stages: [], events}).events.map(e => e.say),
      ['装好可开合部件', '完成开合处理，已发布这版房间', '这次处理了抽屉']);
  }
});
