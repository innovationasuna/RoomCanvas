import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTimeline, readReplay} from '../../replay/timeline.mjs';
import {registerHooks} from 'node:module';
import * as THREE from '../../vendor/build/three.module.js';

// Use the same Three.js modules as the replay page without starting WebGL.
const vendor = new URL('../../vendor/', import.meta.url);
const imports = registerHooks({resolve(specifier, context, next) {
  if (specifier === 'three') return next(new URL('build/three.module.js', vendor).href, context);
  if (specifier.startsWith('three/addons/')) return next(new URL(specifier.replace('three/addons/', 'examples/jsm/'), vendor).href, context);
  return next(specifier, context);
}});
const {RoomView} = await import('../../replay/room-view.mjs');
const {SmallItemLayer} = await import('../../replay/small-items.mjs');
const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
const {OrbitControls} = await import('three/addons/controls/OrbitControls.js');
imports.deregister();

function model() {
  const root = new THREE.Group();
  root.visible = false;
  Object.assign(root.userData, {fade: 1, mask: [], fadeMats: [], windows: new Map()});
  const entry = {root};
  entry.promise = Promise.resolve(entry);
  return entry;
}

function room() {
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  const view = Object.assign(Object.create(RoomView.prototype), {
    camera, controls: new OrbitControls(camera), scene: new THREE.Scene(), center: new THREE.Vector3(),
    vel: {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()}, paused: false, rate: 1, speed: 1, time: 1,
    renderer: {capabilities: {getMaxAnisotropy: () => 1}, render() {}}, forming: {active: new Set(), waiting: () => false, update() {},
      releaseModel() {}, finishModel(root) {this.active.delete(root);}, finishAll() {this.active.clear();}}, wallFades: [], wantPhysical: false,
  });
  Object.assign(view, {models: {seed: model(), final: model()}, retryAt: {}, retiring: new Set(), boxes: {}, calm: {matches: false}});
  view.watchOrbit();
  view.controls.enableDamping = true;
  view.frame(new THREE.Box3(new THREE.Vector3(-2, -1, -2), new THREE.Vector3(2, 1, 2)));
  view.controls.update();
  return view;
}

test('pause stops both camera targets and pending orbit damping, and still permits manual orbit', () => {
  const view = room(), {camera, controls} = view;
  view.pose(1, 0.6);
  view.focusTo = new THREE.Vector3(3, 2, 1);
  Object.assign(view.vel, {theta: 1, phi: 1, dist: 1});
  view.vel.target.set(1, 1, 1);
  controls._rotateLeft(0.5);
  controls.update();
  const position = camera.position.clone(), target = controls.target.clone();
  view.setPlaying(false);
  for (let i = 0; i < 4; i++) {view.lastTick -= 1000; view.tick();}
  assert.equal(view.aimTo, null);
  assert.equal(view.focusTo, null);
  assert.deepEqual(view.vel, {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()});
  assert.equal(view.time, 1);
  assert.ok(camera.position.distanceTo(position) < 1e-10);
  assert.ok(controls.target.equals(target));
  controls._rotateLeft(0.5);
  controls.update();
  const manual = camera.position.clone();
  view.tick();
  assert.ok(manual.distanceTo(position) > 0.1);
  assert.ok(camera.position.distanceTo(manual) < 1e-10);
  view.setPlaying(true);
  view.lastTick -= 100;
  view.tick();
  assert.ok(camera.position.distanceTo(manual) > 1e-6);
});

const options = {modelUrl: key => key};
const applyModel = (view, model, quiet) => view.apply({model, built: new Set()}, {...options, quiet});
const loaded = () => new Promise(resolve => setImmediate(resolve));
function frames(view, count) {
  view.lastTick = performance.now();
  for (let i = 0; i < count; i++) {view.lastTick -= 50; view.tick();}
}

test('pausing a fade settles the requested model and its forming effects', async () => {
  const view = room();
  applyModel(view, 'final', false);
  await loaded();
  frames(view, 1);
  assert.ok(view.mix > 0 && view.mix < 1);
  view.forming.active.add(view.models.final.root);
  view.setPlaying(false);
  applyModel(view, 'final', true);
  assert.equal(view.current, 'final');
  assert.equal(view.incoming, null);
  assert.equal(view.mix, 1);
  assert.equal(view.forming.active.size, 0);
});

