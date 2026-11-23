import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createTimeLighting, timePreset} from '../time-lighting.mjs';
import {setSeeThrough} from '../wall-visibility.mjs';
import {setLayer} from '../material-layers.mjs';
import {createImportMaterials, updateImportLighting} from '../import-materials.mjs';
import {createRoomVisibility} from '../../mobile/room-visibility.mjs';
import {createMobileLighting} from '../../mobile/lighting.mjs';
import {captureRoom} from '../mobile-snapshot.mjs';
import {indoorLighting} from '../indoor-lighting.mjs';

function fixture({low = [-2, 0, -2], high = [2, 3, 2], fixturePosition, backdropMaterials, glazing, luminaires = []} = {}) {
  const bounds = new THREE.Box3(new THREE.Vector3(...low), new THREE.Vector3(...high));
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ede5');
  const room = new THREE.Group(); scene.add(room);
  const box = (name, dimensions, position, material = new THREE.MeshStandardMaterial()) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material); mesh.name = name; mesh.position.set(...position); mesh.castShadow = true; room.add(mesh); return mesh;
  };
  const wall = box('Wall1', [4, 3, .1], [0, 1.5, -2]);
  const roof = box('Ceiling0', [4, .1, 4], [0, 3, 0]); roof.visible = false;
  const window = box('Window0', [2, 1.5, .05], [0, 1.5, -1.9], glazing ?? new THREE.MeshPhysicalMaterial({transmission: 1, emissive: 0x999999}));
  if (backdropMaterials) {
    const photo = box('DaylightBackdrop', [2, 1.5, .01], [0, 0, -.1], backdropMaterials);
    window.add(photo);
    box('SharedElsewhere', [.2, .2, .1], [1, 1, 1], backdropMaterials[0]);
  }
  if (fixturePosition !== null) box('Lamp0', [.2, .15, .2], fixturePosition || [center.x + size.x * .3, high[1] - .1, center.z - size.z * .2]);
  room.updateMatrixWorld(true);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x87919d, 1.1), sun = new THREE.DirectionalLight(0xffffff, 3), fill = new THREE.DirectionalLight(0xffffff, .65);
  sun.position.set(-3.5, 8, 4); sun.target.position.set(0, 0, 0); sun.castShadow = true;
  scene.add(hemi, sun, sun.target, fill);
  const renderer = {toneMappingExposure: 1.1, shadowMap: {needsUpdate: false}};
  const config = {openings: {Wall1: ['Window0']}, label: name => ({Wall1: '墙面', Window0: '窗户', DaylightBackdrop: '窗外景', Ceiling0: '天花板', Lamp0: '灯'})[name], isCeiling: name => ['Ceiling0', 'Lamp0'].includes(name), luminaires};
  const walls = [{name: 'Wall1', n: [0, 0, 1], tangent: [1, 0, 0], d: -2, bounds: [[-2, 0], [2, 3]]}];
  const rig = createTimeLighting(THREE, {renderer, scene, room, config, walls,
    bounds, floorY: low[1], ceilingY: high[1],
    profile: {key: 3, fill: .65, hemisphere: 1.1, environment: .35}});
  return {rig, renderer, scene, room, wall, roof, window, sun, fill, hemi, config, walls, bounds};
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
test('the main window casts long golden morning and longer amber afternoon shadows on opposite sides', () => {
  const f = fixture();
  function sample(time) {
    f.rig.apply(time);
    const dir = f.sun.position.clone().sub(f.sun.target.position).normalize();
    const sky = f.scene.getObjectByName('window-skylight');
    assert.equal(sky.color.getHex(), f.hemi.color.getHex());
    return {dir, shadow: Math.hypot(dir.x, dir.z) / dir.y, sun: f.sun.color.clone(), sky: sky.color.clone(),
      window: sky.intensity, exposure: f.renderer.toneMappingExposure, background: f.scene.background.clone()};
  }
  const noon = sample('noon'), morning = sample('morning'), afternoon = sample('afternoon');
  assert.ok(morning.dir.x > .4 && afternoon.dir.x < -.4 && morning.dir.z < 0 && afternoon.dir.z < 0);
  assert.ok(morning.shadow > 3 * noon.shadow && afternoon.shadow > 1.3 * morning.shadow);
  assert.ok(morning.sky.b > morning.sky.r * 1.5 && afternoon.sky.r > afternoon.sky.b * 1.5);
  assert.ok(morning.sun.r > morning.sun.b && afternoon.sun.b < .6 * morning.sun.b);
  assert.ok(morning.background.b > morning.background.r && afternoon.background.r > afternoon.background.b);
  assert.ok(noon.window > morning.window && morning.window > afternoon.window);
  assert.ok(noon.exposure > morning.exposure && morning.exposure > afternoon.exposure);
  for (const time of ['physical', 'night', 'balanced', 'noon']) {
    f.rig.apply('morning'); f.rig.apply(time); assert.equal(f.renderer.toneMappingExposure, 1.1);
  }
  assert.deepEqual(sample('noon'), noon);
  f.rig.dispose();
});

