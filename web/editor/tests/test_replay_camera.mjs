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

function room() {
  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 200);
  const view = Object.assign(Object.create(RoomView.prototype), {
    camera, controls: new OrbitControls(camera), scene: new THREE.Scene(), center: new THREE.Vector3(),
    vel: {theta: 0, phi: 0, dist: 0, target: new THREE.Vector3()}, paused: false, speed: 1, time: 1,
    renderer: {render() {}}, forming: {active: new Set(), waiting: () => false, update() {}, triangles: () => null,
      finishAll() {this.active.clear();}}, formTag: {}, wallFades: [], wantPhysical: false,
  });
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

test('a fade and forming effects arriving after pause settle on the requested model', () => {
  const view = room();
  view.setPlaying(false);
  const root = new THREE.Group();
  Object.assign(root.userData, {fade: 0.3, mask: [], fadeMats: []});
  Object.assign(view, {models: {final: {root}}, incoming: 'final', wanted: 'final', mix: 0.3});
  view.forming.active.add(root);
  view.tick();
  assert.equal(view.current, 'final');
  assert.equal(view.incoming, null);
  assert.equal(view.mix, 1);
  assert.equal(view.forming.active.size, 0);
});

test('paused frames do not finish a superseded fade', () => {
  const view = room();
  Object.assign(view, {current: 'seed', incoming: 'final', wanted: 'seed', mix: 0.3});
  view.setPlaying(false);
  view.lastTick -= 5000;
  view.tick();
  assert.equal(view.mix, 0.3);
  assert.equal(view.current, 'seed');
});

for (const framing of ['placeholder', 'model', 'manual']) {
  test(`layout updates the room bounds after ${framing} framing`, async () => {
    const view = room();
    view.modelsFramed = framing === 'model';
    view.userMoved = framing === 'manual';
    if (view.modelsFramed) {view.pose(null, view.defaultPolar); view.clearAim();}
    const position = view.camera.position.clone(), target = view.controls.target.clone();
    const walls = [{a: [10, 20], b: [16, 28], h: 4, t: 0.1}];
    Object.assign(view, {scaffoldController: new AbortController(), palette: {pointsLo: 0, pointsHi: 0, wall: 0}});
    await view.loadScaffold({points: 'data:application/octet-stream;base64,', layout:
      'data:application/json,' + encodeURIComponent(JSON.stringify({floor: 0, walls, boxes: []}))});
    assert.deepEqual(view.center.toArray(), [13, 2, 24]);
    assert.equal(view.radius, 8);
    assert.ok(Math.abs(view.defaultDist - 8 * 2.15) < 1e-10);
    if (view.modelsFramed) assert.ok(view.focusTo.equals(view.center));
    if (framing === 'placeholder') {
      assert.ok(view.controls.target.equals(view.center));
      assert.ok(view.camera.position.distanceTo(position) > 1);
    } else {
      assert.ok(view.camera.position.equals(position));
      assert.ok(view.controls.target.equals(target));
    }
  });
}