test('seeking back during a fade keeps only the requested model visible after resuming', async () => {
  const view = room(), {seed, final} = view.models;
  applyModel(view, 'seed', true);
  await loaded();
  view.setPlaying(true);
  applyModel(view, 'final', false);
  await loaded();
  frames(view, 8);
  assert.ok(final.root.visible && final.root.userData.fade > 0 && final.root.userData.fade < 1);
  view.setPlaying(false);
  applyModel(view, 'seed', true);
  assert.ok(seed.root.visible && !final.root.visible);
  assert.equal(seed.root.userData.fade, 1);
  view.setPlaying(true);
  applyModel(view, 'seed', false);
  frames(view, 60);
  assert.equal(view.current, 'seed');
  assert.equal(view.incoming, null);
  assert.ok(seed.root.visible && !final.root.visible);
});

test('a model requested in playback arrives fully visible on the first finished frame', async () => {
  const view = room(), final = view.models.final, root = final.root;
  const gate = Promise.withResolvers();
  final.promise = gate.promise;
  delete final.root;
  const chair = new THREE.Group();
  chair.name = 'Chair0';
  root.add(chair);
  const state = {model: 'final', added: new Set([chair.name]), built: new Set()};
  const request = quiet => view.apply(state, {...options, quiet, addedAll: [chair.name]});
  view.forming.start = node => view.forming.active.add(node);
  view.setPlaying(true);
  request(false);
  view.setPlaying(false, true);
  request(true);
  final.root = root;
  gate.resolve(final);
  await loaded();
  assert.equal(view.current, 'final');
  assert.equal(view.incoming, null);
  assert.ok(root.visible);
  assert.equal(root.userData.fade, 1);
  assert.ok(chair.visible);
  assert.equal(view.forming.active.size, 0);
  assert.equal(view.wantSpin, true);
});

// Run the page's player, poll and scrub handlers with an in-memory job and a renderer-free view.
async function page(t, live, data = {}, {search = '?job=' + '0'.repeat(32), fetcher} = {}) {
  const view = room(), nodes = new Map(), job = {
    live, stages: [{id: 'assemble', name: 'assemble'}], models: {seed: 'seed', final: 'final'},
    events: [{stage: 'assemble', minute: 0, kind: 'milestone', model: 'seed'}],
    ...data,
  };
  view.physical = () => {};
  view.ensureScaffold = () => {};
  const element = () => Object.defineProperty(Object.assign(new EventTarget(), {
    value: '1', children: [], dataset: {}, style: {}, classList: {toggle() {}, add() {}},
    append(el) {this.children.push(el);}, remove() {}, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({left: 0, width: 100}),
  }), 'firstChild', {get() {return Object.assign(element(), {innerHTML: this.innerHTML});}});  // a card is parsed into a holder and its first child moved into the log
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  }
  let frame, poll;
  const host = {window: {view}, location: {href: 'https://room.test/replay.html', search},
    document: {getElementById: node, createElement: element}, ResizeObserver: class {observe() {}},
    addEventListener() {}, requestAnimationFrame(fn) {frame = fn;},
  };
  for (const [name, value] of Object.entries(host)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => before ? Object.defineProperty(globalThis, name, before) : Reflect.deleteProperty(globalThis, name));
  }
  t.mock.method(globalThis, 'fetch', fetcher || (async () => Response.json(job)));
  t.mock.method(globalThis, 'setTimeout', fn => {poll = fn;});
  const hooks = registerHooks({resolve(name, context, next) {
    return next(name === './room-view.mjs' ? 'data:text/javascript,export class RoomView {constructor(){return window.view}}' : name, context);
  }});
  try {await import('../../replay/replay.mjs?' + encodeURIComponent(t.name));} finally {hooks.deregister();}
  await loaded();
  return {view, job, node, player: window.player, finish: () => frame(performance.now() + window.player.duration * 1000 + 1),
    poll: () => poll(), scrub: x => node('track').dispatchEvent(Object.assign(new Event('pointerdown'), {clientX: x}))};
}

