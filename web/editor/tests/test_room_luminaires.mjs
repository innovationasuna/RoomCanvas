import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {areaFactor, ceilingLuminaires, findLuminaires, fitRectangle, floorArea, LUMINAIRE_LIGHTS, luminaireShape, luminaireWatts,
  namedLuminaires, planLuminaireLights} from '../room-luminaires.mjs';
import {createTimeLighting} from '../time-lighting.mjs';
import {PHYSICAL, physicalExposure, spotCandela} from '../physical-lighting.mjs';
import {roomConfig, categoryLabel} from '../room-catalog.mjs';

const near = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const sum = values => values.reduce((a, b) => a + b, 0);

// A strip: housing, with a slightly smaller glowing diffuser under it, turned about Y.
function strip(name, {length = 6.8, width = .12, at = [0, 2.98, 0], turn = 0, glow = 3} = {}) {
  const group = new THREE.Group(); group.name = name;
  const housing = new THREE.Mesh(new THREE.BoxGeometry(length + .05, .026, width + .02), new THREE.MeshStandardMaterial());
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(length, .008, width), new THREE.MeshStandardMaterial({emissive: 0xfff2dd, emissiveIntensity: glow}));
  diffuser.position.y = -.013; group.add(housing, diffuser); group.userData.diffuser = diffuser.material;
  group.position.set(...at); group.rotation.y = turn;
  return group;
}
// Inner faces of an axis-aligned rectangular room, as placement.wallTargets() describes them.
const rectangleWalls = ([x0, z0], [x1, z1], h = 3) => [
  {name: 'Wall0', n: [0, 0, 1], d: z0, tangent: [-1, 0, 0], bounds: [[-x1, 0], [-x0, h]]},
  {name: 'Wall1', n: [0, 0, -1], d: -z1, tangent: [1, 0, 0], bounds: [[x0, 0], [x1, h]]},
  {name: 'Wall2', n: [1, 0, 0], d: x0, tangent: [0, 0, 1], bounds: [[z0, 0], [z1, h]]},
  {name: 'Wall3', n: [-1, 0, 0], d: -x1, tangent: [0, 0, -1], bounds: [[-z1, 0], [-z0, h]]},
];

test('the emitting rectangle of a turned strip keeps its length, width and direction', () => {
  for (const degrees of [0, 17.2, 44.2, 90, 135]) {
    const turn = degrees * Math.PI / 180, object = strip('LinearLight0', {at: [3, 2.98, -1], turn});
    const shape = luminaireShape(object);
    near(shape.length, 6.8, 1e-6); near(shape.width, .12, 1e-6);
    // Rotating about +Y takes the local x axis to (cos, 0, -sin); the fitted axis may point either way.
    near(Math.abs(shape.axis[0] * Math.cos(turn) - shape.axis[1] * Math.sin(turn)), 1, 1e-9);
    near(shape.center[0], 3, 1e-6); near(shape.center[2], -1, 1e-6); near(shape.bottom, 2.98 - .013 - .004, 1e-6);
  }
  // Its axis-aligned box at 44° would be nearly square, as in room-3934.
  const box = new THREE.Box3().setFromObject(strip('L', {length: 6.6, width: .082, turn: 44.2 * Math.PI / 180})).getSize(new THREE.Vector3());
  assert.ok(box.x > 4.5 && box.z > 4.5);
  // A square panel turned 5°: principal axes are undefined for it; the fitted rectangle is still the panel.
  const panel = luminaireShape(strip('CeilingLight0', {length: .565, width: .565, turn: 5 * Math.PI / 180}));
  near(panel.length, .565, 1e-6); near(panel.width, .565, 1e-6); near(panel.area, .565 ** 2, 1e-6);
  // Without a glowing part (a downlight's rim and recess), all its meshes count.
  const plain = strip('Downlight0', {length: .068, width: .068, glow: 0});
  near(luminaireShape(plain).length, .068 + .05, 1e-6);
  assert.equal(fitRectangle([]), null);
});

