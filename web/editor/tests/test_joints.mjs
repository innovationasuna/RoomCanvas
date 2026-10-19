import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {jointMatrix, openValue, Openings, openableOf, ridersOf, OPEN_MS} from '../joints.mjs';

const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
// A carcass turned and stretched to the scan, as the reconstruction exports it, with a door
// hanging on it whose origin is the hinge.
function cabinet() {
  const carcass = new THREE.Object3D();
  carcass.position.set(2, .7, -1.7);
  carcass.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -.55);
  carcass.scale.set(.87, .89, 1.27);
  const door = new THREE.Object3D();
  door.position.set(-.88, .28, .19);
  carcass.add(door);
  carcass.updateMatrixWorld(true);
  return {carcass, door};
}
const corners = [[0, 0, 0], [.4, 0, 0], [0, 1, 0], [.4, 1, .02]].map((p) => new THREE.Vector3(...p));
const world = (parentWorld, local, p) => p.clone().applyMatrix4(parentWorld.clone().multiply(local));

test('a hinge swings the part rigidly about its hinge line, even in a stretched frame', () => {
  const {carcass, door} = cabinet();
  const joint = {type: 'revolute', axis: [0, -1, 0], lower: 0, upper: 1.745};
  door.updateMatrix();
  const rest = door.matrix.clone(), P = carcass.matrixWorld;
  const open = jointMatrix(THREE, joint, rest, P, Math.PI / 2);
  const before = corners.map((p) => world(P, rest, p)), after = corners.map((p) => world(P, open, p));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    assert.ok(Math.abs(before[i].distanceTo(before[j]) - after[i].distanceTo(after[j])) < 1e-9, 'distances on the part are kept');
  }
  assert.ok(before[0].distanceTo(after[0]) < 1e-9, 'the hinge point stays');
  assert.ok(Math.abs(before[2].y - after[2].y - (before[0].y - after[0].y)) < 1e-9, 'the hinge line is vertical in the world');
  const swung = after[1].clone().sub(after[0]), was = before[1].clone().sub(before[0]);
  assert.ok(Math.abs(swung.angleTo(was) - Math.PI / 2) < 1e-9, 'a quarter turn');
  assert.ok(close(jointMatrix(THREE, joint, rest, P, 0).elements, rest.elements, 1e-12), 'zero is the closed part');
});

test('a slide moves the part along its axis in the parent frame', () => {
  const {carcass, door} = cabinet();
  door.updateMatrix();
  const moved = jointMatrix(THREE, {type: 'prismatic', axis: [0, 1, 0]}, door.matrix, carcass.matrixWorld, .2);
  assert.ok(close(new THREE.Vector3().setFromMatrixPosition(moved).toArray(), [-.88, .48, .19], 1e-12));
});

test('a part opens to the far end of its range', () => {
  assert.equal(openValue({lower: 0, upper: 1.7}), 1.7);
  assert.equal(openValue({lower: -1.2, upper: .3}), -1.2);
});

test('parts animate open and closed, and all shut at once before arranging', () => {
  const {door} = cabinet();
  door.updateMatrix();
  let now = 0, queued = null, renders = 0, settled = 0;
  const part = {joint: {type: 'revolute', axis: [0, 1, 0], lower: 0, upper: 1.5}, node: door, rest: door.matrix.clone()};
  const parts = new Openings(THREE, [part], {render: () => renders++, settled: () => settled++,
    clock: {now: () => now}, frame: (step) => {queued = step;}});
  assert.equal(openableOf(door), part, 'a hit on the part finds it');
  parts.toggle(part);
  now = OPEN_MS / 2; queued();
  assert.ok(part.value > 0 && part.value < 1.5 && !door.matrixAutoUpdate);
  assert.equal(parts.isOpen(part), true, 'opening counts as open');
  now = OPEN_MS; queued();
  assert.equal(part.value, 1.5); assert.equal(settled, 1);
  parts.closeAll();
  assert.equal(part.value, 0);
  assert.ok(door.matrixAutoUpdate && close(door.matrix.elements, part.rest.elements, 1e-12), 'closed is the exact rest pose');
  assert.ok(renders >= 3 && settled === 2);
});