test('night replaces photo slots only; cutaways, sharing and returning to daylight preserve the authored maps', () => {
  const map = new THREE.Texture();
  const lit = new THREE.MeshStandardMaterial({map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 2, side: THREE.DoubleSide});
  const unlit = new THREE.MeshBasicMaterial({map});
  const diffuse = new THREE.MeshStandardMaterial({map});
  const frame = new THREE.MeshStandardMaterial({color: 0x444444});
  const slots = [lit, unlit, diffuse, frame];
  const f = fixture({backdropMaterials: slots}), photo = f.room.getObjectByName('DaylightBackdrop');
  for (const time of ['morning', 'afternoon', 'morning']) {
    f.rig.apply(time);
    for (const material of photo.material.slice(0, 3)) {
      assert.equal(material.map, map);
      assert.ok(time === 'morning' ? material.color.b > material.color.r : material.color.r > material.color.b);
    }
    assert.equal(photo.material[0].emissiveMap, map);
    assert.ok(time === 'morning' ? photo.material[0].emissiveIntensity > 2 : photo.material[0].emissiveIntensity < 2);
    assert.equal(photo.castShadow, false);
    assert.equal(photo.material[3].color.getHex(), frame.color.getHex());
    const snapshot = captureRoom(THREE, {room: f.room, entities: new Map(), layout: {}});
    assert.equal(snapshot.root.getObjectByName('DaylightBackdrop').material[0].emissiveIntensity, 2);
    snapshot.dispose();
  }
  setSeeThrough(f.window, true, .08); f.rig.apply('night');
  assert.equal(photo.material[0].opacity, .08);
  setSeeThrough(f.window, false); f.rig.syncOccluders();
  for (const material of photo.material.slice(0, 3)) {
    assert.ok(material.isMeshBasicMaterial); assert.equal(material.map, null);
    assert.equal(material.color.getHex(), 0x152339);
    assert.ok(material.polygonOffset && material.polygonOffsetUnits < 0, 'night sky wins a depth tie with the backing');
  }
  assert.equal(photo.material[0].side, THREE.DoubleSide);
  assert.equal(photo.material[3].color.getHex(), frame.color.getHex());
  assert.ok(f.window.material.isMeshBasicMaterial && f.window.material.transparent);
  assert.equal(f.room.getObjectByName('SharedElsewhere').material, lit);
  assert.equal(lit.emissiveIntensity, 2); assert.equal(lit.emissiveMap, map);
  for (const [time, scale] of [['noon', .95], ['physical', 1], ['balanced', 1]]) {
    f.rig.apply('night'); f.rig.apply(time);
    assert.equal(photo.material[0].map, map); assert.equal(photo.material[0].emissiveMap, map);
    assert.equal(photo.material[0].emissiveIntensity, 2 * scale); assert.equal(photo.castShadow, true);
    assert.equal(photo.material[0].polygonOffset, false);
    assert.equal(photo.material[1].color.r, scale);
    assert.equal(f.window.material.emissiveIntensity, scale);
  }
  f.rig.apply('night'); f.rig.dispose(); assert.equal(photo.material, slots);
});
test('clear non-emitting glass skips night refraction across cutaways and preserves every daylight slot', () => {
  const pane = new THREE.MeshPhysicalMaterial({transmission: 1, roughness: .025, ior: 1.45, side: THREE.DoubleSide});
  const frame = new THREE.MeshStandardMaterial({color: 0x333333});
  const slots = [pane, frame, pane], f = fixture({glazing: slots});
  const other = new THREE.Mesh(f.window.geometry, pane); f.room.add(other);
  const daylight = new Map();
  for (const time of ['morning', 'noon', 'afternoon', 'physical', 'balanced']) {
    f.rig.apply(time); daylight.set(time, f.window.material);
  }
  setSeeThrough(f.window, true);
  f.rig.apply('night');
  for (const faint of [false, true, false]) {
    setSeeThrough(f.window, faint); f.rig.syncOccluders();
    for (const i of [0, 2]) {
      const m = f.window.material[i];
      assert.ok(m.isMeshBasicMaterial && m.transparent && m.forceSinglePass);
      assert.ok(!(m.transmission > 0) && !m.envMap && !m.map && !m.depthWrite);
      assert.ok(m.opacity > 0 && m.opacity < .08);
    }
    assert.ok(f.window.material[1].isMeshStandardMaterial);
    assert.equal(f.window.material[1].color.getHex(), frame.color.getHex());
    const displayed = f.window.material, versions = displayed.map(m => m.version);
    f.renderer.shadowMap.needsUpdate = false; f.rig.syncOccluders();
    assert.equal(f.window.material, displayed);
    assert.deepEqual(displayed.map(m => m.version), versions);
    assert.equal(f.renderer.shadowMap.needsUpdate, false);
  }
  for (const [time, material] of daylight) {
    f.rig.apply('night'); f.rig.apply(time);
    assert.equal(f.window.material, material);
    assert.equal(f.window.material[0].transmission, 1);
    assert.equal(f.window.material[0].roughness, .025);
  }
  f.rig.apply('night'); assert.equal(other.material, pane); assert.equal(pane.transmission, 1);
  f.rig.dispose(); assert.equal(f.window.material, slots);
});
test('night window captures visible interior once and reuses it across camera-only draws', () => {
  const f = fixture(), view = new THREE.PerspectiveCamera(), original = new THREE.WebGLRenderTarget();
  const helper = new THREE.Group(); f.scene.add(helper);
  let target = original, draws = 0;
  Object.assign(f.renderer, {
    extensions: {has: () => false}, xr: {enabled: false},
    getRenderTarget: () => target, setRenderTarget: next => {target = next;},
    getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    render(_scene, camera) {
      draws++;
      assert.ok(camera !== view && target !== original);
      assert.equal(helper.visible, false); assert.equal(f.window.material.visible, false);
      assert.equal(f.renderer.shadowMap.needsUpdate, false);
    },
  });
  f.rig.apply('night');
  const draw = () => f.window.material.onBeforeRender(f.renderer, f.scene, view, f.window.geometry, f.window);
  assert.equal(draws, 0); draw(); view.position.x = 2; draw();
  assert.equal(draws, 1); assert.deepEqual(f.rig.snapshot().windowReflection.size, [512, 256]);
  assert.equal(target, original); assert.ok(f.window.visible && helper.visible && f.renderer.shadowMap.needsUpdate);
  f.scene.environment = new THREE.Texture(); draw(); assert.equal(draws, 2);
  f.rig.invalidateWindowReflection(); draw(); draw(); assert.equal(draws, 3);
  f.rig.setIndoor({power: false, angle: 100}); draw(); assert.equal(draws, 3);
  f.rig.setIndoor({power: true, angle: 100}); draw(); assert.equal(draws, 4);
  const clear = f.window.material.opacity; setSeeThrough(f.window, true, .08);
  assert.equal(f.window.material.opacity, clear * .08);
  draw(); assert.equal(draws, 4);
  f.rig.dispose(); original.dispose();
});