test('ceiling lamps come from the object list; table lamps, wall lights and unmounted fixtures do not', () => {
  const object = (node, category, mount) => ({node, category, mount});
  assert.deepEqual(ceilingLuminaires([object('Downlight0', 'light', 'ceiling'), object('CeilingLight0', 'light_fixture', 'ceiling'),
    object('LinearLight0', 'luminaire', 'ceiling'), object('DeskLamp0', 'lamp', 'floor'), object('WallLight0', 'light', 'wall'),
    object('Spare0', 'light_fixture', null), object('Sprinkler0', 'sprinkler', 'ceiling')]), ['Downlight0', 'CeilingLight0', 'LinearLight0']);
  assert.equal(categoryLabel('luminaire'), '灯');
  const doc = {format: 'roomcanvas-room-objects', version: 1, scene: 's', floor: 'Floor0', walls: [], ceiling: ['Ceiling0'], openings: {}, groups: [],
    objects: [{id: 'Floor0', node: 'Floor0', category: 'floor', role: 'structure', group: 'Floor0', bbox_min: [0, 0, 0], bbox_max: [1, 0, 1]},
      {id: 'Ceiling0', node: 'Ceiling0', category: 'ceiling', role: 'structure', group: 'Ceiling0', bbox_min: [0, 3, 0], bbox_max: [1, 3, 1]},
      {id: 'LinearLight0', node: 'LinearLight0', category: 'luminaire', role: 'fixture', group: 'LinearLight0', mount: 'ceiling', bbox_min: [0, 2.9, 0], bbox_max: [6, 2.95, .1]}]};
  const config = roomConfig(doc);
  assert.deepEqual(config.luminaires, ['LinearLight0']); assert.equal(config.label('LinearLight0'), '灯');
  // Listed but missing from the model, or without geometry: not a luminaire.
  const room = new THREE.Group(); room.add(new THREE.Group());
  assert.deepEqual(findLuminaires(room, ['LinearLight0']), []);
});

test('the replay finds luminaires by name under or at the ceiling, not switches, backdrops or lamps on the floor', () => {
  const root = new THREE.Group(), add = (parent, object) => {parent.add(object); return object;};
  const box = (name, size, at) => {const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size)); mesh.name = name; mesh.position.set(...at); return mesh;};
  add(root, box('Floor0', [8, .1, 8], [0, -.05, 0]));
  const ceiling = add(root, box('Ceiling0', [8, .05, 8], [0, 3.02, 0])), wall = add(root, box('Wall0', [8, 3, .1], [0, 1.5, -4]));
  add(ceiling, strip('LinearLight0', {at: [0, -.04, 0]}));                     // under the ceiling node
  add(root, strip('CeilingLight0', {length: .6, width: .6, at: [2, 2.99, 2]}));  // at the ceiling, named like one
  add(wall, box('RulesLightSwitch', [.1, .1, .02], [0, -.3, .06]));
  add(root, box('WindowDaylightBackdrop0', [2, 2.9, .02], [3, 1.5, -3.9]));      // reaches the ceiling from the floor
  add(root, box('TableLamp0', [.3, .5, .3], [1, .9, 1]));
  root.updateMatrixWorld(true);
  const label = name => (/^Ceiling/i.test(name) ? '天花板' : /^Wall\d+$/.test(name) ? '墙面' : /^Floor\d+$/.test(name) ? '地面' : null);
  assert.deepEqual(namedLuminaires(THREE, root, {label, ceilingY: 3}), ['LinearLight0', 'CeilingLight0']);
});

