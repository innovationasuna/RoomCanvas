import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {walkDirection, slide, spots, createBody, createWalk, RADIUS} from '../walk.mjs';

const near = (a, b, eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps);

// A 4 x 3 m room around the origin: floor at 0, 2.5 m walls, a 2 x 1.6 m bed in the middle.
function room() {
  const root = new THREE.Group();
  const box = (size, at) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial());
    mesh.position.set(...at); root.add(mesh); return mesh;
  };
  box([4, .1, 3], [0, -.05, 0]);
  box([.1, 2.5, 3], [-2.05, 1.25, 0]); box([.1, 2.5, 3], [2.05, 1.25, 0]);
  box([4, 2.5, .1], [0, 1.25, -1.55]); box([4, 2.5, .1], [0, 1.25, 1.55]);
  box([2, .5, 1.6], [0, .25, 0]);
  root.updateMatrixWorld(true);
  return root;
}

test('keys walk relative to where the camera faces', () => {
  assert.equal(walkDirection(new Set(), 0), null);
  assert.ok(near(walkDirection(new Set(['KeyW']), 0), [0, -1]));
  assert.ok(near(walkDirection(new Set(['KeyD']), 0), [1, 0]));
  // Turned a quarter to the left, forward is -X.
  assert.ok(near(walkDirection(new Set(['ArrowUp']), Math.PI / 2), [-1, 0]));
  // Two keys together walk diagonally at the same speed; opposite keys cancel.
  const diagonal = walkDirection(new Set(['KeyW', 'KeyD']), 0);
  assert.ok(near(diagonal, [Math.SQRT1_2, -Math.SQRT1_2]));
  assert.equal(walkDirection(new Set(['KeyW', 'KeyS']), 0), null);
});

test('a step stops short of a wall and slides along it', () => {
  // A wall along x = 1, facing -X.
  const cast = ([x], [dx]) => dx > 0 ? {gap: 1 - x - RADIUS, normal: [-1, 0]} : null;
  assert.ok(near(slide([0, 0], [.3, 0], cast), [.3, 0]));
  const [x] = slide([.6, 0], [.5, 0], cast);
  assert.ok(x < 1 - RADIUS && x > 1 - RADIUS - .02);
  // Walking into it at 45°: the part along the wall is kept.
  const [sx, sz] = slide([1 - RADIUS - .01, 0], [.2, .2], cast);
  assert.ok(sx <= 1 - RADIUS && Math.abs(sz - .2) < .02);
});

test('rays stop the body at walls and furniture, not at the floor', () => {
  const body = createBody(THREE, {room: room(), floorY: 0, solid: () => true});
  // From x = -1.5 toward the bed (its side at x = -1): the body's middle can go 0.5 - RADIUS.
  const bed = body.cast([-1.5, 0], [1, 0], 2);
  assert.ok(Math.abs(bed.gap - (.5 - RADIUS)) < 1e-6);
  assert.ok(near(bed.normal, [-1, 0]));
  // Past the bed's end, the wall at x = 2 is what stops it.
  const wall = body.cast([-1.5, 1.2], [1, 0], 5);
  assert.ok(Math.abs(wall.gap - (3.5 - RADIUS)) < 1e-6);
  // The edge rays catch the bed's corner, which the middle ray passes.
  const corner = body.cast([-1.5, .9], [1, 0], 2);
  assert.ok(corner && corner.gap < .5);
});

test('the walk starts beside the bed, never on it', () => {
  const body = createBody(THREE, {room: room(), floorY: 0, solid: () => true});
  assert.equal(body.free([0, 0]), false);
  assert.equal(body.free([-1.6, 0]), true);
  const bounds = {min: [-2 + RADIUS, -1.5 + RADIUS], max: [2 - RADIUS, 1.5 - RADIUS]};
  const first = [...spots([0, 0], bounds)].find(body.free);
  assert.ok(first && (Math.abs(first[0]) > 1 || Math.abs(first[1]) > .8));
  // Hidden things do not count.
  const ghost = createBody(THREE, {room: room(), floorY: 0, solid: (hit) => hit.point.y < .1 || Math.abs(hit.point.x) > 1.9 || Math.abs(hit.point.z) > 1.4});
  assert.equal(ghost.free([0, 0]), true);
});

test('walking reserves mouse left clicks for objects and middle drags for looking, while touch still works', t => {
  const globals = ['document', 'window', 'cancelAnimationFrame'];
  const original = globals.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const canvas = new EventTarget();
  canvas.getBoundingClientRect = () => ({left: 0, top: 0, width: 800, height: 600});
  canvas.setPointerCapture = () => {};
  Object.assign(globalThis, {document: new EventTarget(), window: new EventTarget(), cancelAnimationFrame() {}});
  let walk, clicks = 0;
  t.after(() => {
    walk?.exit();
    globals.forEach((key, index) => {
      if (original[index]) Object.defineProperty(globalThis, key, original[index]); else delete globalThis[key];
    });
  });
  walk = createWalk(THREE, {canvas, room: room(), floorY: 0, bounds: {min: [-2, -1.5], max: [2, 1.5]},
    solid: () => true, onChange() {}, onClick() {clicks++;}, onExit() {}});
  walk.enter();
  const pointer = (type, button, x = 100, y = 100, pointerType = 'mouse') => canvas.dispatchEvent(Object.assign(
    new Event(type, {cancelable: true}), {button, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType}));
  const initial = walk.snapshot();

  pointer('pointerdown', 0); pointer('pointermove', 0, 180, 140); pointer('pointerup', 0, 180, 140);
  assert.deepEqual(walk.snapshot(), initial, 'left dragging must never turn or move the camera');
  assert.equal(clicks, 0, 'a left drag is not an object click');
  pointer('pointerdown', 0); pointer('pointerup', 0);
  assert.equal(clicks, 1, 'left clicking still operates objects');

  pointer('pointerdown', 1); pointer('pointermove', 1, 180, 140); pointer('pointerup', 1, 180, 140);
  const turned = walk.snapshot();
  assert.notEqual(turned.yaw, initial.yaw);
  assert.notEqual(turned.pitch, initial.pitch);
  assert.deepEqual(turned.position, initial.position, 'middle dragging turns without translating');
  pointer('pointerdown', 1); pointer('pointerup', 1);
  assert.equal(clicks, 1, 'middle clicking never operates an object');

  pointer('pointerdown', 1); window.dispatchEvent(new Event('blur')); pointer('pointermove', 1, 200, 180);
  assert.deepEqual(walk.snapshot(), turned, 'losing focus ends the camera drag');
  pointer('pointerdown', 0, 100, 100, 'touch'); pointer('pointermove', 0, 150, 100, 'touch'); pointer('pointerup', 0, 150, 100, 'touch');
  assert.notEqual(walk.snapshot().yaw, turned.yaw, 'touch dragging remains available');
  assert.equal(clicks, 1);
});