for (const search of ['', '?job=' + 'a'.repeat(32)]) {
  test(`replay ${search || 'picker'} reports invalid credentials in the visible message`, async t => {
    const {node} = await page(t, false, {}, {search, fetcher: async () => Response.json({error: 'unauthorized'}, {status: 401})});
    assert.match(node('loading').textContent, /联系管理员检查服务凭证/);
  });
}

test('the replay picker links every available job through the oldest record', async t => {
  const jobs = Array.from({length: 15}, (_, i) => ({id: i.toString(16).padStart(32, '0'), created: i, status: 'completed'}));
  const {node} = await page(t, false, {}, {search: '', fetcher: async () => Response.json({jobs})});
  const links = Array.from(node('loading').innerHTML.matchAll(/href="\?job=([a-f0-9]+)"/g), match => match[1]);
  assert.deepEqual(links, jobs.reverse().map(job => job.id));
});

test('the replay picker leaves out rooms in the recycle bin', async t => {
  const jobs = ['a', 'b'].map((c, i) => ({id: c.repeat(32), created: i, status: 'completed'}));
  const fetcher = async url => url === '/web/rooms.json' ? Response.json({rooms: [], deleted: ['scan-' + 'b'.repeat(32)]}) : Response.json({jobs});
  const {node} = await page(t, false, {}, {search: '', fetcher});
  const links = Array.from(node('loading').innerHTML.matchAll(/href="\?job=([a-f0-9]+)"/g), match => match[1]);
  assert.deepEqual(links, ['a'.repeat(32)]);
});

for (const trash of ['error', 'timeout']) test(`the replay picker lists every job when the recycle bin answers with ${trash}`, async t => {
  const jobs = [{id: 'a'.repeat(32), created: 0, status: 'completed'}];
  const fetcher = async (url, options) => {
    if (url !== '/web/rooms.json') return Response.json({jobs});
    if (trash === 'error') return Response.json({error: '无法读取房间删除记录'}, {status: 500});
    assert.ok(options.signal, 'the request gives up after a while');
    throw new DOMException('The operation timed out.', 'TimeoutError');
  };
  const {node} = await page(t, false, {}, {search: '', fetcher});
  assert.match(node('loading').innerHTML, new RegExp(`href="\\?job=${'a'.repeat(32)}"`));
});

for (const standalone of [false, true]) test(`all item pictures and original review zoom, standalone=${standalone}`, async t => {
  const items = Array.from({length: 24}, (_, i) => ({id: 'item' + i, kind: 'tool', stage: 'assemble', minute: i,
    ...(standalone ? {recorded_stage: 'small_objects'} : {}),
    work: 'small', object_id: 'Cup' + i, object_name: '杯子', say: '原始逐件记录', img: i < 23 ? i + '.png' : null}));
  const views = ['pair_00037.png', 'pair_00183.png'];
  const events = [...items, {id: 'r0', kind: 'review', stage: 'review', minute: 25, say: '检查房间没通过',
    img: views[0], media: views.map(src => ({role: 'review', src}))}];
  const {node, player} = await page(t, false, {events, stages: [{id: 'assemble'}, {id: 'review'}], models: {}});
  // The card grows with each item's record (the 3D view shows each item then), also after a rewind.
  const first = () => {
    player.seek(0.01, {pause: true});
    const card = node('log').children.findLast(el => el.innerHTML.includes('card objects')).innerHTML;
    assert.match(card, /已按照片制作 1 件小物品/);
    assert.equal((card.match(/class="cell"/g) || []).length, 1);
  };
  first();
  player.seek(player.duration, {pause: true});
  const [objects, review] = node('log').children.slice(-2).map(el => el.innerHTML);
  assert.match(objects, /已按照片制作 24 件小物品/);
  assert.equal((objects.match(/class="cell"/g) || []).length, 23);
  assert.match(objects, /class="bare">杯子 24</);
  assert.doesNotMatch(objects, /原始逐件记录|data-more|class="detail"/);
  first();
  player.seek(player.duration, {pause: true});
  const thumbs = [...review.matchAll(/class="wide" data-z="(\d+)" data-src="([^"]+)"/g)];
  assert.deepEqual(thumbs.map(m => m[2].split('/').pop()), views);
  const click = new Event('click');
  Object.defineProperty(click, 'target', {value: {closest: sel => sel === '[data-z]'
    ? {dataset: {z: thumbs[1][1], src: thumbs[1][2]}} : null}});
  node('log').dispatchEvent(click);
  assert.ok(node('lb').innerHTML.includes(thumbs[1][2]));
});