test('the light plan spreads spots along each luminaire, shares sum to one and the cap holds', () => {
  const luminaire = (name, length, width, center = [0, 3, 0], axis = [1, 0]) => ({name, center, axis, length, width, bottom: center[1], area: length * width});
  const turned = [Math.cos(.3), Math.sin(.3)];
  const one = planLuminaireLights([luminaire('L', 6.8, .12, [1, 3, 2], turned)]);
  assert.equal(one.length, 2); near(sum(one.map(light => light.share)), 1);
  for (const [k, light] of one.entries()) {
    const offset = (k === 0 ? -1 : 1) * 6.8 / 4;
    near(light.position[0], 1 + turned[0] * offset); near(light.position[2], 2 + turned[1] * offset);
    near(light.position[1], 3 - LUMINAIRE_LIGHTS.drop);
  }
  const long = planLuminaireLights([luminaire('L', 10, .1)]);
  assert.deepEqual(long.map(light => light.position[0].toFixed(6)), [-10 / 3, 0, 10 / 3].map(v => v.toFixed(6)));
  assert.equal(planLuminaireLights([luminaire('L', 30, .1)]).length, 3);
  assert.equal(planLuminaireLights([luminaire('D', .07, .07)]).length, 1);
  // Four equal strips want 8 spots: the two in the middle give one up each, so the plan stays symmetric.
  const row = [0, 1, 2, 3].map(i => luminaire(`L${i}`, 6.6, .08, [0, 3, i * 2]));
  const capped = planLuminaireLights(row);
  assert.equal(capped.length, 6); near(sum(capped.map(light => light.share)), 1);
  assert.deepEqual(row.map(({name}) => capped.filter(light => light.luminaire === name).length), [2, 1, 1, 2]);
  const shadows = capped.filter(light => light.castShadow);
  assert.equal(shadows.length, 3);
  assert.ok(['L1', 'L2'].every(name => shadows.some(light => light.luminaire === name)), 'the largest shares cast shadows');
  // Nine downlights: six kept (the largest), the others' share and watts go to the nearest kept spot.
  const many = Array.from({length: 9}, (_, i) => luminaire(`D${i}`, i < 6 ? .1 : .07, i < 6 ? .1 : .07, [i, 3, 0]));
  const kept = planLuminaireLights(many);
  assert.equal(kept.length, 6); near(sum(kept.map(light => light.share)), 1);
  assert.deepEqual(kept.map(light => light.luminaire), ['D0', 'D1', 'D2', 'D3', 'D4', 'D5']);
  assert.deepEqual(kept[5].folded, ['D6', 'D7', 'D8']);
  near(sum(kept.map(light => light.watts)), sum(many.map(({area, length}) => luminaireWatts(area, length))));
  assert.deepEqual(planLuminaireLights([]), []);
});

test('the floor area comes from the walls, turned or not, and falls back to the room box', () => {
  const walls = rectangleWalls([-2, -2.5], [2, 2.5]);
  near(floorArea(walls, 100), 20); near(floorArea([...walls].reverse(), 100), 20);
  // The same room turned by 30° about its corner: its box is larger, the floor is not.
  const turn = Math.PI / 6, c = Math.cos(turn), s = Math.sin(turn), rotate = ([x, , z]) => [x * c + z * s, 0, -x * s + z * c];
  const turned = walls.map(wall => ({...wall, n: rotate(wall.n), tangent: rotate(wall.tangent)}));
  near(floorArea(turned, 100), 20);
  assert.equal(floorArea([{name: 'Wall1', n: [0, 0, 1]}], 22), 22);
  assert.equal(floorArea(walls, 12), 12, 'never more than the room box');
  assert.equal(areaFactor(14), 1); near(areaFactor(80), 4 ** .75);
});

