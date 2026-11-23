import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createRoomVisibility} from '../room-visibility.mjs';
import {registerHooks} from 'node:module';
import {PHYSICAL, physicalExposure} from '../../editor/physical-lighting.mjs';
import {captureRoom, encodeRoom} from '../../editor/mobile-snapshot.mjs';

const ltcModules = [];
const imports = registerHooks({load(url, context, next) {
  if (url.includes('/lights/RectAreaLight')) ltcModules.push(url.split('/').pop());
  return next(url, context);
}});
const {createMobileLighting} = await import('../lighting.mjs');

function fixture(settings, {withBackdrop = false, door = false, photoMaterial} = {}) {
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
    photoMaterial ?? new THREE.MeshBasicMaterial({map: new THREE.Texture()}));
  if (door) {
    add('Wall1', [.1, 3, 4], [-2, 1.5, 0]);
    add('Door_Wall1', [.08, 2, 1], [-1.95, 1, .8]);
  }
  for (const [i, name] of (settings?.luminaires ?? []).entries()) add(name, [.6, .05, .6], [i, 2.9, 0]);
  room.updateMatrixWorld(true);
  const renderer = {shadowMap: {}, toneMappingExposure: 1};
  const visibility = createRoomVisibility(THREE, room);
  const lighting = createMobileLighting(THREE, {renderer, scene, visibility, bounds: new THREE.Box3().setFromObject(room), floorY: 0});
  return {scene, room, wall, glass, photo, renderer, visibility, lighting};
}

test('a failed LTC import still opens the night room with full fixture spot lighting', async t => {
  const blocked = registerHooks({resolve(name, context, next) {
    if (name.endsWith('/RectAreaLightUniformsLib.js')) throw new Error('LTC offline');
    return next(name, context);
  }});
  t.after(() => blocked.deregister());
  const luminaires = ['Panel0', 'Panel1'];
  const day = fixture({preset: 'noon', luminaires}), night = fixture({preset: 'night', luminaires});
  t.after(() => {day.lighting.dispose(); night.lighting.dispose();});
  await night.lighting.ready;
  assert.equal(night.scene.children.some(light => light.isRectAreaLight), false);
  const spots = night.scene.children.filter(light => light.isSpotLight && light.visible);
  assert.equal(spots.length, 2);
  assert.equal(spots.filter(light => light.castShadow).length, 1);
  const expected = day.lighting.snapshot().lights.map(light => light.intensity / .25);
  assert.deepEqual(spots.map(spot => spot.intensity), expected);
  assert.deepEqual(night.lighting.snapshot().lights.map(light => light.intensity), expected);
});

test('cold mobile entry loads LTC only for powered night fixtures and shares it until the last room closes', async () => {
  try {
    for (const settings of [{preset: 'noon', luminaires: ['Panel0']}, {preset: 'night'}, {preset: 'night', luminaires: ['Panel0'], indoor: {power: false}}]) {
      const {lighting} = fixture(settings); await lighting.ready; lighting.dispose();
    }
    assert.deepEqual(ltcModules, []);
    const settings = {preset: 'night', luminaires: ['Panel0']};
    const abandoned = fixture(settings); abandoned.lighting.dispose();
    const a = fixture(settings), b = fixture(settings);
    assert.equal(a.scene.children.some(l => l.isRectAreaLight), false);
    await Promise.all([abandoned.lighting.ready, a.lighting.ready, b.lighting.ready]);
    assert.equal(abandoned.scene.children.some(l => l.isRectAreaLight), false);
    assert.ok(a.scene.children.some(l => l.isRectAreaLight && l.visible));
    assert.deepEqual(ltcModules, ['RectAreaLightUniformsLib.js', 'RectAreaLightTexturesLib.js']);
    const textures = ['FLOAT_1', 'FLOAT_2', 'HALF_1', 'HALF_2'].map(key => THREE.UniformsLib['LTC_' + key]);
    let releases = 0;
    const released = () => releases++;
    for (const texture of textures) texture.addEventListener('dispose', released);
    a.lighting.dispose(); assert.equal(releases, 0);
    b.lighting.dispose(); assert.equal(releases, 4);
    const c = fixture(settings); await c.lighting.ready; c.lighting.dispose(); assert.equal(releases, 8);
    for (const texture of textures) texture.removeEventListener('dispose', released);
  } finally {imports.deregister();}
});

test('old noon snapshots retain their already scaled photo and central lamp fallback', () => {
  const baked = new THREE.MeshStandardMaterial({emissive: 0xffffff, emissiveIntensity: 1.52});
  const {lighting, photo} = fixture({preset: 'noon'}, {withBackdrop: true, photoMaterial: baked});
  assert.equal(photo.material.emissiveIntensity, 1.52);
  assert.equal(lighting.snapshot().lamp.source, 'room-bounds-center');
  lighting.dispose();
});

