import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {PHYSICAL, illuminantD, physicalExposure, planLocalLights, pointCandela, roomLightParts, spotCandela, sunDirection} from '../physical-lighting.mjs';
import {createTimeLighting} from '../time-lighting.mjs';

const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('exposure, light units and colours match the phone (Filament) values', () => {
  const {ev100, exposure} = physicalExposure();
  near(ev100, 5.937, .001); near(exposure, .0136, .0001);
  near(pointCandela(60), 381.9, .1); near(spotCandela(20), 278.9, .1);
  const [r, g, b] = illuminantD(6500); near(r, 1, .02); near(g, 1, .03); near(b, 1, .05);
  const warm = illuminantD(4700); assert.equal(warm[0], 1); assert.ok(warm[2] < .8);
  const sun = sunDirection(); near(Math.hypot(...sun), 1, 1e-9); near(Math.asin(-sun[1]) * 180 / Math.PI, PHYSICAL.sunElevation, 1e-9);
});

test('plan puts one lamp under each ceiling, then one spot inside each window group, capped at four', () => {
  const room = {min: [-2, 0, -2], max: [2, 3, 2]};
  const parts = [
    {name: 'Ceiling0', kind: 'ceiling', box: {min: [-2, 2.95, -2], max: [2, 3, 2]}},
    {name: 'Window0', kind: 'window', box: {min: [-1, 1, -2], max: [1, 2, -1.95]}},
    {name: 'Window0_frame', kind: 'window', box: {min: [-1.1, .9, -2], max: [1.1, 2.1, -1.9]}},
  ];
  const [ceiling, window, ...rest] = planLocalLights(room, parts);
  assert.equal(rest.length, 0);
  assert.deepEqual(ceiling.position, [0, 2.95 - PHYSICAL.ceilingDrop, 0]);
  near(ceiling.falloff, Math.hypot(4, 3, 4) * 1.5, 1e-9);
  assert.equal(window.name, 'Window0+Window0_frame');
  near(window.position[2], -1.95 + PHYSICAL.windowInset, 1e-9);
  assert.ok(window.direction[2] > 0 && window.direction[1] < 0);
  const many = Array.from({length: 6}, (_, i) => ({...parts[0], name: `Ceiling${i}`}));
  assert.equal(planLocalLights(room, [...many, parts[1]]).length, PHYSICAL.maxLocalLights);
  assert.ok(planLocalLights(room, [...many, parts[1]]).every(light => light.kind === 'ceiling'));
});

test('room labels decide ceilings and windows; curtains, grids and exterior photos are skipped', () => {
  const room = new THREE.Group();
  const add = (name, parent = room, y = 1) => {const mesh = new THREE.Mesh(new THREE.BoxGeometry(.5, .5, .5)); mesh.name = name; mesh.position.y = y; parent.add(mesh); return mesh;};
  add('Ceiling0', room, 3); const grid = add('CeilingGrid0', room, 3); add('Ceiling tee', grid, 0);
  const window = add('Window0'); add('Window_Frame', window, 0); add('WindowDrape0'); add('WindowDaylightBackdrop0'); add('Wall0');
  room.updateMatrixWorld(true);
  const labels = {Ceiling0: '天花板', CeilingGrid0: '吊顶格栅', Window0: '窗户', WindowDrape0: '窗户', WindowDaylightBackdrop0: '窗外景', Wall0: '墙面'};
  const {parts, shell} = roomLightParts(THREE, {room, config: {label: name => labels[name] || null}});
  assert.deepEqual(parts.map(part => part.name), ['Ceiling0', 'Window0']);
  assert.ok(shell);
  // Without labels, the phone's name prefixes apply.
  const plain = roomLightParts(THREE, {room, config: {label: () => null}}).parts.map(part => part.name);
  assert.deepEqual(plain, ['Ceiling0', 'CeilingGrid0', 'Window0', 'WindowDaylightBackdrop0']);
});