function lit({luminaires = [], walls, low = [-2, 0, -2.5], high = [2, 3, 2.5], indoor} = {}) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#e9ede5');
  const room = new THREE.Group(); scene.add(room);
  const add = (name, size, at, material = new THREE.MeshStandardMaterial()) => {const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material); mesh.name = name; mesh.position.set(...at); room.add(mesh); return mesh;};
  add('Ceiling0', [high[0] - low[0], .05, high[2] - low[2]], [(low[0] + high[0]) / 2, high[1] + .025, (low[2] + high[2]) / 2]).visible = false;
  // Five windows on one wall; Window2, then Window4, are the largest.
  for (const [i, x] of [-1.8, -1, 0, 1, 1.8].entries()) add(`Window${i}`, [[.5, .5, 1.2, .5, .7][i], 1.2, .05], [x, 1.5, low[2] + .03], new THREE.MeshPhysicalMaterial({transmission: 1}));
  const fixtures = luminaires.map(options => {const object = strip(options.name, options); room.add(object); return object;});
  room.updateMatrixWorld(true);
  const hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight(), fill = new THREE.DirectionalLight();
  sun.castShadow = true; scene.add(hemi, sun, sun.target, fill);
  const labels = {Ceiling0: '天花板', ...Object.fromEntries([0, 1, 2, 3, 4].map(i => [`Window${i}`, '窗户'])), ...Object.fromEntries(luminaires.map(({name}) => [name, '灯']))};
  const config = {openings: {Wall0: [0, 1, 2, 3, 4].map(i => `Window${i}`)}, label: name => labels[name] || null, isCeiling: name => name === 'Ceiling0',
    luminaires: luminaires.map(({name}) => name)};
  const bounds = new THREE.Box3(new THREE.Vector3(...low), new THREE.Vector3(...high));
  const rig = createTimeLighting(THREE, {renderer: {shadowMap: {needsUpdate: false}, toneMappingExposure: 1}, scene, room, config,
    walls: walls ?? rectangleWalls([low[0], low[2]], [high[0], high[2]], high[1]), bounds, floorY: low[1], ceilingY: high[1],
    profile: {key: 3, fill: .65, hemisphere: 1.1, environment: .35, exposure: 1}, indoor});
  return {rig, scene, fixtures};
}
const indoorSpots = scene => scene.children.filter(light => light.userData.lightingRole === 'indoor');
const markers = scene => scene.children.filter(object => object.isMesh && object.geometry.type === 'SphereGeometry');

test('lights stand at the luminaires: one lamp in a 20 m² room is as bright as the central lamp, a larger room gets more', () => {
  const central = lit(); central.rig.apply('night');
  const today = central.rig.snapshot().lamp.intensity;
  assert.equal(central.rig.snapshot().lights[0].source, 'fallback'); assert.equal(markers(central.scene).length, 1);
  const one = lit({luminaires: [{name: 'Panel0', length: .6, width: .6, at: [1, 2.99, 1]}]}); one.rig.apply('night');
  let state = one.rig.snapshot();
  near(state.floorArea, 20); assert.equal(state.luminaires.length, 1); assert.equal(one.rig.fixtures, 1);
  assert.equal(state.lights.length, 1); assert.equal(state.lights[0].source, 'luminaire'); assert.equal(state.lamp.source, 'luminaire');
  near(state.lights[0].intensity, today, 1e-9);
  near(state.lights[0].position[0], 1); near(state.lights[0].position[2], 1);
  assert.equal(markers(one.scene).length, 0, 'the fixture itself is seen, no marker');
  const spot = indoorSpots(one.scene)[0];
  assert.deepEqual([spot.target.position.x, spot.target.position.y, spot.target.position.z], [spot.position.x, 0, spot.position.z]);
  assert.equal(spot.castShadow, true); assert.deepEqual(spot.shadow.mapSize.toArray(), [LUMINAIRE_LIGHTS.shadowMap, LUMINAIRE_LIGHTS.shadowMap]);
  // 80 m² with three strips: (80 / 20) ** .75 times the power, by emitting area, at most three shadows.
  const big = lit({low: [-5, 0, -4], high: [5, 3, 4], luminaires: [0, 1, 2].map(i => ({name: `LinearLight${i}`, length: 6.8, width: .12, at: [0, 2.98, -2.5 + i * 2.5], turn: .3}))});
  big.rig.apply('night'); state = big.rig.snapshot();
  near(state.floorArea, 80);
  // The central lamp's height term: 3 m ceiling, the lamp .18 m under it.
  const central80 = Math.max(4, (3 - .18) ** 2 * 4.5);
  near(sum(state.lights.map(light => light.intensity)), central80 * 4 ** .75, 1e-9);
  assert.equal(state.lights.length, 6); near(sum(state.lights.map(light => light.share)), 1);
  assert.equal(indoorSpots(big.scene).filter(light => light.visible && light.castShadow).length, 3);
  big.rig.apply('noon');
  assert.equal(indoorSpots(big.scene).filter(light => light.castShadow).length, 0, 'daylight keeps the sun and window shadows only');
  near(sum(big.rig.snapshot().lights.map(light => light.intensity)), central80 * 4 ** .75 * .07, 1e-9);
  for (let i = 0; i < 3; i++) {big.rig.apply('night'); big.rig.apply('physical');}
  assert.equal(indoorSpots(big.scene).length, 6);
  big.rig.setIndoor({power: true, angle: 100});
  assert.ok(indoorSpots(big.scene).every(light => Math.abs(light.angle * 360 / Math.PI - 100) < 1e-9));
  for (const f of [central, one, big]) f.rig.dispose();
  assert.equal(indoorSpots(big.scene).length, 0);
});