// Three photo items made by a separate pass, none with a stand-in in the room, and their models (as the source
// GLB places them) in a photo layer, attached when the test says they have loaded.
async function photoReplay(t) {
  const ids = ['Cup0', 'Cup1', 'Cup2'];
  const job = {stages: [{id: 'plan', name: 'plan'}, {id: 'assemble', name: 'assemble'}],
    models: {seed: 'seed', final: 'final', small_objects: 'so'}, hidden_nodes: {},
    events: [{id: 'seed', stage: 'plan', minute: 0, kind: 'milestone', model: 'seed'},
      ...ids.map((id, i) => ({id: 'item' + i, kind: 'tool', stage: 'assemble', recorded_stage: 'small_objects', minute: 100 + i,
        display_minute: 1, work: 'small', object_id: id, object_name: '杯子', say: '杯子的照片模型已就绪'})),
      {id: 'placed', stage: 'assemble', recorded_stage: 'small_objects', minute: 109, display_minute: 1,
        kind: 'milestone', overlay_model: 'small_objects'}]};
  const times = buildTimeline(readReplay(job)).events.filter(e => e.object_id).map(e => e.at);
  const replay = await page(t, false, job);
  const parts = [[1.5, 0, 1], [-1.5, 0, -1], [0, 0, 1.5]].map(([x, y, z], i) => {
    const part = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2));
    part.name = ids[i];
    part.position.set(x, y, z);
    return part;
  });
  const {view} = replay;
  view.loadPhotoItems = () => {};
  const layer = new SmallItemLayer(new THREE.Group().add(...parts), ids);
  const load = () => {
    view.photoSource = {layer};
    view.scene.add(layer.root);
    view.apply(view.state, view.lastOptions);  // as when the layer arrives
  };
  const centre = k => new THREE.Box3().setFromObject(parts[k]).getCenter(new THREE.Vector3());
  return {...replay, ids, times, layer, load, centre};
}

test('the camera moves in on each photo item at its own record, and a rewind does not move it', async t => {
  const {view, player, ids, times, layer, load, centre} = await photoReplay(t);
  load();
  // Each item takes the time an object taking shape does, so the camera can reach it before the next.
  assert.ok(times.every((at, k) => !k || at - times[k - 1] >= 4.5));
  for (const [k, at] of times.entries()) {
    player.seek(at + 0.01);
    await loaded();
    assert.deepEqual(ids.map(id => layer.items.get(id).part.visible), ids.map((_, j) => j <= k));
    assert.ok(view.aimTo?.close && view.aimTo.target.distanceTo(centre(k)) < 1e-6, `camera on ${ids[k]}`);
    frames(view, 120);
    assert.ok(view.controls.target.distanceTo(centre(k)) < 0.005);
  }
  // Dragged back, the items go and the camera stays where it is.
  const target = view.aimTo.target.clone();
  player.seek(times[0] + 0.01);
  await loaded();
  assert.deepEqual(ids.map(id => layer.items.get(id).part.visible), [true, false, false]);
  assert.ok(view.aimTo.target.equals(target));
});

test('a photo item reached before its model loads is framed once it arrives, within its own record', async t => {
  const {view, player, times, load, centre} = await photoReplay(t);
  player.seek(times[0] + 0.01);
  await loaded();
  assert.ok(!view.aimTo?.close);  // nothing of it to frame yet
  // The next record comes before the model: only that item waits to be framed.
  player.seek(times[1] + 0.01);
  await loaded();
  assert.ok(!view.aimTo?.close);
  load();
  player.seek(times[1] + 0.02);  // a later frame of the same record
  assert.ok(view.aimTo?.close && view.aimTo.target.distanceTo(centre(1)) < 1e-6);
  // Framed once: a further frame of the record does not move in again.
  const aim = view.aimTo;
  player.seek(times[1] + 0.03);
  assert.equal(view.aimTo, aim);
});

