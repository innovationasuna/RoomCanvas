#!/usr/bin/env node
// CPU-only wall-relocation acceptance against an external authored Room.glb.
// node web/scripts/check_wall_mount.mjs --scene-dir samples/office
import path from 'node:path';
import assert from 'node:assert/strict';
import {copyLayout, sameLayout, encodeLayout, decodeLayout, History, groundBasis, wallBasis, move} from '../editor/layout.mjs';
import {transformPoint} from '../editor/placement.mjs';
import {createCollision} from '../editor/collision.mjs';
import {createFixture} from './lib/fixture.mjs';
import {PlacementSession} from '../editor/placement-session.mjs';

const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!arg('--scene-dir')) throw new Error('Usage: node web/scripts/check_wall_mount.mjs --scene-dir /path/to/scene [--case name]');
const sceneDir = path.resolve(arg('--scene-dir'));
const {THREE, room, entities, placement, ids, initial, config} = await createFixture(sceneDir);
const collision = createCollision(THREE, room, entities, config.placement, {label: config.label, keepAuthoredOverlaps: true});
assert.equal(typeof placement.mount, 'function', 'placement exposes explicit wall relocation');
assert.equal(typeof placement.directionTarget, 'function', 'placement exposes camera-direction wall targeting');
assert.equal(typeof collision.checkPlacement, 'function', 'collision exposes destination-only check');
console.log(JSON.stringify({fixture: path.join(sceneDir, 'Room.glb'), objects: ids.length}));
let checks = 0, failures = 0;
function check(name, fn) {
  if (arg('--case') && !name.toLowerCase().includes(arg('--case').toLowerCase())) return;
  checks++; const started = performance.now();
  try {const result = fn(); console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms)${result ? ` ${JSON.stringify(result)}` : ''}`);}
  catch (error) {failures++; console.error(`FAIL ${name}: ${error.stack}`);}
}
function isolated(id) {
  const result = copyLayout(initial);
  // Keep real walls/openings and the actual moving GLB mesh. Temporarily park
  // other furniture outside the room to test wall geometry independently.
  for (const other of ids) if (other !== id) result[other].x += 50;
  return result;
}
function mount(before, id, wall, point, {requireClear = true} = {}) {
  const next = copyLayout(before);
  const result = placement.mount(id, next, wall, point);
  assert(result.ok, `${id} -> ${wall}: ${result.message}`);
  const carried = placement.carry(id, before, next);
  assert(carried.ok, carried.message);
  const status = placement.assess(id, next);
  assert.equal(status.state, 'stable', `${wall}: ${status.detail}`);
  assert.equal(status.wall, wall, 'infer the newly mounted wall from the saved pose');
  const destination = collision.checkPlacement(next, carried.moved);
  if (requireClear) assert(destination.ok && !destination.blocked, `destination collides with ${destination.other?.name}: ${destination.reason}`);
  return {layout: next, moved: carried.moved, destination, status};
}

check('all original objects retain stable support and mounting', () => {
  for (const id of ids) assert.equal(placement.assess(id, initial).state, 'stable', id);
  return {stable: ids.length};
});

check('stored shelf can lock a low wall preview and nudge clear without committing the obstruction', () => {
  const id = 'ShelfStandards_Photo', before = copyLayout(initial);
  for (const other of ids) before[other].visible = false;
  before[id].y = -.1;
  const session = new PlacementSession(before,id,true), next = copyLayout(before);
  const wall = placement.wallTargets().find(w => w.name==='Wall1');
  const point = wall.center.slice(); point[1] = placement.wallFrame(id,before).center[1];
  assert(placement.mount(id,next,wall.name,point).ok);
  const blocked = collision.checkPlacement(next,[id]);
  assert(!blocked.ok && /线槽/.test(blocked.other?.name));
  session.update(next,false,'blocked');
  assert.equal(session.confirm(),null);
  const raised = copyLayout(next); raised[id].y += .1;
  assert(placement.constrain(id,next,raised,'up').ok);
  assert.equal(placement.assess(id,raised).wall,'Wall1');
  assert(collision.checkPlacement(raised,[id]).ok,'raised complete shelf clears trunking');
  session.update(raised,true,'clear');
  assert(session.confirm());
  assert(sameLayout(session.cancel(),before),'cancellation restores stored visibility and retained height');
  assert(sameLayout(session.committed(),before),'draft mount never leaks into recovery or export');
});

check('whiteboard transfers across nonparallel walls and keeps facing the room', () => {
  let layout = isolated('Whiteboard0');
  const destinations = [
    ['Wall1', [-1.8, 0, 1.638]],
    ['Wall2', [.79, 0, -.2]],
    ['Wall0', [-.9191, 0, -1.89562]],
  ];
  const poses = [];
  for (const [wall, point] of destinations) {
    layout = mount(layout, 'Whiteboard0', wall, point).layout;
    const frame = placement.wallFrame('Whiteboard0', layout);
    assert(frame && frame.n.every(Number.isFinite));
    assert(Math.abs(placement.assess('Whiteboard0', layout).gap) < .012, 'back remains flush with wall');
    poses.push({wall, ...layout.Whiteboard0});
  }
  assert(Math.abs(poses[0].yaw - poses[1].yaw) > 1, 'perpendicular walls must rotate object automatically');
  assert(Math.abs(poses[2].yaw) < .001, 'return to original wall recovers original orientation');
  return poses;
});

check('noticeboard reaches a clear second wall in the unchanged furnished room', () => {
  const target = placement.wallTargets().find((wall) => wall.name === 'Wall6');
  const moved = mount(initial, 'Noticeboard0', 'Wall6', [target.center[0], 0, target.center[2]]);
  for (const id of ids) if (id !== 'Noticeboard0') assert.deepEqual(moved.layout[id], initial[id], 'other furniture is unchanged');
  return {wall: moved.status.wall, pose: moved.layout.Noticeboard0};
});

check('window wall rejects window opening and retains trim collisions below it', () => {
  const before = isolated('Whiteboard0');
  const low = mount(before, 'Whiteboard0', 'Wall5', [-3.9, -1.08, .4], {requireClear: false});
  assert(low.destination.blocked, 'solid mounting area still respects skirting / trunking geometry');
  const invalid = copyLayout(before);
  const result = placement.mount('Whiteboard0', invalid, 'Wall5', [-3.9, .1, .4]);
  assert(!result.ok, 'mounting over the real window must be rejected');
  assert(sameLayout(invalid, before), 'failed preview must not partially modify the draft pose');
  return {wall: low.status.wall, rejection: result.message};
});

check('narrow wall refuses an oversized whiteboard', () => {
  const before = isolated('Whiteboard0'), next = copyLayout(before);
  const result = placement.mount('Whiteboard0', next, 'Wall6', [.28, -.2, -2.3]);
  assert(!result.ok, 'wall width is about 0.65, narrower than the actual board');
  assert(sameLayout(before, next), 'invalid fit must not mutate layout');
  return {rejection: result.message};
});

check('mount clearance includes the complete air-conditioner conduit', () => {
  const before = isolated('AirConditioner0'), next = copyLayout(before);
  const target = placement.wallTargets().find((wall) => wall.name === 'Wall0');
  const result = placement.mount('AirConditioner0', next, 'Wall0', [target.center[0], -.6, target.center[2]]);
  assert(!result.ok, 'attached conduit would extend below the floor');
  assert(sameLayout(next, before), 'invalid grouped attachment must not mutate layout');
  return {rejection: result.message};
});

check('destination already occupied by a wall object is rejected', () => {
  const target = entities.get('Whiteboard0').bounds.getCenter(new THREE.Vector3()).toArray();
  target[1] = 0;
  const source = copyLayout(initial);
  const moved = mount(initial, 'Noticeboard0', 'Wall0', target, {requireClear: false});
  assert(!moved.destination.ok && moved.destination.blocked, 'overlapping wall objects cannot be confirmed');
  assert.equal(moved.destination.other?.id, 'Whiteboard0', 'collision identifies the actual destination object');
  assert(sameLayout(initial, source), 'source layout remains unchanged during preview');
  return {obstacle: moved.destination.other};
});

check('movement after relocation stays on the new wall', () => {
  const before = mount(isolated('Whiteboard0'), 'Whiteboard0', 'Wall2', [.79, 0, -.2]).layout;
  const next = copyLayout(before), frame = placement.wallFrame('Whiteboard0', before);
  next.Whiteboard0.x += frame.tangent[0] * .1;
  next.Whiteboard0.z += frame.tangent[2] * .1;
  next.Whiteboard0.y += .1;
  const result = placement.constrain('Whiteboard0', before, next, 'up');
  assert(result.ok, result.message);
  assert.equal(placement.assess('Whiteboard0', next).wall, 'Wall2');
  assert(Math.abs(next.Whiteboard0.yaw - before.Whiteboard0.yaw) < 1e-6, 'ordinary movement must preserve the new mounting orientation');
  assert(Math.abs(next.Whiteboard0.y - before.Whiteboard0.y - .1) < 1e-6);
  assert(collision.checkPlacement(next, ['Whiteboard0']).ok);
});

check('undo redo and JSON reload preserve inferred mounting wall', () => {
  const before = isolated('Whiteboard0');
  const after = mount(before, 'Whiteboard0', 'Wall2', [.79, 0, -.2]).layout;
  const history = new History(); assert(history.commit(before, after));
  const undo = history.undo(after);
  assert(sameLayout(undo, before));
  assert.equal(placement.assess('Whiteboard0', undo).wall, 'Wall0');
  const redo = history.redo(undo);
  assert(sameLayout(redo, after));
  const loaded = decodeLayout(JSON.parse(JSON.stringify(encodeLayout(redo, 'wall-regression'))), 'wall-regression', ids);
  assert(sameLayout(loaded, after));
  assert.equal(placement.assess('Whiteboard0', loaded).wall, 'Wall2');
  const next = copyLayout(loaded); next.Whiteboard0.y -= .1;
  assert(placement.constrain('Whiteboard0', loaded, next, 'down').ok, 'loaded wall attachment remains editable');
  assert.equal(placement.assess('Whiteboard0', next).wall, 'Wall2');
});

// wallFrame is a display overlay at wall + .018. Recover the actual authored
// back center using assessed gap so a tight/narrow destination uses the real ray.
function backCenter(id, layout) {
  const frame = placement.wallFrame(id, layout), state = placement.assess(id, layout);
  return frame.center.map((value, axis) => value + (state.gap - .018) * frame.n[axis]);
}

check('direction buttons reach Wall6 and return to Wall2 without changing height', () => {
  const id = 'Noticeboard0', source = backCenter(id, initial);
  const wall = placement.wallTargets().find((target) => target.name === 'Wall6');
  const axis = {x: wall.center[0] - source[0], z: wall.center[2] - source[2]};
  const target = placement.directionTarget(id, initial, axis);
  assert.equal(target?.name, 'Wall6', 'camera-facing ray chooses the first wall');
  assert(Math.abs(target.point[0] - wall.center[0]) < 1e-8);
  assert(Math.abs(target.point[2] - wall.center[2]) < 1e-8);
  const there = mount(initial, id, target.name, target.point).layout;
  assert(Math.abs(there[id].y - initial[id].y) < 1e-9, 'switching walls preserves height');
  const reverse = placement.directionTarget(id, there, {x: -axis.x, z: -axis.z});
  assert.equal(reverse?.name, 'Wall2', 'back button uses the reverse camera direction');
  const returned = mount(there, id, reverse.name, reverse.point).layout;
  assert(Math.abs(returned[id].y - initial[id].y) < 1e-9);
  for (const other of ids) if (other !== id) assert.deepEqual(returned[other], initial[other]);
  return {outbound: target.name, inbound: reverse.name, axis, point: target.point};
});

for (const {axis, wall, pattern, label} of [
  {axis: {x: -1, z: 0}, wall: 'Wall5', pattern: /门窗/, label: 'window'},
  {axis: {x: 0, z: 1}, wall: 'Wall3', pattern: /宽度/, label: 'narrow wall'},
]) check(`direction buttons stop at a ${label} instead of skipping to another wall`, () => {
  const source = copyLayout(initial), candidate = copyLayout(source);
  const target = placement.directionTarget('Noticeboard0', source, axis);
  assert.equal(target?.name, wall);
  const result = placement.mount('Noticeboard0', candidate, target.name, target.point);
  assert(!result.ok, 'invalid destination must be rejected');
  assert.match(result.message, pattern);
  assert(sameLayout(source, candidate), 'rejected direction must leave the layout unchanged');
  assert(sameLayout(source, initial), 'targeting is read-only');
  return {wall, rejection: result.message};
});

check('direction buttons reject occupied destination while keeping the source layout', () => {
  const source = copyLayout(initial);
  const target = placement.directionTarget('Whiteboard0', source, {x: 0, z: 1});
  assert.equal(target?.name, 'Wall1');
  const candidate = mount(source, 'Whiteboard0', target.name, target.point, {requireClear: false});
  assert(candidate.destination.blocked, 'existing shelf occupies the projected destination');
  assert.equal(candidate.destination.other?.id, 'ShelfStandards_Desk');
  assert(sameLayout(source, initial), 'unconfirmed colliding candidate must not modify the source');
  return {wall: target.name, obstacle: candidate.destination.other};
});

check('outward direction has no target and makes no layout change', () => {
  const source = copyLayout(initial);
  assert.equal(placement.directionTarget('Whiteboard0', source, {x: 0, z: -1}), null);
  assert.equal(placement.directionTarget('Noticeboard0', source, {x: 1, z: 0}), null);
  assert(sameLayout(source, initial));
});

check('wall left and right keep the full step at diagonal and nearly end-on cameras', () => {
  const id = 'Noticeboard0', frame = placement.wallFrame(id, initial), step = .1;
  const cameras = [groundBasis({x: Math.SQRT1_2, z: -Math.SQRT1_2}),
    groundBasis({x: frame.n[0] + .001 * frame.tangent[0], z: frame.n[2] + .001 * frame.tangent[2]})];
  for (const camera of cameras) for (const direction of ['left', 'right']) {
    const basis = wallBasis(frame.tangent, camera), candidate = copyLayout(initial);
    move(candidate, id, direction, step, basis);
    const support = placement.constrain(id, initial, candidate, direction);
    assert(support.ok, support.message);
    const carried = placement.carry(id, initial, candidate);
    assert(carried.ok, carried.message);
    const stopped = collision.limit(initial, candidate, carried.moved);
    assert(!stopped.blocked && stopped.fraction === 1, 'clear wall space allows the entire tangential step');
    const actual = stopped.layout[id];
    // constrain also adjusts the original mount gap .0055 to .003; compare
    // the tangential component, not the length including that normal correction.
    const amount = actual.x * basis.right.x + actual.z * basis.right.z;
    assert(Math.abs(amount - (direction === 'left' ? -step : step)) < 1e-8);
    assert.equal(actual.y, 0);
    assert.equal(placement.assess(id, stopped.layout).wall, 'Wall2');
  }
  return {directions: 4, fullStep: step};
});

check('shelf and its authored contents rotate together onto another wall', () => {
  const id = 'ShelfStandards_Photo', before = isolated(id);
  const after = mount(before, id, 'Wall2', [.79, 0, -.7]).layout;
  const entity = entities.get(id), original = new Map();
  entity.group.traverse((node) => {if (node.isMesh) original.set(node, node.getWorldPosition(new THREE.Vector3()).toArray());});
  assert(original.size > 10, 'fixture includes multiple shelf contents');
  entity.group.position.copy(entity.origin).add(new THREE.Vector3(after[id].x, after[id].y, after[id].z));
  entity.group.rotation.y = after[id].yaw;
  room.updateMatrixWorld(true);
  for (const [node, point] of original) {
    const actual = node.getWorldPosition(new THREE.Vector3()).toArray();
    const expected = transformPoint(point, entity.origin.toArray(), after[id]);
    assert(actual.every((v, axis) => Math.abs(v - expected[axis]) < 1e-6), node.name);
  }
  entity.group.position.copy(entity.origin); entity.group.rotation.y = 0; room.updateMatrixWorld(true);
  return {meshes: original.size, wall: placement.assess(id, after).wall};
});
assert(checks > 0, 'no acceptance cases match --case');
assert.equal(failures, 0, `${failures}/${checks} real-scene wall relocation acceptance checks failed`);
console.log(`PASS ${checks} real-scene wall relocation acceptance checks`);
