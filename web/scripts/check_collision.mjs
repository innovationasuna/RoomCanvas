#!/usr/bin/env node
// CPU-only acceptance with an external authored Room.glb. No renderer, textures or GPU.
// node web/scripts/check_collision.mjs --scene-dir samples/office
import path from 'node:path';
import assert from 'node:assert/strict';
import {copyLayout} from '../editor/layout.mjs';
import {createFixture} from './lib/fixture.mjs';

const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!arg('--scene-dir')) throw new Error('Usage: node web/scripts/check_collision.mjs --scene-dir /path/to/scene [--inspect]');
const sceneDir = path.resolve(arg('--scene-dir'));
const {THREE, room, floorY, ceilingY, entities, placement, ids, initial, config} = await createFixture(sceneDir);
const fmt = (vector) => vector.toArray().map((n) => +n.toFixed(5));
if (args.includes('--inspect')) {
  for (const entity of entities.values()) console.log(JSON.stringify({id: entity.id, origin: fmt(entity.origin),
    min: fmt(entity.bounds.min), max: fmt(entity.bounds.max), placement: placement.assess(entity.id, initial)}));
  for (const id of ['Table0', 'Table1', 'Chair0', 'Chair1', 'Footrest0']) {
    entities.get(id).group.traverse((mesh) => {
      if (!mesh.isMesh) return;
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
      console.log(JSON.stringify({owner: id, mesh: mesh.name, min: fmt(box.min), max: fmt(box.max)}));
    });
  }
  process.exit(0);
}

