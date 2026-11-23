import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createRoomVisibility} from '../room-visibility.mjs';
import {createMobileLighting} from '../lighting.mjs';
import {PHYSICAL, physicalExposure} from '../../editor/physical-lighting.mjs';

function fixture(settings, {withBackdrop = false} = {}) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#ebe7da');
  const room = new THREE.Group(); room.userData.roomcanvas = {schema: 1, lighting: settings}; scene.add(room);
  const add = (name, size, at, material = new THREE.MeshStandardMaterial()) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.name = name; mesh.position.set(...at); room.add(mesh); return mesh;
  };
  add('Floor0', [4, .1, 4], [0, -.05, 0]);
  const wall = add('Wall0', [.1, 3, 4], [2, 1.5, 0]);
  add('Ceiling0', [4, .1, 4], [0, 3, 0]);
  const glass = add('Window0', [.05, 1, 1], [1.9, 1.5, 0], new THREE.MeshPhysicalMaterial({transmission: 1}));
  const photo = withBackdrop && add('WindowDaylightBackdrop0', [.01, 1, 1], [2.05, 1.5, 0],
    new THREE.MeshBasicMaterial({map: new THREE.Texture()}));
  if (settings?.luminaires) add('Panel0', [.6, .05, .6], [0, 2.9, 0]);
  room.updateMatrixWorld(true);
  const renderer = {shadowMap: {}, toneMappingExposure: 1};
  const visibility = createRoomVisibility(THREE, room);
  const lighting = createMobileLighting(THREE, {renderer, scene, visibility, bounds: new THREE.Box3().setFromObject(room), floorY: 0});
  return {scene, room, wall, glass, photo, renderer, visibility, lighting};
}

test('mobile uses editor physical intensities and preserves occlusion across cutaway and walking', () => {
  const {scene, room, wall, glass, renderer, visibility, lighting} = fixture();
  const state = lighting.snapshot(), sun = scene.children.find(light => light.isDirectionalLight);
  assert.equal(state.preset, 'physical');
  assert(Math.abs(sun.intensity - PHYSICAL.sunLux * physicalExposure().exposure / renderer.toneMappingExposure) < 1e-10);
  assert.equal(state.physical.lights.length, 2, 'one ceiling lamp and one window light');
  assert.equal(renderer.shadowMap.enabled, true);
  assert.equal(renderer.shadowMap.autoUpdate, false);
  assert(scene.children.filter(light => light.isLight && light !== sun && light.shadow).every(light => light.shadow.mapSize.x <= 512));
  assert.equal(room.getObjectByName('Floor0').receiveShadow, true);
  visibility.update([4, 3, 4]); lighting.syncOccluders();
  assert.equal(wall.visible, false);
  const proxies = scene.getObjectByName('mobile-wall-occluders');
  assert.equal(proxies.children.filter(mesh => mesh.visible).length, 1, 'glass never becomes an opaque shadow blocker');
  assert.equal(proxies.children[0].geometry, wall.geometry);
  assert.equal(proxies.children[0].material.colorWrite, false);
  assert.equal(proxies.children[0].material.depthWrite, false);
  assert.equal(glass.castShadow, false);
  assert(scene.getObjectByName('lighting-roof-occluders').children.every(mesh => mesh.visible));
  visibility.update([4, 3, 4], {walking: true}); lighting.syncOccluders();
  assert.equal(lighting.snapshot().wallOccluders, 0);
  assert(scene.getObjectByName('lighting-roof-occluders').children.every(mesh => !mesh.visible));
  let geometryDisposed = false;
  wall.geometry.addEventListener('dispose', () => {geometryDisposed = true;});
  lighting.dispose();
  assert.equal(geometryDisposed, false);
  assert.equal(scene.getObjectByName('mobile-wall-occluders'), undefined);
  assert.equal(scene.children.filter(light => light.isLight).length, 0);
});

test('new snapshots restore selected time, indoor power and grading instead of forcing default physical', () => {
  const {lighting} = fixture({preset: 'night', indoor: {power: false, angle: 120}, environment: false, ao: false,
    grading: {exposure: -.4, whiteBalance: .2, contrast: 1.1, saturation: .8}});
  assert.equal(lighting.snapshot().preset, 'night');
  assert.equal(lighting.snapshot().indoor.power, false);
  assert.equal(lighting.snapshot().environmentIntensity, 0);
  assert.equal(lighting.settings.ao, false);
  assert.deepEqual(lighting.settings.grading, {exposure: -.4, whiteBalance: .2, contrast: 1.1, saturation: .8});
  lighting.dispose();
});

test('mobile shares use the same daylight tints, dark sky and listed ceiling fixtures', () => {
  for (const preset of ['morning', 'afternoon', 'night']) {
    const {lighting, renderer, photo, glass, scene} = fixture({preset, luminaires: ['Panel0']}, {withBackdrop: true});
    const state = lighting.snapshot();
    assert.equal(state.lights[0].luminaire, 'Panel0');
    const areas = scene.children.filter(light => light.isRectAreaLight && light.visible);
    assert.equal(areas.length, preset === 'night' ? 1 : 0);
    assert.ok(areas.every(light => !light.castShadow));
    if (preset === 'night') {
      assert.ok(glass.material.isMeshBasicMaterial && glass.material.transparent && !(glass.material.transmission > 0));
      assert.equal(photo.material.map, null); assert.equal(photo.material.color.getHex(), 0x152339);
      assert.ok(photo.material.polygonOffset && photo.material.polygonOffsetUnits < 0);
      assert.equal(state.environmentIntensity, .08);
    } else {
      assert.equal(glass.material.transmission, 1);
      assert.ok(photo.material.map);
      assert.ok(preset === 'morning' ? photo.material.color.b > photo.material.color.r : photo.material.color.r > photo.material.color.b);
      assert.equal(renderer.toneMappingExposure, 1.1 * (preset === 'morning' ? .94 : .90));
      assert.equal(photo.castShadow, false);
      assert.ok(scene.getObjectByName('mobile-wall-occluders').children.every(proxy => proxy.geometry !== photo.geometry));
    }
    lighting.dispose();
  }
});
