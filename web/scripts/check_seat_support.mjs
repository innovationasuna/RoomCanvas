#!/usr/bin/env node
// Verify seat support on the external office GLB; the small payload exists only
// in this CPU fixture, not in the product catalog or saved user layout.
import path from 'node:path';
import assert from 'node:assert/strict';
import {createFixture} from './lib/fixture.mjs';
import {createPlacement} from '../editor/placement.mjs';
import {createCollision} from '../editor/collision.mjs';
import {copyLayout, groundBasis, rotate} from '../editor/layout.mjs';
import {analogDelta} from '../editor/placement-motion.mjs';
const args = process.argv.slice(2), index = args.indexOf('--scene-dir');
if (index < 0) throw new Error('Usage: node web/scripts/check_seat_support.mjs --scene-dir /path/to/scene');
const {THREE, room, entities, initial, floorY, ceilingY, config} = await createFixture(path.resolve(args[index + 1]));
const payload = new THREE.Group(); payload.name = 'SeatTestObject'; payload.userData.name = payload.name;
const origin = new THREE.Vector3(0, floorY, 0); payload.position.copy(origin);
const mesh = new THREE.Mesh(new THREE.BoxGeometry(.08, .12, .08), new THREE.MeshBasicMaterial());
mesh.position.y = .06; mesh.userData.editorId = 'payload'; payload.add(mesh); room.add(payload);
entities.set('payload', {name: 'Small seat test object', group: payload, origin});
room.updateMatrixWorld(true);
const specs = {...config.placement, payload: {body: ['SeatTestObject']}};
const placement = createPlacement(THREE, room, entities, specs, floorY, ceilingY, {openings: config.openings});
const collision = createCollision(THREE, room, entities, specs, {label: config.label, keepAuthoredOverlaps: true});
for (const id of Object.keys(initial)) assert.equal(placement.assess(id, initial).state, 'stable', `${id} original support`);
for (const id of ['Chair0', 'Chair1', 'Chair2', 'Chair3', 'Chair4']) {
  const chair = entities.get(id), ray = new THREE.Raycaster();
  chair.group.traverse(m => {if (m.isMesh) m.material.side = THREE.DoubleSide;});
  ray.set(new THREE.Vector3(chair.origin.x, floorY + 2, chair.origin.z), new THREE.Vector3(0, -1, 0));
  const hit = ray.intersectObject(chair.group, true)[0];
  assert(hit && placement.supportAtPoint(id, hit.point.toArray(), initial), `${id} actual seat ray hit`);
  const layout = {...copyLayout(initial), payload: {x: hit.point.x, z: hit.point.z, y: 0, yaw: 0}};
  const settled = placement.settleAt('payload', layout, hit.point.y);
  assert(settled.ok, `${id}: ${settled.message}`);
  assert.equal(settled.surface.owner, id, 'lands on the seat, not the floor or chair bounds');
  assert.equal(placement.assess('payload', layout).support, id);
  assert(collision.checkPlacement(layout, ['payload']).ok, `${id} real mesh contact is clear despite overlapping bounds`);
  const adjusted = copyLayout(layout);
  const delta = analogDelta(Math.SQRT1_2, Math.SQRT1_2, .01, groundBasis({x:.6,z:.8}));
  for (const axis of ['x','y','z']) adjusted.payload[axis] += delta[axis];
  assert(placement.constrain('payload', layout, adjusted, 'joystick').ok);
  rotate(adjusted, 'payload', .2);
  const limited = collision.limit(layout, adjusted, ['payload']);
  assert.equal(placement.assess('payload', limited.layout).support, id, `${id} analog move and dial rotation retain seat support`);
  assert(collision.checkPlacement(limited.layout, ['payload']).ok, `${id} input stops before real seat penetration`);
  const penetrated = copyLayout(layout); penetrated.payload.y -= .025;
  assert(collision.checkPlacement(penetrated, ['payload']).blocked, `${id} real seat penetration remains blocked`);
  const carried = copyLayout(layout); carried[id].x += .2; carried[id].yaw += .4;
  assert(placement.carry(id, layout, carried).moved.includes('payload'), `${id} carries its payload`);
  assert.equal(placement.assess('payload', carried).support, id, `${id} translated and rotated seat still supports payload`);
  const hidden = copyLayout(layout); hidden[id].visible = false;
  assert.equal(placement.supportAtPoint(id, hit.point.toArray(), hidden), null);
  const back = chair.bounds.getCenter(new THREE.Vector3()); back.y = chair.bounds.max.y;
  assert.equal(placement.supportAtPoint(id, back.toArray(), initial), null, `${id} chair back/bounding-box top is not a seat`);
  console.log(`PASS ${id}: actual seat support, collision, penetration, carry, hidden support, no box-top support`);
}