test('overview and walk share a complete night reflection without stored furniture or editor tints', () => {
  const photoSource = new THREE.MeshStandardMaterial({emissive: 0xffffff});
  const f = fixture({backdropMaterials: [photoSource]});
  const lamp = f.room.getObjectByName('Lamp0'), photo = f.room.getObjectByName('DaylightBackdrop');
  const chair = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const imported = {importMaterials: createImportMaterials(THREE, chair)};
  const stored = chair.clone(); stored.visible = lamp.visible = false; f.room.add(chair, stored);
  const selected = {material: m => {const copy = m.clone(); copy.color.set(0x00ff00); return copy;}};
  f.rig.apply('night');
  for (const mesh of [chair, photo]) setLayer(mesh, 'selected', selected);
  setSeeThrough(f.wall, true);
  const view = new THREE.PerspectiveCamera(), captures = [];
  Object.assign(f.renderer, {xr: {enabled: false}, extensions: {has: () => false},
    getRenderTarget: () => null, setRenderTarget() {}, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
    render() {
      captures.push(chair.material.type);
      assert.ok(f.roof.visible && lamp.visible && !stored.visible);
      assert.equal(f.window.material.visible, false);
      assert.equal(photo.material[0].color.getHex(), 0x152339);
      assert.equal(chair.material.color.getHex(), 0xffffff);
      assert.equal(f.wall.material.transparent, false);
    }});
  const draw = () => f.window.material.onBeforeRender(f.renderer, f.scene, view, f.window.geometry, f.window);
  draw();
  assert.ok(!f.roof.visible && !lamp.visible && f.window.material.visible);
  assert.equal(chair.material.color.getHex(), 0x00ff00); assert.ok(f.wall.material.transparent);
  lamp.visible = f.roof.visible = true; setSeeThrough(f.wall, false);
  for (const mesh of [chair, photo]) setLayer(mesh, 'selected', null);
  draw(); assert.deepEqual(captures, ['MeshBasicMaterial']);
  const entities = new Map([['chair', imported]]);
  assert.deepEqual(updateImportLighting(entities, 'pbr', f.rig), [imported]);
  draw(); draw();
  assert.deepEqual(updateImportLighting(entities, 'pbr', f.rig), []); draw();
  assert.deepEqual(captures, ['MeshBasicMaterial', 'MeshStandardMaterial']);
  imported.importMaterials.dispose(); f.rig.dispose();
});