test('物理光照 lights the luminaires by their area, as spots over the cone, within the four local shadows', () => {
  const strips = [0, 1].map(i => ({name: `LinearLight${i}`, length: 6.8, width: .12, at: [0, 2.98, -1.5 + i * 3]}));
  const f = lit({low: [-5, 0, -4], high: [5, 3, 4], luminaires: strips});
  f.rig.apply('physical');
  let lights = f.rig.snapshot().physical.lights;
  const luminaires = lights.filter(light => light.kind === 'luminaire'), pre = physicalExposure().exposure;
  assert.equal(lights.filter(light => light.kind === 'ceiling').length, 0, 'no generated lamp under the ceiling');
  assert.equal(luminaires.length, 4);
  // Three shadowed spots leave one shadow for the largest window; at most two windows are lit.
  assert.deepEqual(lights.filter(light => light.kind === 'window').map(light => [light.name, light.castShadow]), [['Window2', true], ['Window4', false]]);
  assert.equal(lights.filter(light => light.castShadow).length, PHYSICAL.maxLocalLights);
  assert.equal(f.rig.snapshot().physical.shadowCasters.length, PHYSICAL.maxLocalLights);
  assert.equal(f.scene.children.filter(light => light.userData.lightingRole?.startsWith('physical-') && light.castShadow).length, PHYSICAL.maxLocalLights);
  // A panel by its area, a strip by its length (by area it would be a third of an LED strip's watts).
  near(luminaireWatts(.32, .565), 32, 1e-9); near(luminaireWatts(.816, 6.8), 204, 1e-9);
  assert.equal(luminaireWatts(.001, .03), 10); assert.equal(luminaireWatts(3, 12), 250);
  for (const light of luminaires) {
    near(light.watts, 6.8 * 30 / 2, 1e-4);  // the length is fitted to float32 vertices
    near(light.intensity, spotCandela(light.watts, 80) * pre, 1e-9);
  }
  const spots = f.scene.children.filter(light => light.userData.lightingRole === 'physical-luminaire');
  assert.ok(spots.every(spot => spot.isSpotLight && spot.visible && spot.target.position.y < spot.position.y));
  assert.equal(spots.filter(spot => spot.castShadow).length, 3);
  f.rig.setIndoor({power: true, angle: 120});
  lights = f.rig.snapshot().physical.lights;
  near(lights[0].intensity, spotCandela(lights[0].watts, 60) * pre, 1e-9);
  f.rig.setIndoor({power: false, angle: 120});
  assert.ok(spots.every(spot => !spot.visible));
  assert.ok(f.scene.children.filter(light => light.userData.lightingRole === 'physical-window').every(light => light.visible));
  f.rig.dispose();
  // Two panels shadow two spots: both windows get the remaining two shadows.
  const panels = lit({luminaires: [0, 1].map(i => ({name: `Panel${i}`, length: .6, width: .6, at: [-1 + 2 * i, 2.99, 0]}))});
  panels.rig.apply('physical');
  assert.deepEqual(panels.rig.snapshot().physical.shadowCasters, ['luminaire:Panel0', 'luminaire:Panel1', 'window:Window2', 'window:Window4']);
  panels.rig.dispose();
  // Without luminaires everything is as before: one 60 W lamp under the ceiling, then windows, four in all, all shadowed.
  const plain = lit(); plain.rig.apply('physical');
  const before = plain.rig.snapshot().physical.lights;
  assert.deepEqual(before.map(light => [light.kind, light.castShadow]), [['ceiling', true], ['window', true], ['window', true], ['window', true]]);
  assert.deepEqual(before.slice(1).map(light => light.name), ['Window0', 'Window1', 'Window2']);
  plain.rig.dispose();
});

