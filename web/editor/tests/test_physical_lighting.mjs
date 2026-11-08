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
