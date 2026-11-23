import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import * as THREE from '../../vendor/build/three.module.js';

// RoomView uses the page's import map. Exercise its normal model and frame paths without a WebGL context.
const imports = registerHooks({resolve(name, context, next) {
  if (name === 'three') return next(new URL('../../vendor/build/three.module.js', import.meta.url).href, context);
  if (name.startsWith('three/addons/')) return next(new URL(name.replace('three/addons/', '../../vendor/examples/jsm/'), import.meta.url).href, context);
  return next(name, context);
}});
const {RoomView} = await import('../../replay/room-view.mjs');
imports.deregister();

function fixture(nested = true) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color();
  const lights = {hemisphere: new THREE.HemisphereLight(), sun: new THREE.DirectionalLight(), fill: new THREE.DirectionalLight()};
  const root = new THREE.Group();
  scene.add(...Object.values(lights), root);
  function add(parent, name, material = new THREE.MeshStandardMaterial()) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.name = name; parent.add(mesh); return mesh;
  }
  const wall = add(root, 'Wall2'); wall.position.z = 2;
  const window = add(nested ? wall : root, 'Window0');
  const sash = add(window, 'Window1');
  const glass = add(sash, 'Pane', new THREE.MeshPhysicalMaterial({transmission: 1}));
  const photo = add(window, 'Window0_photo', new THREE.MeshStandardMaterial({transparent: true}));
  add(root, 'Window0_Curtain'); add(root, 'WindowDaylightBackdrop0');
  const floor = add(root, 'Floor0');
  const view = Object.assign(Object.create(RoomView.prototype), {
    scene, lights, camera: new THREE.PerspectiveCamera(), controls: {target: new THREE.Vector3(), update() {}},
    renderer: {capabilities: {getMaxAnisotropy: () => 1}, shadowMap: {needsUpdate: false}, render() {}},
    forming: {finishAll() {}, waiting: () => false, update() {}, triangles: () => null}, formTag: {},
    current: 'final', wanted: 'final', models: {final: {root}}, rig: null, wallFades: [],
    wallFaces: [{name: 'Wall2', n: [0, 0, -1], d: -2, tangent: [1, 0, 0], bounds: [[-2, 0], [2, 3]]}],
    userHeld: true, speed: 1, time: 1,
  });
  view.camera.position.z = 5;
  view.prepare(root);
  return {view, root, wall, sash, glass, photo, floor};
}

test('physical wall shadows agree from either entry angle and all per-mesh flags return on exit', () => {
  const {view, wall, sash, glass, photo, floor, root} = fixture();
  const mask = root.userData.mask[0];
  glass.castShadow = photo.receiveShadow = mask.castShadow = true;
  sash.castShadow = floor.receiveShadow = true;
  const before = [];
  root.traverse(mesh => {if (mesh.isMesh) before.push([mesh, mesh.castShadow, mesh.receiveShadow, mesh.material]);});
  function orbit(near) {
    view.camera.position.z = near ? 5 : -5;
    for (let i = 0; i < 24; i++) {view.lastTick = performance.now() - 50; view.tick();}
  }
  for (const near of [true, false]) {
    orbit(near);
    assert.equal(wall.material.transparent, near);
    view.physical(true); view.tick();
    assert.equal(view.renderer.shadowMap.needsUpdate, true);
    view.renderer.shadowMap.needsUpdate = false;
    for (const angle of [near, !near, near]) {
      orbit(angle);
      for (const mesh of [wall, sash]) {
        assert.equal(mesh.castShadow, true);
        assert.equal(mesh.receiveShadow, !angle);
      }
      for (const mesh of [glass, mask]) assert.deepEqual([mesh.castShadow, mesh.receiveShadow], [false, false]);
      // The photo on the wall casts nothing but takes the wall's shadows while the wall shows.
      assert.deepEqual([photo.castShadow, photo.receiveShadow], [false, !angle]);
      assert.deepEqual([floor.castShadow, floor.receiveShadow], [false, true]);
      assert.equal(view.renderer.shadowMap.needsUpdate, false);
    }
    view.physical(false);
    for (const [mesh, cast, receive, material] of before) {
      assert.deepEqual([mesh.castShadow, mesh.receiveShadow], [cast, receive]);
      assert.equal(mesh.material, material);
    }
    view.tick();
    assert.equal(wall.receiveShadow, false);
  }
});

test('only the outer window supplies light, whether top-level or attached to the wall', () => {
  for (const nested of [false, true]) {
    const {view} = fixture(nested);
    view.physical(true); view.tick();
    const {window, physical} = view.rig.snapshot();
    assert.equal(window, 'Window0');
    for (const list of [physical.parts, physical.lights]) assert.deepEqual(list.filter(p => p.kind === 'window').map(p => p.name), ['Window0']);
    view.physical(false);
  }
});

test('an unlabelled room with only a window backdrop has no physical window light', () => {
  const {view, root} = fixture();
  const backdrop = root.getObjectByName('WindowDaylightBackdrop0');
  root.clear(); root.add(backdrop);
  view.wallFaces = [];
  view.physical(true); view.tick();
  assert.deepEqual(view.rig.snapshot().physical.lights.filter(p => p.kind === 'window'), []);
  view.physical(false);
});

test('requesting physical lighting waits for the timeline target to load and finish fading', () => {
  const {view} = fixture();
  view.physical(true);
  assert.equal(view.rig, null);
  view.wanted = 'articulated'; view.tick();
  assert.equal(view.rig, null);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
  wall.name = 'Wall2';
  const root = view.prepare(new THREE.Group().add(wall));
  view.models.articulated = {root}; view.scene.add(root);
  view.incoming = 'articulated'; view.mix = 0; view.tick();
  assert.equal(view.rig, null);
  view.mix = 1; view.lastTick = performance.now() - 50; view.tick();
  assert.equal(view.current, 'articulated');
  assert.ok(view.rig.snapshot().physical.active);
  assert.equal(root.getObjectByName('Wall2').castShadow, true);
  assert.equal(view.models.final.root.getObjectByName('Wall2').castShadow, false);
  view.physical(false);
});