const {createCollision} = await import('../editor/collision.mjs');
const collision = createCollision(THREE, room, entities, config.placement, {label: config.label, keepAuthoredOverlaps: true});
console.log(JSON.stringify({fixture: path.join(sceneDir, 'Room.glb'), floorY, ceilingY, collision: collision.audit}));
let checks = 0, failures = 0;
function check(name, fn) {
  if (arg('--case') && !name.toLowerCase().includes(arg('--case').toLowerCase())) return;
  checks++; const started = performance.now();
  try {const result = fn(); console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms)${result ? ` ${JSON.stringify(result)}` : ''}`);}
  catch (error) {failures++; console.error(`FAIL ${name}: ${error.message}`);}
}
function action(before, id, change, direction) {
  const next = copyLayout(before); change(next[id]);
  const support = direction === 'settle' ? placement.settle(id, next) : placement.constrain(id, before, next, direction);
  if (!support.ok) return {...support, layout: before};
  const carried = placement.carry(id, before, next);
  if (!carried.ok) return {...carried, layout: before};
  const result = collision.limit(before, next, carried.moved);
  if (args.includes('--diagnostics')) console.log(JSON.stringify({id, direction, other: result.other, fraction: result.fraction, ms: collision.audit.lastMs, pairs: collision.audit.lastPairs}));
  return {ok: true, ...result};
}
for (const id of ['Table0', 'Table1']) check(`${id} lift then settle at original floor`, () => {
  const lifted = action(initial, id, (pose) => {pose.y += .1;}, 'up');
  assert(lifted.ok && lifted.layout[id].y > .01, `${id}: cannot lift away from original floor: ${lifted.other?.name || lifted.message}`);
  const settled = action(lifted.layout, id, () => {}, 'settle');
  assert(settled.ok && !settled.blocked, `${id}: descend unexpectedly blocked by ${settled.other?.name || settled.message}`);
  assert(Math.abs(settled.layout[id].y) < .012, `${id}: failed to return to original height`);
  assert.equal(placement.assess(id, settled.layout).state, 'stable');
  return {lift: lifted.layout[id].y, liftObstacle: lifted.other, landed: settled.layout[id].y};
});
check('footrest moves through real empty space under the desk', () => {
  const footrest = entities.get('Footrest0').bounds, desk = entities.get('Table1').bounds;
  assert(footrest.intersectsBox(desk), 'fixture must overlap whole-furniture AABBs');
  const result = action(initial, 'Footrest0', (pose) => {pose.x += .1;}, 'right');
  assert(result.ok && !result.blocked, `empty under-desk motion incorrectly blocked by ${result.other?.name || result.message}`);
  assert(Math.abs(result.layout.Footrest0.x - .1) < 1e-7);
  return {x: result.layout.Footrest0.x};
});
for (const [id, axis, amount, label] of [
  ['Chair0', 'x', 1, 'chair stops at neighbouring chair'],
  ['Chair2', 'z', -2, 'long step stops at round table foot'],
  ['Chair1', 'z', 1, 'office chair stops at footrest below desk'],
]) check(label, () => {
  const stopped = action(initial, id, (pose) => {pose[axis] += amount;}, 'forward');
  assert(stopped.ok && stopped.blocked && stopped.fraction < 1, `${label} must stop at real geometry`);
  const distance = Math.abs(stopped.layout[id][axis]);
  assert(distance > .00001, `${label} should reach contact instead of rejecting the entire step`);
  const again = action(stopped.layout, id, (pose) => {pose[axis] += Math.sign(amount) * .1;}, 'forward');
  assert(again.ok && again.blocked, 'pushing into contact must remain blocked');
  assert(Math.abs(again.layout[id][axis] - stopped.layout[id][axis]) < .001, 'continued pushing must not penetrate');
  const retreat = action(stopped.layout, id, (pose) => {pose[axis] -= Math.sign(amount) * Math.min(.05, distance / 2);}, 'back');
  assert(retreat.ok && !retreat.blocked, `retreat blocked by ${retreat.other?.name || retreat.message}`);
  assert(Math.abs(retreat.layout[id][axis]) < distance, 'reverse motion must move away');
  return {distance, fraction: stopped.fraction, obstacle: stopped.other};
});
check('desk descends through empty space between its feet until touching actual cabinet contents', () => {
  const before = copyLayout(initial);
  for (const id of ids) if (!['Table1', 'Pedestal0'].includes(id)) before[id].x += 50;
  // Move the pair away from the wall trunking before starting the raised fixture.
  before.Table1.x = .5;
  before.Table1.z = -.4;
  before.Table1.y = 1;
  before.Pedestal0.x = -1.1425000429153442 + .5;
  before.Pedestal0.z = -.1358718709793001 - .4;
  const result = action(before, 'Table1', () => {}, 'settle');
  assert(result.ok, `support calculation still fills empty space between feet: ${result.message}`);
  assert(result.blocked, 'the authored helmet protrudes above the desktop underside, requiring a real collision stop');
  assert(result.layout.Table1.y < .1 && result.layout.Table1.y > .015, `unexpected landing height ${result.layout.Table1.y}`);
  assert.equal(result.other?.id, 'Pedestal0', 'must stop at actual cabinet contents');
  return {height: result.layout.Table1.y, obstacle: result.other};
});
check('carried chair and table stop together before room obstacles', () => {
  const before = copyLayout(initial);
  // This independent fixture isolates the assembly from unrelated floor furniture.
  for (const id of ids) if (!['Table0', 'Chair0', 'ShelfStandards_Photo'].includes(id)) before[id].x += 50;
  before.Chair0.x = entities.get('Table0').origin.x - entities.get('Chair0').origin.x;
  before.Chair0.z = entities.get('Table0').origin.z - entities.get('Chair0').origin.z;
  before.Chair0.y = 1.4;
  const support = placement.settle('Chair0', before);
  assert(support.ok, `payload fixture must fit the tabletop: ${support.message}`);
  assert.equal(placement.assess('Chair0', before).support, 'Table0');
  const result = action(before, 'Table0', (pose) => {pose.x -= 1.5; pose.z -= .3;}, 'left');
  assert(result.ok && result.blocked && result.fraction < 1, 'assembly must stop at an obstacle');
  assert.equal(result.other?.movingId, 'Chair0', 'the payload must be the first colliding object');
  assert.equal(result.other?.id, 'ShelfStandards_Photo', 'the elevated payload must hit the actual wall shelf');
  assert(Math.abs((result.layout.Chair0.x - before.Chair0.x) - result.layout.Table0.x) < 1e-7, 'payload must use the same stopped translation');
  assert(Math.abs((result.layout.Chair0.z - before.Chair0.z) - result.layout.Table0.z) < 1e-7, 'payload must use the same stopped depth translation');
  assert.equal(placement.assess('Chair0', result.layout).support, 'Table0');
  return {x: result.layout.Table0.x, fraction: result.fraction, obstacle: result.other};
});
assert(checks > 0, 'no acceptance cases match --case');
assert.equal(failures, 0, `${failures}/${checks} real-scene collision acceptance checks failed`);
console.log(`PASS ${checks} real-scene collision acceptance checks`);