test('snapshots rebuild the editor fixtures in every preset and apply noon exterior scaling once', async () => {
  const photo = new THREE.MeshStandardMaterial({emissive: 0xffffff, emissiveIntensity: 1.6});
  const f = fixture({luminaires: ['Lamp0'], backdropMaterials: [photo, new THREE.MeshBasicMaterial()]});
  const backdrop = f.room.getObjectByName('DaylightBackdrop');
  for (const preset of ['physical', 'noon', 'balanced', 'morning', 'afternoon', 'night']) {
    await f.rig.apply(preset);
    const snapshot = captureRoom(THREE, {room: f.room, config: f.config, walls: f.walls, entities: new Map(), layout: {},
      wallOwner: name => ['Window0', 'Wall1'].includes(name) ? 'Wall1' : null, lighting: {preset}});
    const scene = new THREE.Scene(); scene.background = new THREE.Color(); scene.add(snapshot.root);
    const shared = snapshot.root.getObjectByName('DaylightBackdrop');
    const renderer = {shadowMap: {}}, visibility = createRoomVisibility(THREE, snapshot.root);
    assert.deepEqual(snapshot.metadata.lighting.luminaires, ['Lamp0']);
    if (preset === 'noon') assert.equal(shared.material[0].emissiveIntensity, 1.6);
    const mobile = createMobileLighting(THREE, {scene, renderer, visibility, bounds: f.bounds, floorY: 0});
    await mobile.ready;
    const state = mobile.snapshot();
    assert.deepEqual(state.luminaires, f.rig.snapshot().luminaires);
    if (preset === 'physical') {
      assert.deepEqual(state.physical.lights.filter(l => l.kind === 'luminaire'), f.rig.snapshot().physical.lights.filter(l => l.kind === 'luminaire'));
      assert.ok(state.physical.lights.some(l => l.kind === 'luminaire'));
    }
    if (preset === 'noon') {
      assert.equal(shared.material[0].emissiveIntensity, backdrop.material[0].emissiveIntensity);
      assert.equal(shared.material[1].color.r, backdrop.material[1].color.r);
      assert.equal(backdrop.material[0].emissiveIntensity, 1.6 * .95);
    }
    mobile.dispose(); snapshot.dispose();
  }
  f.rig.dispose();
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
  assert.equal(f.scene.environmentIntensity, .08); assert.equal(f.hemi.intensity, 1.05);
  assert.equal(f.scene.children.filter(light => light.isLight && light.visible && light.castShadow).length, 1);
  assert.equal(f.rig.snapshot().lamp.source, 'room-bounds-center');
  assert.deepEqual(f.rig.snapshot().luminaires, []); assert.equal(f.rig.fixtures, 0);
  assert.deepEqual(f.rig.snapshot().lights.map(light => [light.source, light.share, light.castShadow]), [['fallback', 1, true]]);
  assert.equal(f.scene.children.filter(object => object.isMesh && object.geometry.type === 'SphereGeometry').length, 1, 'the invented lamp keeps its marker');
  assert.ok(f.window.material.isMeshBasicMaterial && !(f.window.material.transmission > 0));
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
    assert.deepEqual({sun: f.sun.intensity, fill: f.fill.intensity, hemisphere: f.hemi.intensity, environment: f.scene.environmentIntensity},
      time === 'night' ? {...daylight, hemisphere: 0, environment: 0} : daylight);
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