// A lifting desk: its top is a part on a slide; a cup stands on the top, a lamp on the floor beside it.
function desk() {
  const box = (w, h, d, x, y, z) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
    mesh.position.set(x, y, z);
    return mesh;
  };
  const frame = new THREE.Object3D();
  frame.position.set(1, 0, -2);
  frame.scale.set(1.1, .9, 1);  // stretched to the scan
  const top = new THREE.Object3D();
  top.position.set(0, .75, 0);
  top.add(box(1.2, .03, .6, 0, -.015, 0));
  frame.add(top);
  const cup = box(.08, .1, .08, 1.2, .05 + .75 * .9, -2.1);
  const lamp = box(.2, 1.2, .2, 2.2, .6, -2);
  const scene = new THREE.Scene();
  scene.add(frame, cup, lamp);
  scene.updateMatrixWorld(true);
  return {frame, top, cup, lamp};
}

test('what rests on a part rides with it: a cup on a desk top that lifts, not the lamp beside it', () => {
  const {top, cup, lamp} = desk();
  assert.deepEqual(ridersOf(THREE, top, [cup, lamp]), [cup]);
  const saucer = new THREE.Mesh(new THREE.BoxGeometry(.12, .01, .12));
  cup.add(saucer);  // nested under the cup and resting on the top too: it moves with the cup only
  saucer.position.set(0, -.05, 0);
  cup.updateMatrixWorld(true);
  assert.deepEqual(ridersOf(THREE, top, [cup, saucer, lamp]), [cup]);
  cup.remove(saucer);
  top.updateMatrix(); cup.updateMatrix();
  const before = new THREE.Vector3().setFromMatrixPosition(cup.matrixWorld);
  const part = {joint: {type: 'prismatic', axis: [0, 1, 0], lower: 0, upper: .2}, node: top, rest: top.matrix.clone(),
    riders: [{node: cup, rest: cup.matrix.clone()}]};
  const parts = new Openings(THREE, [part], {render: () => {}, frame: () => {}});
  parts.set(part, .2);
  cup.parent.updateMatrixWorld(true);
  const lifted = new THREE.Vector3().setFromMatrixPosition(cup.matrixWorld);
  assert.ok(Math.abs(lifted.y - before.y - .2 * .9) < 1e-9, 'the cup rises with the top (0.2 in the stretched frame)');
  assert.ok(Math.abs(lifted.x - before.x) < 1e-9 && Math.abs(lifted.z - before.z) < 1e-9);
  parts.closeAll();
  cup.parent.updateMatrixWorld(true);
  assert.ok(cup.matrixAutoUpdate && close(cup.matrix.elements, part.riders[0].rest.elements, 1e-12), 'closed puts it back exactly');
});

test('a rider under a stretched parent swings rigidly with a hinged part', () => {
  const {carcass, door} = cabinet();
  const note = new THREE.Object3D();  // a sheet hanging under the same stretched carcass
  note.position.set(-.7, .9, .25);
  carcass.add(note);
  carcass.updateMatrixWorld(true);
  door.updateMatrix(); note.updateMatrix();
  const part = {joint: {type: 'revolute', axis: [0, -1, 0], lower: 0, upper: 1.5}, node: door, rest: door.matrix.clone(),
    riders: [{node: note, rest: note.matrix.clone()}]};
  const pts = corners.map((p) => p.clone().multiplyScalar(.1));
  const at = (object) => {carcass.updateMatrixWorld(true); return pts.map((p) => p.clone().applyMatrix4(object.matrixWorld));};
  const doorBefore = at(door), noteBefore = at(note);
  const parts = new Openings(THREE, [part], {render: () => {}, frame: () => {}});
  parts.set(part, 1.2);
  const doorAfter = at(door), noteAfter = at(note);
  for (let i = 0; i < pts.length; i++) {
    // the sheet keeps its place relative to the door: same distances to the door's points
    for (let j = 0; j < pts.length; j++) {
      assert.ok(Math.abs(noteBefore[i].distanceTo(doorBefore[j]) - noteAfter[i].distanceTo(doorAfter[j])) < 1e-9);
    }
  }
});