test('物理光照 from small luminaires is never dimmer than the generated 60 W lamp', () => {
  // Four 7 cm downlights would be 4 × 10 W; together they are raised to 60 W, 15 W each.
  const f = lit({luminaires: [0, 1, 2, 3].map(i => ({name: `Downlight${i}`, length: .068, width: .068, at: [-1.5 + i, 2.99, 0]}))});
  f.rig.apply('physical');
  const lights = f.rig.snapshot().physical.lights.filter(light => light.kind === 'luminaire');
  assert.equal(lights.length, 4);
  for (const light of lights) near(light.watts, PHYSICAL.ceilingWatts / 4, 1e-9);
  f.rig.dispose();
  // Above 60 W in total the luminaires keep their own watts.
  const strips = lit({low: [-5, 0, -4], high: [5, 3, 4], luminaires: [{name: 'LinearLight0', length: 6.8, width: .12}]});
  strips.rig.apply('physical');
  near(sum(strips.rig.snapshot().physical.lights.filter(light => light.kind === 'luminaire').map(light => light.watts)), 204, 1e-4);
  strips.rig.dispose();
});

test('the luminaires glow as authored whenever the lights are on and not at all when off, on owned copies only', () => {
  const f = lit({luminaires: [{name: 'LinearLight0', length: 3, width: .1, at: [0, 2.98, 0], glow: 3}]});
  const diffuser = f.fixtures[0].children[1], original = f.fixtures[0].userData.diffuser;
  f.rig.apply('night');
  assert.notEqual(diffuser.material, original); assert.equal(diffuser.material.emissiveIntensity, 3);
  f.rig.setIndoor({power: false});
  assert.equal(diffuser.material.emissiveIntensity, 0);
  f.rig.setIndoor({power: true}); f.rig.apply('noon');
  assert.equal(diffuser.material.emissiveIntensity, 3, 'daylight presets do not dim a switched-on fixture');
  f.rig.apply('balanced'); assert.equal(diffuser.material.emissiveIntensity, 3);
  f.rig.apply('physical');
  assert.equal(diffuser.material.emissiveIntensity, 3, '物理光照 shows the lit fixture through its sky-light copy');
  f.rig.setIndoor({power: false});
  assert.equal(diffuser.material.emissiveIntensity, 0);
  f.rig.apply('night'); assert.equal(diffuser.material.emissiveIntensity, 0);
  assert.equal(f.fixtures[0].children[0].material.emissiveIntensity, 1, 'the housing is not a light');
  f.rig.dispose();
  assert.equal(diffuser.material, original); assert.equal(original.emissiveIntensity, 3);
});