test('a photo item waiting for its model is not framed after a drag away from its record', async t => {
  const {view, player, times, load} = await photoReplay(t);
  player.seek(times[0] + 0.01);
  await loaded();
  player.seek(0.01);
  load();
  player.seek(0.02);
  assert.ok(!view.aimTo?.close);
});

function checkOverviewSpin(view) {
  frames(view, 400);
  assert.ok(view.controls.target.distanceTo(view.center) < 0.005);
  assert.ok(Math.abs(view.controls.getDistance() - view.defaultDist) < 0.02);
  const az = view.controls.getAzimuthalAngle();
  frames(view, 5);
  const turn = view.controls.getAzimuthalAngle() - az;
  const delta = Math.atan2(Math.sin(turn), Math.cos(turn));
  assert.ok(delta > 0.01 && delta < 0.02);  // Five 50 ms frames at the overview's 0.058 rad/s.
}

test('natural completion releases the close-up, returns to overview distance and keeps turning', async t => {
  const {view, player, finish} = await page(t, false);
  view.controls.target.set(2, 0, 1);
  view.camera.position.copy(view.controls.target).add(new THREE.Vector3(0, 1, 2));
  view.controls.update();
  view.pose(0, 1);
  Object.assign(view.aimTo, {target: view.controls.target.clone(), close: true, dist: Math.sqrt(5), at: view.time});
  finish();
  assert.equal(player.playing, false);
  assert.equal(view.aimTo, null);
  checkOverviewSpin(view);
});

async function lastCloseUp(t) {
  const replay = await page(t, false, {
    stages: [{id: 'plan', name: 'plan'}],
    events: [{stage: 'plan', minute: 0, model: 'seed'},
      {stage: 'plan', minute: 1, model: 'final', show: ['Chair0']}],
  });
  const {view, player} = replay;
  const chair = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.4));
  chair.name = 'Chair0';
  chair.position.set(1.5, 0, 1);
  view.models.final.root.add(chair);
  player.seek(player.duration - 1);
  await loaded();
  assert.ok(view.aimTo?.close);
  frames(view, 120);
  assert.ok(view.controls.target.distanceTo(chair.position) < 0.005);
  assert.ok(view.controls.getDistance() < view.defaultDist / 2);
  return replay;
}

test('finishing after a paused and resumed last object close-up spins around the whole room', async t => {
  const {view, player, finish} = await lastCloseUp(t);
  player.pause();
  const position = view.camera.position.clone();
  frames(view, 20);
  assert.ok(view.camera.position.distanceTo(position) < 1e-10);
  player.play();
  finish();
  assert.equal(player.playing, false);
  assert.equal(view.current, 'final');
  checkOverviewSpin(view);
});

test('scrubbing directly from an object close-up to the end spins around the whole room', async t => {
  const {view, player, scrub} = await lastCloseUp(t);
  scrub(100);
  assert.equal(player.t, player.duration);
  assert.equal(player.playing, false);
  checkOverviewSpin(view);
});

test('a stationary canvas press suspends a camera move then lets it finish and spin', async t => {
  const {view, finish} = await page(t, false);
  view.pose(-1, 0.8);
  const {controls, camera} = view, position = camera.position.clone();
  controls.dispatchEvent({type: 'start'});
  frames(view, 10);
  assert.ok(camera.position.distanceTo(position) < 1e-10);
  controls.dispatchEvent({type: 'end'});
  frames(view, 10);
  assert.ok(camera.position.distanceTo(position) > 0.01);
  assert.equal(view.aimTo?.az, -1);
  finish();
  checkOverviewSpin(view);
});

function startDrag(view) {
  view.controls.dispatchEvent({type: 'start'});
  view.controls._rotateLeft(0.5);
  view.controls.update();
}

test('natural completion after a released drag returns to the turning overview', async t => {
  const {view, finish} = await lastCloseUp(t);
  startDrag(view);
  view.controls.dispatchEvent({type: 'end'});
  finish();
  checkOverviewSpin(view);
});

test('completion during a drag waits for release before returning to the turning overview', async t => {
  const {view, finish} = await lastCloseUp(t);
  startDrag(view);
  const target = view.controls.target.clone();
  finish();
  frames(view, 100);
  assert.ok(view.controls.target.distanceTo(target) < 1e-10);
  assert.ok(view.controls.getDistance() < view.defaultDist / 2);
  view.controls.dispatchEvent({type: 'end'});
  checkOverviewSpin(view);
});