test('物理光照 preset replaces the other rigs with pre-exposed physical lights and restores them on leave', () => {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ede5');
  const room = new THREE.Group(); scene.add(room);
  const box = (name, dimensions, position, material = new THREE.MeshStandardMaterial()) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...dimensions), material); mesh.name = name; mesh.position.set(...position); room.add(mesh); return mesh;
  };
  box('Wall1', [4, 3, .1], [0, 1.5, -2]);
  box('Ceiling0', [4, .1, 4], [0, 3, 0]).visible = false;
  const glass = box('Window0', [2, 1.5, .05], [0, 1.5, -1.9], new THREE.MeshPhysicalMaterial({transmission: 1, emissive: 0x999999}));
  room.updateMatrixWorld(true);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x87919d, 1.1), sun = new THREE.DirectionalLight(0xffffff, 3), fill = new THREE.DirectionalLight(0xffffff, .65);
  sun.castShadow = true; scene.add(hemi, sun, sun.target, fill);
  const renderer = {shadowMap: {needsUpdate: false}, toneMappingExposure: 1.1};
  const config = {openings: {Wall1: ['Window0']}, label: name => ({Window0: '窗户', Ceiling0: '天花板'})[name], isCeiling: name => name === 'Ceiling0'};
  const rig = createTimeLighting(THREE, {renderer, scene, room, config, walls: [{name: 'Wall1', n: [0, 0, 1]}],
    bounds: new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 3, 2)), floorY: 0, ceilingY: 3,
    profile: {key: 3, fill: .65, hemisphere: 1.1, environment: .35, exposure: 1.1}});
  rig.apply('noon'); rig.apply('physical');
  const state = rig.snapshot(), pre = physicalExposure().exposure / 1.1;
  near(state.physical.preExposure, pre, 1e-12);
  assert.equal(hemi.visible, false); assert.equal(fill.visible, false); assert.equal(sun.visible, true);
  near(sun.intensity, PHYSICAL.sunLux * pre, 1e-9); near(scene.environmentIntensity, PHYSICAL.environment * pre, 1e-12);
  const direction = sun.target.position.clone().sub(sun.position).normalize().toArray();
  sunDirection().forEach((value, k) => near(direction[k], value, 1e-9));
  assert.equal(state.windowLight.visible, false); assert.equal(state.lamp?.visible ?? false, false);
  const physical = scene.children.filter(light => light.userData.lightingRole?.startsWith('physical-'));
  assert.deepEqual(physical.map(light => light.type).sort(), ['PointLight', 'SpotLight']);
  assert.ok(physical.every(light => light.visible && light.castShadow && light.decay === 2));
  near(physical.find(light => light.isPointLight).intensity, pointCandela(60) * pre, 1e-9);
  assert.equal(glass.material.emissiveIntensity, 1); assert.equal(glass.castShadow, false);
  rig.setIndoor({power: false});
  assert.equal(physical.find(light => light.isPointLight).visible, false);
  assert.equal(physical.find(light => light.isSpotLight).visible, true);
  rig.setIndoor({power: true});
  for (let i = 0; i < 3; i++) {rig.apply('night'); rig.apply('physical');}
  assert.equal(scene.children.filter(light => light.userData.lightingRole?.startsWith('physical-')).length, 2);
  rig.apply('noon');
  assert.equal(hemi.visible, true); assert.ok(physical.every(light => !light.visible));
  assert.equal(sun.intensity, 4.2); assert.equal(scene.environmentIntensity, .1);
  rig.dispose(); assert.ok(physical.every(light => light.parent === null));
});

test('sky light on the outside of the room survives see-through clones and gives back changed materials', async () => {
  const {exteriorShell} = await import('../physical-lighting.mjs');
  const {setSeeThrough} = await import('../wall-visibility.mjs');
  const {ownMaterial, setOwnMaterial} = await import('../material-layers.mjs');
  const wall = new THREE.Mesh(new THREE.BoxGeometry(4, 3, .1), new THREE.MeshStandardMaterial());
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(.2, .2, .2), new THREE.MeshBasicMaterial());
  const sofa = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial());
  const original = wall.material;
  const shell = exteriorShell(THREE, {meshes: [{mesh: wall, inward: {n: [0, 0, 1], d: -2}}, {mesh: lamp, inward: null}, {mesh: sofa, inward: null}],
    ceilingHeight: 2.5, own: ownMaterial, setOwn: setOwnMaterial});
  assert.equal(shell.meshes, 2);
  assert.match(THREE.ShaderChunk.lights_fragment_end, /ROOM_EXTERIOR/);
  shell.set(true);
  assert.notEqual(wall.material, original); assert.ok(wall.material.isMeshStandardMaterial);
  assert.deepEqual(wall.material.userData.roomExterior.inward, [0, 0, 1]); assert.equal(wall.material.defines.ROOM_EXTERIOR, '');
  assert.equal(sofa.material.defines.PHYSICAL, ''); assert.deepEqual(sofa.material.userData.roomExterior.inward, [0, 0, 0]);
  setSeeThrough(wall, true);
  assert.ok(wall.material.transparent); assert.equal(wall.material.defines.ROOM_EXTERIOR, ''); assert.deepEqual(wall.material.userData.roomExterior.inward, [0, 0, 1]);
  const shader = {uniforms: {}}; wall.material.onBeforeCompile(shader);
  assert.deepEqual(shader.uniforms.roomInward.value, [0, 0, 1]); assert.equal(shader.uniforms.roomWallD.value, -2); assert.equal(shader.uniforms.roomCeilingY.value, 2.5);
  setSeeThrough(wall, false);
  const lit = new THREE.MeshStandardMaterial(); setOwnMaterial(sofa, lit);
  shell.set(false);
  assert.equal(wall.material, original); assert.equal(sofa.material, lit);
  shell.set(true); assert.equal(sofa.material.defines.ROOM_EXTERIOR, ''); assert.notEqual(sofa.material, lit);
  shell.dispose(); assert.equal(sofa.material, lit);
});

