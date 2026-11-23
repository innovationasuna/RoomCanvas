import test from 'node:test';
import assert from 'node:assert/strict';
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
const {OrbitControls} = await import('three/addons/controls/OrbitControls.js');
imports.deregister();

function model() {
  const root = new THREE.Group();
  root.visible = false;
  Object.assign(root.userData, {fade: 1, mask: [], fadeMats: []});
  const entry = {root};
  entry.promise = Promise.resolve(entry);
  return entry;
}

function room() {
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  const view = Object.assign(Object.create(RoomView.prototype), {
    camera, controls: new OrbitControls(camera), scene: new THREE.Scene(), center: new THREE.Vector3(),
    vel: {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()}, paused: false, rate: 1, speed: 1, time: 1,
    renderer: {render() {}}, forming: {active: new Set(), waiting: () => false, update() {}, triangles: () => null,
      finishModel(root) {this.active.delete(root);}, finishAll() {this.active.clear();}}, formTag: {}, wallFades: [], wantPhysical: false,
  });
  Object.assign(view, {models: {seed: model(), final: model()}, boxes: {}, calm: {matches: false}});
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
async function page(t, live, data = {}) {
  const view = room(), nodes = new Map(), job = {
    live, stages: [{id: 'assemble', name: 'assemble'}], models: {seed: 'seed', final: 'final'},
    events: [{stage: 'assemble', minute: 0, kind: 'milestone', model: 'seed'}],
    ...data,
  };
  view.physical = () => {};
  view.ensureScaffold = () => {};
  const element = () => Object.assign(new EventTarget(), {
    value: '1', children: [], dataset: {}, style: {}, classList: {toggle() {}},
    append() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({left: 0, width: 100}),
  });
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  }
  let frame, poll;
  const host = {window: {view}, location: {search: '?job=' + '0'.repeat(32)},
    document: {getElementById: node, createElement: element}, ResizeObserver: class {observe() {}},
    addEventListener() {}, requestAnimationFrame(fn) {frame = fn;},
  };
  for (const [name, value] of Object.entries(host)) {
    const before = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => before ? Object.defineProperty(globalThis, name, before) : Reflect.deleteProperty(globalThis, name));
  }
  t.mock.method(globalThis, 'fetch', async () => Response.json(job));
  t.mock.method(globalThis, 'setTimeout', fn => {poll = fn;});
  const hooks = registerHooks({resolve(name, context, next) {
    return next(name === './room-view.mjs' ? 'data:text/javascript,export class RoomView {constructor(){return window.view}}' : name, context);
  }});
  try {await import('../../replay/replay.mjs?' + encodeURIComponent(t.name));} finally {hooks.deregister();}
  await loaded();
  return {view, job, player: window.player, finish: () => frame(performance.now() + window.player.duration * 1000 + 1),
    poll: () => poll(), scrub: x => node('track').dispatchEvent(Object.assign(new Event('pointerdown'), {clientX: x}))};
}

function checkOverviewSpin(view) {
  frames(view, 400);
  assert.ok(view.controls.target.distanceTo(view.center) < 0.005);
  assert.ok(Math.abs(view.controls.getDistance() - view.defaultDist) < 0.02);
  const az = view.controls.getAzimuthalAngle();
  frames(view, 5);
  assert.ok(Math.abs(view.controls.getAzimuthalAngle() - az) > 0.001);
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

test('finishing after a paused and resumed last object close-up spins around the whole room', async t => {
  const {view, player, finish} = await page(t, false, {
    stages: [{id: 'plan', name: 'plan'}],
    events: [{stage: 'plan', minute: 0, model: 'seed'},
      {stage: 'plan', minute: 1, model: 'final', show: ['Chair0']}],
  });
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

function drag(view) {
  view.controls.dispatchEvent({type: 'start'});
  view.controls._rotateLeft(0.5);
  view.controls.update();
  view.controls.dispatchEvent({type: 'end'});
}

test('scrubbing from a pause to the end preserves the manual framing', async t => {
  const {view, scrub} = await page(t, false);
  scrub(40);
  drag(view);
  const pos = view.camera.position.clone();
  view.controls.dispatchEvent({type: 'start'});
  view.controls.dispatchEvent({type: 'end'});
  scrub(100);
  frames(view, 8);
  assert.equal(view.userHeld, true);
  assert.ok(view.camera.position.distanceTo(pos) < 1e-10);
});

test('replaying after a manual turn at the end releases the camera', async t => {
  const {view, player, finish} = await page(t, false);
  finish();
  drag(view);
  assert.equal(view.userHeld, true);
  player.play();
  assert.equal(player.t, 0);
  assert.equal(view.userHeld, false);
  view.pose(0, 0.8);
  const az = view.controls.getAzimuthalAngle();
  frames(view, 20);
  assert.ok(Math.abs(view.controls.getAzimuthalAngle() - az) > 0.01);
});

test('a live poll fades in a new draft while scrubbing to the same draft shows it at once', async t => {
  const {view, job, player, poll, scrub} = await page(t, true);
  frames(view, 60);
  job.events.push({stage: 'assemble', minute: 5, kind: 'milestone', model: 'draft1'});
  job.models.draft1 = 'draft1';
  const draft = view.models.draft1 = model();
  await poll();
  await loaded();
  frames(view, 8);
  assert.equal(player.playing, false);
  assert.equal(view.incoming, 'draft1');
  assert.ok(draft.root.visible && draft.root.userData.fade > 0 && draft.root.userData.fade < 1);
  scrub(0);
  scrub(100);
  await loaded();
  assert.equal(view.current, 'draft1');
  assert.equal(view.incoming, null);
  assert.ok(draft.root.visible);
  assert.equal(draft.root.userData.fade, 1);
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
