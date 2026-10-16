#!/usr/bin/env node
// Drop a small test box from above onto real seats and tables of the office sample.
// The box exists only in this CPU fixture.
// node web/scripts/check_gravity.mjs --scene-dir samples/office
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './lib/fixture.mjs';
import {copyLayout} from '../editor/layout.mjs';
import {createPlacement} from '../editor/placement.mjs';
import {createCollision} from '../editor/collision.mjs';
import {predictDrop} from '../editor/drop-placement.mjs';
const args = process.argv.slice(2), i = args.indexOf('--scene-dir');
if (i < 0) throw new Error('Usage: node web/scripts/check_gravity.mjs --scene-dir samples/office');
const {THREE, room, entities, initial, floorY, ceilingY, config} = await createFixture(path.resolve(args[i + 1]));
const box = new THREE.Group(); box.name = box.userData.name = 'DropTestObject';
const origin = new THREE.Vector3(0, floorY, 0); box.position.copy(origin);
const mesh = new THREE.Mesh(new THREE.BoxGeometry(.08, .12, .08), new THREE.MeshBasicMaterial());
mesh.position.y = .06; mesh.userData.editorId = 'box'; box.add(mesh); room.add(box);
entities.set('box', {name: 'Drop test box', group: box, origin});
room.updateMatrixWorld(true);
const specs = {...config.placement, box: {body: ['DropTestObject']}};
const placement = createPlacement(THREE, room, entities, specs, floorY, ceilingY, {openings: config.openings});
const collision = createCollision(THREE, room, entities, specs, {label: config.label, keepAuthoredOverlaps: true});
const source = {...copyLayout(initial), box: {x: 0, y: 1.1, z: 0, yaw: 0}};
for (const id of ['Chair0', 'Chair1', 'Chair2', 'Chair4', 'Table0']) {
  const {origin: target} = entities.get(id);
  const next = copyLayout(source); next.box.x = target.x; next.box.z = target.z;
  const before = JSON.stringify(next);
  const drop = predictDrop('box', next, placement, collision);
  assert(drop.ok, `${id}: ${drop.message}`);
  assert.equal(drop.state.support, id, `${id} first contact target`);
  assert.equal(JSON.stringify(next), before, 'prediction leaves the floating draft unchanged');
  assert(drop.distance > .1, 'actual fall from an elevated draft');
  assert(collision.checkPlacement(drop.candidate, ['box']).ok, 'landing has no penetration');
  assert.equal(placement.assess('box', drop.candidate).support, id);
  console.log(`PASS box drops onto ${id}; y=${drop.candidate.box.y.toFixed(3)} · distance=${drop.distance.toFixed(3)}`);
  const hidden = copyLayout(next); hidden[id].visible = false;
  const floor = predictDrop('box', hidden, placement, collision);
  assert(floor.ok, `hidden ${id}: ${floor.message}`);
  assert.equal(floor.state.support, null, 'a hidden chair or table does not catch the box');
}
// Chair3 is tucked under the meeting table. Dropped where the two overlap, the box may
// land on the table or be refused, but never passes through the table to the seat.
const [chair, table] = ['Chair3', 'Table0'].map((id) => new THREE.Box3().setFromObject(entities.get(id).group));
const overlap = chair.clone().intersect(table).getCenter(new THREE.Vector3());
const tucked = copyLayout(source); tucked.box.x = overlap.x; tucked.box.z = overlap.z;
const blocked = predictDrop('box', tucked, placement, collision);
assert(!(blocked.ok && blocked.state.support === 'Chair3'), 'fell through the meeting table onto Chair3');
console.log(`PASS Chair3 under the meeting table: ${blocked.message}`);
const outside = copyLayout(source); outside.box.x = 100;
assert.equal(predictDrop('box', outside, placement, collision).ok, false, 'no floor beyond the room');
console.log('PASS hidden supports and out-of-room rejection');