test('things on a wall take its direction; furniture standing off the wall does not', async () => {
  const {wallInward} = await import('../physical-lighting.mjs');
  const room = new THREE.Group();
  const add = (name, size, position) => {const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size)); mesh.name = name; mesh.position.set(...position); room.add(mesh); return mesh;};
  // Wall0's inner face is the plane z = -2 facing +z.
  const wall = add('Wall0', [4, 3, .1], [0, 1.5, -2.05]), door = add('Door0', [.9, 2, .06], [1, 1, -2.02]);
  const skirting = add('Skirting', [4, .1, .02], [0, .05, -1.99]), sofa = add('Sofa', [2, .8, .9], [0, .4, -1.5]);
  const far = add('Picture', [.5, .5, .02], [9, 1.5, -1.99]);
  room.updateMatrixWorld(true);
  const inward = wallInward(THREE, {room, walls: [{name: 'Wall0', n: [0, 0, 1], d: -2, tangent: [-1, 0, 0], bounds: [[-2, 0], [2, 3]]}]});
  assert.deepEqual([wall, door, skirting].map(mesh => inward.get(mesh)), [{n: [0, 0, 1], d: -2}, {n: [0, 0, 1], d: null}, {n: [0, 0, 1], d: null}]);
  assert.equal(inward.has(sofa), false); assert.equal(inward.has(far), false);
});

test('a ceiling is its own surface, not the curtains nested under it; a ceiling of several meshes keeps all of them', async () => {
  const {surfaceBox} = await import('../physical-lighting.mjs');
  const room = new THREE.Group();
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(4, .05, 4)); ceiling.name = 'Ceiling0'; ceiling.position.y = 3; room.add(ceiling);
  // The replay's model hangs a curtain from the ceiling node, reaching the floor.
  const curtain = new THREE.Mesh(new THREE.BoxGeometry(2, 2.9, .05)); curtain.name = 'Curtain0'; curtain.position.set(0, -1.5, -1.9); ceiling.add(curtain);
  const grid = new THREE.Group(); grid.name = 'Ceiling1'; room.add(grid);
  for (const y of [2.8, 2.9]) {const tile = new THREE.Mesh(new THREE.BoxGeometry(1, .02, 1)); tile.position.set(3, y, 0); grid.add(tile);}
  room.updateMatrixWorld(true);
  const labels = {Ceiling0: '天花板', Ceiling1: '天花板'};
  const {parts} = roomLightParts(THREE, {room, config: {label: name => labels[name] || null}});
  near(parts.find(part => part.name === 'Ceiling0').box.min[1], 2.975, 1e-6);
  near(parts.find(part => part.name === 'Ceiling1').box.min[1], 2.79, 1e-6);
  near(surfaceBox(THREE, ceiling).min.y, 2.975, 1e-6);
  near(new THREE.Box3().setFromObject(ceiling).min.y, .05, 1e-6);
  // The generated lamp hangs under the ceiling itself, not at the curtain's foot.
  near(planLocalLights({min: [-2, 0, -2], max: [2, 3, 2]}, parts.slice(0, 1))[0].position[1], 2.975 - PHYSICAL.ceilingDrop, 1e-6);
});