test('paused manual framing stays frozen until scrubbing to the end', async t => {
  const {view, scrub} = await page(t, false);
  scrub(40);
  startDrag(view);
  view.controls.dispatchEvent({type: 'end'});
  const pos = view.camera.position.clone();
  view.controls.dispatchEvent({type: 'start'});
  view.controls.dispatchEvent({type: 'end'});
  frames(view, 8);
  assert.equal(view.userHeld, true);
  assert.ok(view.camera.position.distanceTo(pos) < 1e-10);
  scrub(100);
  checkOverviewSpin(view);
});

test('replaying after a manual turn at the end releases the camera', async t => {
  const {view, player, finish} = await page(t, false);
  finish();
  startDrag(view);
  assert.equal(view.userHeld, true);
  view.controls.dispatchEvent({type: 'end'});
  checkOverviewSpin(view);
  player.play();
  assert.equal(player.t, 0);
  assert.equal(view.userHeld, false);
  view.pose(0, 0.8);
  const az = view.controls.getAzimuthalAngle();
  frames(view, 20);
  assert.ok(Math.abs(view.controls.getAzimuthalAngle() - az) > 0.01);
});

test('following a live job keeps the wheel zoom until the job finishes', async t => {
  const {view, job, player, poll} = await page(t, true);
  const {controls, camera} = view;
  controls._onMouseWheel({deltaY: -1000, preventDefault() {}});
  const distance = controls.getDistance(), position = camera.position.clone();
  assert.ok(distance < view.defaultDist * 0.7);
  frames(view, 100);
  assert.ok(Math.abs(controls.getDistance() - distance) < 1e-10);

  job.events.push({stage: 'assemble', minute: 5, kind: 'milestone', model: 'final'});
  await poll();
  await loaded();
  frames(view, 60);
  assert.equal(player.t, player.duration);
  assert.equal(view.current, 'final');
  assert.ok(camera.position.distanceTo(position) < 1e-10);

  job.live = false;
  await poll();
  checkOverviewSpin(view);
});

test('a live rebuild keeps a paused reader at the same time without starting effects', async t => {
  const {view, job, player, poll, scrub} = await page(t, true);
  scrub(40);
  const time = player.t;
  job.events.push({stage: 'assemble', minute: 5, kind: 'milestone', model: 'final'});
  await poll();
  assert.equal(player.t, time);
  assert.equal(player.playing, false);
  assert.equal(view.lastOptions.quiet, true);
});

test('a live poll fades in a new draft while scrubbing to the same draft shows it at once', async t => {
  const {view, job, player, poll, scrub} = await page(t, true);
  frames(view, 60);
  job.events.push({stage: 'assemble', minute: 5, kind: 'milestone', model: 'draft1'});
  job.models.draft1 = 'draft1';
  t.mock.method(GLTFLoader.prototype, 'loadAsync', async () => ({scene: new THREE.Group()}));
  view.warm = async () => {};
  view.modelsFramed = true;
  await poll();
  await loaded();
  frames(view, 8);
  assert.equal(player.playing, false);
  assert.equal(view.incoming, 'draft1');
  const draft = view.models.draft1.root;
  assert.ok(draft.visible && draft.userData.fade > 0 && draft.userData.fade < 1);
  scrub(0);
  assert.equal(view.models.draft1, undefined);
  scrub(100);
  await loaded();
  assert.equal(view.current, 'draft1');
  assert.equal(view.incoming, null);
  const reloaded = view.models.draft1.root;
  assert.notEqual(reloaded, draft);
  assert.ok(reloaded.visible);
  assert.equal(reloaded.userData.fade, 1);
});

function loadLayout(view) {
  const walls = [{a: [10, 20], b: [16, 28], h: 4, t: 0.1}];
  Object.assign(view, {scaffoldController: new AbortController(), palette: {pointsLo: 0, pointsHi: 0, wall: 0}});
  return view.loadScaffold({points: 'data:application/octet-stream;base64,', layout:
    'data:application/json,' + encodeURIComponent(JSON.stringify({floor: 0, walls, boxes: []}))});
}