test('legacy and authored morning and afternoon GLBs reopen with the same window materials', async t => {
  const vendor = new URL('../../vendor/', import.meta.url);
  const hooks = registerHooks({resolve(name, context, next) {
    if (name === 'three') return next(new URL('build/three.module.js', vendor).href, context);
    if (name.startsWith('three/addons/')) return next(new URL(name.replace('three/addons/', 'examples/jsm/'), vendor).href, context);
    return next(name, context);
  }});
  t.after(() => hooks.deregister());
  globalThis.FileReader = class {
    async readAsArrayBuffer(blob) {this.result = await blob.arrayBuffer(); this.onloadend();}
  };
  t.after(() => {delete globalThis.FileReader;});
  const {GLTFLoader} = await import('three/addons/loaders/GLTFLoader.js');
  for (const [preset, bakedScale, expectedIntensity] of [['morning', .65, 1.952], ['afternoon', .50, 1.296]]) {
    const reopen = async legacy => {
      const room = new THREE.Group();
      const lit = new THREE.MeshStandardMaterial({color: 0xcda892, emissive: 0xffffff, emissiveIntensity: 1.6});
      const unlit = new THREE.MeshBasicMaterial({color: 0x7b93ab});
      for (const [i, material] of [lit, unlit].entries()) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, .1), material);
        mesh.name = 'WindowDaylightBackdrop' + i; room.add(mesh);
      }
      const snapshot = captureRoom(THREE, {room, entities: new Map(), layout: {}, lighting: {preset}});
      if (legacy) {
        delete snapshot.metadata.lighting.exterior;
        snapshot.root.children[0].material.emissiveIntensity *= bakedScale;
        snapshot.root.children[1].material.color.multiplyScalar(bakedScale);
      }
      const {blob} = await encodeRoom(snapshot);
      const {scene: model} = await new GLTFLoader().parseAsync(await blob.arrayBuffer(), '');
      const scene = new THREE.Scene(); scene.background = new THREE.Color(); scene.add(model);
      const lighting = createMobileLighting(THREE, {scene, renderer: {shadowMap: {}}, visibility: createRoomVisibility(THREE, model),
        bounds: new THREE.Box3().setFromObject(model), floorY: 0});
      await lighting.ready;
      const a = model.getObjectByName('WindowDaylightBackdrop0').material, b = model.getObjectByName('WindowDaylightBackdrop1').material;
      const result = [a.emissiveIntensity, ...a.emissive.toArray(), ...a.color.toArray(), ...b.color.toArray()];
      lighting.dispose(); return result;
    };
    const authored = await reopen(false), legacy = await reopen(true);
    assert.ok(Math.abs(authored[0] - expectedIntensity) < 1e-12);
    legacy.forEach((value, i) => assert.ok(Math.abs(value - authored[i]) < 1e-12, `${preset}: ${value} vs ${authored[i]}`));
  }
});

test('night reflection includes wall-mounted objects during a mobile cutaway and reuses the view when walking', () => {
  const f = fixture({preset: 'night'}, {door: true});
  const door = f.room.getObjectByName('Door_Wall1'), ceiling = f.room.getObjectByName('Ceiling0');
  const nearWall = f.room.getObjectByName('Wall1');
  const view = new THREE.PerspectiveCamera(); let captures = 0;
  Object.assign(f.renderer, {xr: {enabled: false}, extensions: {has: () => false},
    getRenderTarget: () => null, setRenderTarget() {}, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    render() {captures++; assert.ok(door.visible && nearWall.visible && ceiling.visible);}});
  const draw = () => f.glass.material.onBeforeRender(f.renderer, f.scene, view, f.glass.geometry, f.glass);
  f.visibility.update([-4, 3, 4]); f.lighting.syncOccluders();
  assert.ok(f.glass.visible);
  assert.ok(!door.visible && !nearWall.visible && !ceiling.visible); draw();
  assert.ok(!door.visible && !nearWall.visible && !ceiling.visible);
  f.visibility.update([-4, 3, 4], {walking: true}); draw();
  assert.ok(door.visible && nearWall.visible && ceiling.visible);
  assert.equal(captures, 1); f.lighting.dispose();
});

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

test('mobile shares use the same daylight tints, dark sky and listed ceiling fixtures', async () => {
  for (const preset of ['morning', 'afternoon', 'night']) {
    const {lighting, renderer, photo, glass, scene} = fixture({preset, luminaires: ['Panel0']}, {withBackdrop: true});
    await lighting.ready;
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
