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

function fixture(nested = true, windowNames = ['Window0']) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color();
  const lights = {hemisphere: new THREE.HemisphereLight(), sun: new THREE.DirectionalLight(), fill: new THREE.DirectionalLight()};
  const root = new THREE.Group();
  scene.add(...Object.values(lights), root);
  function add(parent, name, material = new THREE.MeshStandardMaterial()) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    mesh.name = name; parent.add(mesh); return mesh;
  }
  const wall = add(root, 'Wall2'); wall.position.z = 2;
  const window = add(nested ? wall : root, windowNames[0]);
  const sash = add(window, 'Window1');
  for (const name of windowNames.slice(1)) add(window.parent, name).scale.y = 2;
  const glass = add(sash, 'Pane', new THREE.MeshPhysicalMaterial({transmission: 1}));
  const blendedGlass = add(sash, 'Primitive0', new THREE.MeshStandardMaterial({transparent: true, opacity: .32, depthWrite: false}));
  const sheer = add(window, 'WindowSheer_pleated_cloth', new THREE.MeshStandardMaterial({
    name: 'White sheer woven curtain', transparent: true, opacity: .32, depthWrite: false,
  }));
  const photo = add(wall, 'PhotoCollage', new THREE.MeshStandardMaterial({map: new THREE.Texture(), transparent: true, depthWrite: false}));
  add(root, 'Window0_Curtain'); add(root, 'WindowDaylightBackdrop0');
  const floor = add(root, 'Floor0');
  const view = Object.assign(Object.create(RoomView.prototype), {
    scene, lights, camera: new THREE.PerspectiveCamera(), controls: {target: new THREE.Vector3(), update() {}},
    renderer: {capabilities: {getMaxAnisotropy: () => 1}, shadowMap: {needsUpdate: false}, render() {}},
    forming: {finishAll() {}, waiting: () => false, update() {}, triangles: () => null}, formTag: {},
    current: 'final', wanted: 'final', models: {final: {root}}, rig: null, wallFades: [], boxes: {},
    wallFaces: [{name: 'Wall2', n: [0, 0, -1], d: -2, tangent: [1, 0, 0], bounds: [[-2, 0], [2, 3]]}],
    userHeld: true, speed: 1, time: 1,
  });
  view.camera.position.z = 5;
  view.prepare(root);
  return {view, root, wall, sash, glass, blendedGlass, sheer, photo, floor};
}

test('physical wall shadows agree from either entry angle and all per-mesh flags return on exit', () => {
  const {view, wall, sash, glass, blendedGlass, sheer, photo, floor, root} = fixture();
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
      for (const mesh of [glass, blendedGlass, mask]) assert.deepEqual([mesh.castShadow, mesh.receiveShadow], [false, false], mesh.name);
      for (const mesh of [photo, sheer]) assert.deepEqual([mesh.castShadow, mesh.receiveShadow], [false, !angle], mesh.name);
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

for (const name of ['Window_0', 'Window-0']) {
  test(`an unlabelled room lights ${name} and skips its backdrop`, () => {
    const {view, root} = fixture(false, [name]);
    const window = root.getObjectByName(name), backdrop = root.getObjectByName('WindowDaylightBackdrop0');
    backdrop.name = name + '_Backdrop';
    window.clear();
    root.clear(); root.add(window, backdrop);
    view.wallFaces = [];
    view.physical(true); view.tick();
    const {parts, lights} = view.rig.snapshot().physical;
    for (const list of [parts, lights]) assert.deepEqual(list.filter(p => p.kind === 'window').map(p => p.name), [name]);
    view.physical(false);
  });
}

test('named window openings each supply a light and exclude their sashes and nearby scenery', () => {
  const {view} = fixture(true, ['WindowLeft', 'WindowRight']);
  view.physical(true); view.tick();
  const {window, physical} = view.rig.snapshot();
  assert.equal(window, 'WindowRight');
  for (const list of [physical.parts, physical.lights]) {
    assert.deepEqual(list.filter(p => p.kind === 'window').map(p => p.name), ['WindowLeft', 'WindowRight']);
  }
  view.physical(false);
});

test('a window explicitly listed by the replay can have a nonstandard name', () => {
  const {view} = fixture(true, ['BayOpening']);
  view.apply({model: 'final', built: new Set()}, {openings: {Door: ['Door0'], Window: ['BayOpening']}});
  view.physical(true); view.tick();
  const {window, physical} = view.rig.snapshot();
  assert.equal(window, 'BayOpening');
  assert.deepEqual(physical.lights.filter(p => p.kind === 'window').map(p => p.name), ['BayOpening']);
  view.physical(false);
});

test('leaving physical lighting restores the replay ground color and the sun target in world space', () => {
  const {view, root} = fixture();
  root.position.set(8, 0, -4);
  const {hemisphere, sun} = view.lights;
  hemisphere.groundColor.set(0x8a8170);
  sun.target.position.set(1, 2, 3);
  sun.target.updateWorldMatrix(true, false);
  const ground = hemisphere.groundColor.clone(), target = sun.target.position.clone(), world = sun.target.matrixWorld.clone();
  view.physical(true); view.tick();
  assert.ok(!hemisphere.groundColor.equals(ground));
  assert.ok(!sun.target.matrixWorld.equals(world));
  view.physical(false);
  assert.deepEqual(hemisphere.groundColor, ground);
  assert.deepEqual(sun.target.position, target);
  assert.deepEqual(sun.target.matrixWorld, world);
});

test('seeking back to the current model cancels the other fade and lights the visible room', async () => {
  const {view, root, wall} = fixture();
  const round = view.prepare(new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())));
  const entry = view.models.round1 = {root: round};
  entry.promise = Promise.resolve(entry);
  round.visible = false;
  view.scene.add(round);
  await view.show('round1', 'round1.glb', false);
  view.lastTick = performance.now() - 50; view.tick();
  assert.equal(view.incoming, 'round1');
  assert.ok(view.mix > 0 && view.mix < 1);
  view.physical(true);
  await view.show('final', 'final.glb', true);
  for (let i = 0; i < 9; i++) {view.lastTick = performance.now() - 250; view.tick();}
  assert.equal(view.current, 'final');
  assert.equal(view.incoming, null);
  assert.ok(root.visible && !round.visible);
  assert.ok(view.rig.snapshot().physical.active);
  assert.equal(wall.castShadow, true);
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