test('a late layout keeps the paused partial seed visible with only the built objects', async () => {
  const view = room(), seed = view.models.seed.root;
  const chair = new THREE.Group(), bed = new THREE.Group();
  chair.name = 'Chair0'; bed.name = 'Bed0';
  seed.add(chair, bed);
  applyModel(view, 'seed', false);
  await loaded();
  frames(view, 60);
  view.forming.start = node => view.forming.active.add(node);
  const layout = loadLayout(view);
  view.setPlaying(false);
  view.apply({model: null, shell: true, built: new Set(['Chair0']), walls: 1, pointsFade: 1}, {...options, quiet: true});
  assert.ok(seed.visible && chair.visible && !bed.visible);
  await layout;
  frames(view, 60);
  assert.ok(seed.visible && chair.visible && !bed.visible);
  assert.ok(!view.wallLines.visible && !view.points.visible);
  assert.equal(view.quiet, true);
});

for (const framing of ['placeholder', 'model', 'click', 'drag']) {
  test(`layout updates the room bounds after ${framing} framing`, async () => {
    const view = room();
    view.modelsFramed = framing === 'model';
    if (framing === 'click' || framing === 'drag') {
      view.controls.dispatchEvent({type: 'start'});
      if (framing === 'drag') view.controls._rotateLeft(0.5);
      view.controls.update();
      view.controls.dispatchEvent({type: 'end'});
    }
    if (view.modelsFramed) {view.pose(null, view.defaultPolar); view.clearAim();}
    const position = view.camera.position.clone(), target = view.controls.target.clone();
    await loadLayout(view);
    assert.deepEqual(view.center.toArray(), [13, 2, 24]);
    assert.equal(view.radius, 8);
    assert.ok(Math.abs(view.defaultDist - 8 * 2.15) < 1e-10);
    if (view.modelsFramed) assert.ok(view.focusTo.equals(view.center));
    if (framing === 'placeholder' || framing === 'click') {
      assert.ok(view.controls.target.equals(view.center));
      assert.ok(view.camera.position.distanceTo(position) > 1);
    } else {
      assert.ok(view.camera.position.equals(position));
      assert.ok(view.controls.target.equals(target));
    }
  });
}

test('live follow, paused review and return to latest survive inserted pass records', async t => {
  const stages = ['assemble', 'review', 'small_objects'].map(id => ({id, name: id, desc: ''}));
  const events = [{id: 'build', stage: 'assemble', minute: 0},
    {id: 'review', stage: 'review', minute: 4, kind: 'review', round: 1},
    {id: 'final', stage: 'review', minute: 5, model: 'final'},
    {id: 'cup', stage: 'small_objects', minute: 9, work: 'small', object_id: 'Cup0'}];
  const {job, player, node, view, poll, scrub} = await page(t, true, {stages, events});
  const timeline = () => buildTimeline(readReplay(job));
  const record = () => {const tl = timeline(); return tl.events[tl.indexAt(player.t)];};
  assert.equal(record().id, 'cup');
  job.events.push({...events.at(-1), id: 'bottle', minute: 10, object_id: 'Bottle0'});
  await poll();
  assert.equal(record().id, 'bottle');
  const tl = timeline(), review = tl.events.find(e => e.id === 'review');
  scrub(100 * (review.at + 0.05) / tl.duration);
  assert.equal(record().id, 'review');
  job.events.push({...events.at(-1), id: 'saucer', minute: 11, object_id: 'Saucer0'});
  await poll();
  assert.equal(record().id, 'review');
  assert.ok(Math.abs(player.t - record().at - 0.05) < 1e-8);
  node('latest').onclick();
  assert.equal(record().id, 'saucer');
  assert.equal(view.state.model, null);
  job.events.push({...events.at(-1), id: 'plate', minute: 12, object_id: 'Plate0'});
  await poll();
  assert.equal(record().id, 'plate');
});

test('a live cached save ends both work clocks at completion', async t => {
  const {node} = await page(t, true, {events: [
    {id: 'start', stage: 'assemble', minute: 0},
    {id: 'save', stage: 'assemble', minute: 3, display_minute: 13, kind: 'milestone'},
  ]});
  assert.equal(node('clock').textContent, '0:13:00');
  assert.equal(node('total').textContent, '/ 0:13:00');
});
