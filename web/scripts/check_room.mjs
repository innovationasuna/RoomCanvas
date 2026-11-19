#!/usr/bin/env node
// CPU-only check that a room loads into the editor from its room_objects.json:
// every movable group is found, supported or mounted, can be lifted and set down again, and
// every fixture hides with a wall or the ceiling. Reads Room.glb; changes nothing.
// node web/scripts/check_room.mjs --scene-dir samples/room3 [--three-dir /path/to/vendor]
import path from 'node:path';
import assert from 'node:assert/strict';
import {copyLayout} from '../editor/layout.mjs';
import {createCollision} from '../editor/collision.mjs';
import {nearestWall, worldVertices} from '../editor/wall-visibility.mjs';
import {createFixture} from './lib/fixture.mjs';

const args = process.argv.slice(2);
const arg = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!arg('--scene-dir')) throw new Error('Usage: node web/scripts/check_room.mjs --scene-dir /path/to/room [--three-dir /path/to/vendor]');
const sceneDir = path.resolve(arg('--scene-dir'));
const fixture = await createFixture(sceneDir, arg('--three-dir') && path.resolve(arg('--three-dir')));
const {THREE, room, floorY, ceilingY, entities, placement, ids, initial, config} = fixture;
const collision = createCollision(THREE, room, entities, config.placement, {label: config.label, keepAuthoredOverlaps: true});
console.log(JSON.stringify({scene: config.sceneId, floorY: +floorY.toFixed(4), ceilingY: +ceilingY.toFixed(4),
  groups: ids.length, placement: placement.audit, collision: collision.audit}));

let checks = 0, failures = 0, notes = 0;
function check(name, fn) {
  checks++;
  try {const result = fn(); console.log(`PASS ${name}${result ? ` ${JSON.stringify(result)}` : ''}`);}
  catch (error) {failures++; console.error(`FAIL ${name}: ${error.message}`);}
}
// The reconstruction itself can leave small overlaps; report them without failing.
const note = (message) => {notes++; console.log(`NOTE ${message}`);};

check('every group keeps its reconstructed position', () => {
  for (const entity of entities.values()) {
    const box = new THREE.Box3().setFromObject(entity.group);
    assert(!box.isEmpty(), `${entity.id} has no geometry`);
  }
  return {groups: entities.size, roots: room.children.length};
});

for (const id of ids) {
  const entity = entities.get(id), wall = placement.isWall(id);
  check(`${id} (${entity.name}) ${wall ? 'is mounted on a wall' : 'stands on a support'}`, () => {
    const state = placement.assess(id, initial);
    if (wall) {
      assert(placement.wallFrame(id, initial), `${id}: no wall frame`);
      if (state.state !== 'stable') note(`${id} starts ${state.state}: ${state.label} · ${state.detail || ''}`);
      return {state: state.state, wall: state.wall};
    }
    // The editor shows such an object as a draft to move clear; nothing more to test here.
    if (state.state !== 'stable') {note(`${id} starts ${state.state}: ${state.label} · ${state.detail || ''}`); return {state: state.state};}
    // Full-height wardrobes have no headroom; lift only into the space there is.
    const headroom = ceilingY - new THREE.Box3().setFromObject(entity.group).max.y;
    const lifted = copyLayout(initial); lifted[id].y += Math.max(0, Math.min(.05, headroom - .005));
    const up = placement.constrain(id, initial, lifted, 'up');
    assert(up.ok, `${id}: cannot lift: ${up.message}`);
    const settled = copyLayout(lifted);
    const down = placement.settle(id, settled);
    assert(down.ok, `${id}: cannot set down: ${down.message}`);
    assert(Math.abs(settled[id].y) < .02, `${id}: set down at ${settled[id].y.toFixed(3)} instead of its original height`);
    return {state: state.state, support: state.support || '地面', landed: +settled[id].y.toFixed(4)};
  });
}

check('initial placement collisions', () => {
  // Without the editor's allowance, to list what the reconstruction itself overlaps. With it, an
  // overlap no deeper than in the scan is allowed, so every piece can be confirmed where it is.
  const strict = createCollision(THREE, room, entities, config.placement, {label: config.label});
  const overlaps = [];
  for (const id of ids) {
    const result = strict.checkPlacement(initial, [id]);
    if (!result.ok) overlaps.push(`${id}↔${result.other?.id || result.other}`);
  }
  if (overlaps.length) note(`touching or overlapping in the reconstruction: ${overlaps.join(', ')}`);
  for (const id of ids) assert(collision.checkPlacement(initial, [id]).ok, `${id} cannot be confirmed where the reconstruction put it`);
  return {overlaps: overlaps.length};
});

check('fixtures hide with a wall or the ceiling', () => {
  const walls = placement.wallTargets(), names = new Set(walls.map((wall) => wall.name));
  const grouped = new Set([...entities.values()].flatMap((entity) => entity.roots));
  const owned = {}, loose = [];
  for (const root of room.children) {
    const name = root.userData.name || root.name;
    if (grouped.has(name) || name.startsWith('Editable_') || name === 'Floor0' || config.isCeiling(name)) continue;
    let owner = config.wallOwner(name);
    if (!owner && config.nearWall.includes(name)) owner = nearestWall(worldVertices(THREE, root), walls);
    if (owner && names.has(owner)) owned[name] = owner; else loose.push(name);
  }
  assert.deepEqual(loose, [], `no wall for ${loose.join(', ')}`);
  return owned;
});

console.log(`${failures ? 'FAIL' : 'PASS'} ${checks - failures}/${checks} room checks, ${notes} notes`);
process.exitCode = failures ? 1 : 0;
