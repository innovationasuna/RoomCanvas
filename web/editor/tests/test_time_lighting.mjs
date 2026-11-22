import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createTimeLighting, timePreset} from '../time-lighting.mjs';
import {setSeeThrough} from '../wall-visibility.mjs';
import {indoorLighting} from '../indoor-lighting.mjs';

function fixture({low = [-2, 0, -2], high = [2, 3, 2], fixturePosition} = {}) {
  const bounds = new THREE.Box3(new THREE.Vector3(...low), new THREE.Vector3(...high));
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ede5');
  const room = new THREE.Group(); scene.add(room);
  const box = (name, dimensions, position, material = new THREE.MeshStandardMaterial()) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material); mesh.name = name; mesh.position.set(...position); mesh.castShadow = true; room.add(mesh); return mesh;
  };
  const wall = box('Wall1', [4, 3, .1], [0, 1.5, -2]);
  const roof = box('Ceiling0', [4, .1, 4], [0, 3, 0]); roof.visible = false;
  const window = box('Window0', [2, 1.5, .05], [0, 1.5, -1.9], new THREE.MeshPhysicalMaterial({transmission: 1, emissive: 0x999999}));
  if (fixturePosition !== null) box('Lamp0', [.2, .15, .2], fixturePosition || [center.x + size.x * .3, high[1] - .1, center.z - size.z * .2]);
  room.updateMatrixWorld(true);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x87919d, 1.1), sun = new THREE.DirectionalLight(0xffffff, 3), fill = new THREE.DirectionalLight(0xffffff, .65);
  sun.position.set(-3.5, 8, 4); sun.target.position.set(0, 0, 0); sun.castShadow = true;
  scene.add(hemi, sun, sun.target, fill);
  const renderer = {shadowMap: {needsUpdate: false}};
  // No ceiling luminaires listed (Lamp0 is not one): these tests cover the central-lamp fallback;
  // test_room_luminaires.mjs covers rooms lit from their luminaires.
  const config = {openings: {Wall1: ['Window0']}, label: name => ({Window0: '窗户', Ceiling0: '天花板', Lamp0: '灯'})[name], isCeiling: name => ['Ceiling0', 'Lamp0'].includes(name), luminaires: []};
  const rig = createTimeLighting(THREE, {renderer, scene, room, config, walls: [{name: 'Wall1', n: [0, 0, 1]}],
    bounds, floorY: low[1], ceilingY: high[1],
    profile: {key: 3, fill: .65, hemisphere: 1.1, environment: .35}});
  return {rig, renderer, scene, room, wall, roof, window, sun, fill, hemi};
}
test('day presets use the principal window and refit the sun; balanced restores authored lighting', () => {
  const f = fixture(), original = f.sun.position.clone();
  f.rig.apply('morning'); const morning = f.sun.position.clone();
  f.rig.apply('afternoon'); assert.notDeepEqual(f.sun.position.toArray(), morning.toArray());
  assert.equal(f.rig.snapshot().window, 'Window0');
  assert.ok(f.sun.position.z < 0); assert.equal(f.window.castShadow, false);
  assert.ok(f.renderer.shadowMap.needsUpdate);
  f.rig.apply('balanced'); assert.deepEqual(f.sun.position.toArray(), original.toArray());
  assert.equal(f.window.castShadow, true); assert.equal(f.scene.environmentIntensity, .35);
  assert.equal(timePreset('bad'), 'noon'); f.rig.dispose();
});
test('without luminaires, night uses one attenuated central ceiling light and one shadow map; mode changes never duplicate it', () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) {f.rig.apply('night'); f.rig.apply('noon');}
  f.rig.apply('night');
  const spots = f.scene.children.filter(light => light.userData.lightingRole === 'indoor');
  assert.equal(spots.length, 1); assert.equal(spots[0].decay, 2);
  assert.equal(f.scene.children.some(light => light.isRectAreaLight), false);
  assert.ok(Math.abs(spots[0].angle * 2 * 180 / Math.PI - 160) < 1e-6);
  assert.equal(f.sun.visible, false); assert.equal(f.fill.visible, false);
  assert.equal(f.sun.intensity, 0); assert.equal(f.fill.intensity, 0);
  assert.ok(f.scene.environmentIntensity < .03); assert.ok(f.hemi.intensity < .1);
  assert.equal(f.scene.children.filter(light => light.isLight && light.visible && light.castShadow).length, 1);
  assert.equal(f.rig.snapshot().lamp.source, 'room-bounds-center');
  assert.deepEqual(f.rig.snapshot().luminaires, []); assert.equal(f.rig.fixtures, 0);
  assert.deepEqual(f.rig.snapshot().lights.map(light => [light.source, light.share, light.castShadow]), [['fallback', 1, true]]);
  assert.equal(f.scene.children.filter(object => object.isMesh && object.geometry.type === 'SphereGeometry').length, 1, 'the invented lamp keeps its marker');
  assert.equal(f.window.material.emissiveIntensity, .025);
  f.rig.setIndoor({power: false});
  f.rig.apply('balanced'); assert.equal(spots[0].visible, false);
  assert.equal(f.window.material.emissiveIntensity, 1);
  f.rig.dispose(); assert.equal(spots[0].parent, null);
});
test('daytime window light dominates the configured mix while the same indoor lamp stays on weakly', () => {
  const f = fixture(); f.rig.apply('night');
  const nightPower = f.rig.snapshot().lamp.intensity;
  for (const time of ['morning', 'noon', 'afternoon']) {
    f.rig.apply(time); const state = f.rig.snapshot();
    assert.equal(state.lamp.visible, true); assert.ok(state.lamp.intensity > 0 && state.lamp.intensity < nightPower * .3);
    assert.equal(state.windowLight.visible, true); assert.equal(state.windowLight.castShadow, true);
    assert.deepEqual(state.windowLight.mapSize, [1024, 1024]);
    assert.equal(f.fill.visible, false); assert.ok(f.hemi.intensity <= .5); assert.ok(f.scene.environmentIntensity <= .25);
    assert.equal(f.scene.children.filter(light => light.isLight && light.visible && light.castShadow).length, 2);
  }
  f.rig.apply('night'); assert.equal(f.rig.snapshot().windowLight.visible, false);
  f.rig.dispose();
});
test('see-through walls and hidden roof block light in time presets without changing their displayed opacity or source geometry', () => {
  const f = fixture(); setSeeThrough(f.wall, true);
  const opacity = f.wall.material.opacity;
  f.rig.apply('noon');
  assert.equal(f.wall.castShadow, true); assert.equal(f.wall.receiveShadow, false); assert.equal(f.wall.material.opacity, opacity);
  const proxies = f.scene.getObjectByName('lighting-roof-occluders');
  assert.equal(proxies.children[0].geometry, f.roof.geometry);
  assert.equal(proxies.children[0].material.colorWrite, false); assert.equal(proxies.children[0].visible, true);
  f.roof.visible = true; f.rig.syncOccluders(); assert.equal(proxies.children[0].visible, false);
  f.rig.apply('balanced'); assert.equal(f.wall.castShadow, false);
  f.rig.dispose(); assert.equal(proxies.parent, null);
});
test('cone angle and power stay independent of time without changing outdoor lights', () => {
  const f = fixture(); f.rig.apply('night');
  for (const time of ['balanced', 'morning', 'noon', 'afternoon', 'night']) {
    f.rig.apply(time);
    const daylight = {sun: f.sun.intensity, fill: f.fill.intensity, hemisphere: f.hemi.intensity, environment: f.scene.environmentIntensity};
    for (const angle of [60, 120, 160, 170]) {
      f.renderer.shadowMap.needsUpdate = false;
      f.rig.setIndoor({power: true, angle}); const state = f.rig.snapshot();
      assert.equal(state.lamp.visible, true);
      assert.ok(Math.abs(state.lamp.angle - angle) < 1e-6); assert.equal(state.lamp.shadowFov, angle);
      assert.equal(f.renderer.shadowMap.needsUpdate, time === 'night', 'daylight shadow maps should stay cached');
    }
    f.rig.setIndoor({power: false, angle: 120});
    const state = f.rig.snapshot();
    assert.deepEqual(state.indoor, {power: false, angle: 120});
    assert.equal(state.lamp.visible, false); assert.equal(state.lamp.intensity, 0);
    assert.deepEqual({sun: f.sun.intensity, fill: f.fill.intensity, hemisphere: f.hemi.intensity, environment: f.scene.environmentIntensity}, daylight);
    f.rig.apply(time);
    assert.equal(f.rig.snapshot().lamp.visible, false, 'time changes must not turn power back on');
  }
  assert.equal(f.scene.children.filter(light => light.userData.lightingRole === 'indoor').length, 1);
  f.rig.dispose();
});
test('room bounds determine the top centre across offsets, sizes and missing or off-centre fixtures', () => {
  for (const data of [
    {low: [-3, 0, -1], high: [5, 3, 1]},
    {low: [11, 4, -17], high: [12.5, 6.5, -9], fixturePosition: null},
    {low: [-25, -3, 5], high: [-5, 2, 17], fixturePosition: [-24, 1.8, 6]},
  ]) {
    const f = fixture(data); f.rig.apply('night'); const {position, target, source} = f.rig.snapshot().lamp;
    assert.equal(source, 'room-bounds-center');
    for (const axis of [0, 2]) {
      assert.equal(position[axis], (data.low[axis] + data.high[axis]) / 2);
      assert.equal(target[axis], position[axis]);
    }
    assert.ok(position[1] < data.high[1] && position[1] > data.high[1] - .25);
    assert.equal(target[1], data.low[1]);
    f.rig.setIndoor({power: true, angle: 100}); assert.deepEqual(f.rig.snapshot().lamp.position, position);
    f.rig.dispose();
  }
});
test('indoor configuration clamps full angles, rejects non-finite inputs, and migrates old lamp settings', () => {
  assert.deepEqual(indoorLighting(null), {power: true, angle: 160});
  assert.deepEqual(indoorLighting({power: false, ceiling: false, strip: true}), {power: false, angle: 160});
  assert.deepEqual(indoorLighting({power: 'false', angle: NaN}), {power: true, angle: 160});
  assert.equal(indoorLighting({angle: Infinity}).angle, 160);
  assert.equal(indoorLighting({angle: 20}).angle, 60);
  assert.equal(indoorLighting({angle: 180}).angle, 170);
});
