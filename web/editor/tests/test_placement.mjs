import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {
  convexHull, sampleHull, sampleContactGeometry, coverage, inTriangle, polygonsOverlap, transformPoint, carryPose, createPlacement, seatBand,
} from '../placement.mjs';

const EPSILON = 1e-10;

// A table supports a payload, both built from the same horizontal faces as a room mesh.
function inventorySupportFixture() {
  const horizontal = (size, y) => [[[-size, y, -size], [size, y, -size], [size, y, size]], [[-size, y, -size], [size, y, size], [-size, y, size]]];
  const mesh = (name, triangles) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flat(2), 3));
    const object = new THREE.Mesh(geometry);
    object.name = name;
    return object;
  };
  const floor = mesh('Floor0', horizontal(3, 0));
  const table = mesh('Table', [...horizontal(1, 0), ...horizontal(1, 1)]);
  const payload = mesh('Payload', [...horizontal(.1, 1), ...horizontal(.1, 1.4)]);
  const room = new THREE.Group();
  room.add(floor, table, payload);
  const entities = new Map([['table', {name: 'table', group: table, origin: new THREE.Vector3()}],
    ['payload', {name: 'payload', group: payload, origin: new THREE.Vector3()}]]);
  const placement = createPlacement(THREE, room, entities, {table: {body: ['Table'], surfaces: ['Table']}, payload: {body: ['Payload']}}, 0, 4);
  return {placement, layout: {table: {x: 0, y: 0, z: 0, yaw: 0}, payload: {x: 0, y: 0, z: 0, yaw: 0}}};
}

test('hidden supports cannot hold objects; settling skips them and reaches the floor', () => {
  const {placement, layout} = inventorySupportFixture();
  assert.equal(placement.assess('payload', layout).support, 'table');
  layout.table.visible = false;
  assert.equal(placement.assess('payload', layout).state, 'draft');
  assert.equal(placement.assess('payload', layout).support, undefined);
  assert.equal(placement.settle('payload', layout).ok, true);
  assert.equal(layout.payload.y, -1);
  assert.equal(placement.assess('payload', layout).state, 'stable');
});

test('support moves carry visible payloads and leave stored payloads untouched', () => {
  const {placement, layout} = inventorySupportFixture();
  const moved = structuredClone(layout); moved.table.x = .5;
  assert.deepEqual(placement.carry('table', layout, moved).moved, ['table', 'payload']);
  assert.equal(moved.payload.x, .5);
  const hidden = structuredClone(layout); hidden.payload.visible = false;
  const next = structuredClone(hidden); next.table.x = .5;
  assert.deepEqual(placement.carry('table', hidden, next).moved, ['table']);
  assert.deepEqual(next.payload, hidden.payload);
  next.table.visible = false;
  assert.deepEqual(placement.carry('table', hidden, next).moved, []);
});

test('carryPose preserves explicit visibility and does not add it to old poses', () => {
  const parent = {x: 0, y: 0, z: 0, yaw: 0}, child = {...parent, visible: false};
  const next = {...parent, x: 1};
  assert.equal(carryPose(child, [0, 0, 0], parent, next, [0, 0, 0]).visible, false);
  assert.equal(Object.hasOwn(carryPose(parent, [0, 0, 0], parent, next, [0, 0, 0]), 'visible'), false);
});
const rectangle = (left, bottom, right, top) => [
  [[left, bottom], [right, bottom], [right, top]],
  [[left, bottom], [right, top], [left, top]],
];
const corners = (left, bottom, right, top) => [
  [left, bottom], [right, bottom], [right, top], [left, top],
];
function close(actual, expected, label = 'coordinate') {
  assert.ok(Math.abs(actual - expected) < EPSILON,
    `${label}: expected ${expected}, received ${actual}`);
}
function closePoint(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, axis) => close(value, expected[axis], `axis ${axis}`));
}

test('wall fixtures avoid opening volumes even when the wall mesh has no hole', () => {
  const door = corners(0, 0, 1, 2);
  assert.equal(polygonsOverlap(corners(.2, .5, .8, 1.5), door), true);
  assert.equal(polygonsOverlap(corners(-1, -1, 2, 3), door), true);
  assert.equal(polygonsOverlap(corners(1.01, .5, 2, 1.5), door), false);
  assert.equal(polygonsOverlap(corners(1, .5, 2, 1.5), door), false);
});

test('triangle coverage accepts both windings and shared edges but rejects exterior and degenerate faces', () => {
  const triangle = [[0, 0], [2, 0], [0, 2]];
  for (const face of [triangle, [...triangle].reverse()]) {
    assert.equal(inTriangle([.3, .4], face), true);
    assert.equal(inTriangle([1, 1], face), true, 'shared diagonal has no crack');
    assert.equal(inTriangle([0, 0], face), true);
    assert.equal(inTriangle([1.1, 1.1], face), false);
    assert.equal(inTriangle([-.01, .3], face), false);
  }
  assert.equal(inTriangle([1, 0], [[0, 0], [1, 0], [2, 0]]), false);
});

test('contact hull retains extreme supports and removes duplicate, interior and collinear points', () => {
  const points = [[1, 1], [0, 0], [2, 0], [2, 2], [0, 2], [0, 0], [1, 0], [2, 1]];
  const original = structuredClone(points);
  assert.deepEqual(convexHull(points), corners(0, 0, 2, 2));
  assert.deepEqual(points, original, 'source contact vertices are preserved');
  assert.deepEqual(convexHull([[2, 0], [0, 0], [1, 0], [1, 0]]), [[0, 0], [2, 0]]);
  assert.deepEqual(convexHull([]), []);
});

test('a supported center does not hide an overhanging contact edge', () => {
  const surface = rectangle(-1, -1, 1, 1);
  assert.equal(coverage([[0, 0]], surface).full, true);
  assert.equal(coverage(sampleHull(corners(-.8, -.8, .8, .8)), surface).full, true);
  const overhang = sampleHull(corners(-1.2, -.8, 1.2, .8));
  const hit = coverage(overhang, surface);
  assert.equal(hit.full, false);
  assert.ok(hit.covered > 0 && hit.covered < hit.total);
  assert.equal(hit.total, overhang.length);
});

test('separate desk feet can descend around a cabinet without inventing contact in the empty middle', () => {
  const footFaces = [-1, 1].flatMap((x) => [-.65, .65].flatMap((z) =>
    rectangle(x - .08, z - .08, x + .08, z + .08)
      .map((face) => face.map(([px, pz]) => [px, 0, pz]))));
  // A connected tabletop is well above the contact band and must not bridge feet.
  const topFaces = rectangle(-1.2, -.85, 1.2, .85)
    .map((face) => face.map(([x, z]) => [x, .8, z]));
  const feet = sampleContactGeometry([...footFaces, ...topFaces], 0);
  const cabinet = rectangle(-.4, -.4, .4, .4);
  const inventedBase = sampleHull(convexHull(feet));
  assert.ok(coverage(inventedBase, cabinet).covered > 0, 'previous enclosing hull falsely hits the cabinet');
  assert.equal(coverage(feet, cabinet).covered, 0, 'actual feet do not touch the cabinet');
  assert.equal(coverage(feet, rectangle(-2, -2, 2, 2)).full, true, 'all real feet can land on the floor');
  assert.ok(feet.every(([x, z]) => Math.abs(x) >= .92 - EPSILON && Math.abs(z) >= .57 - EPSILON));
});

test('an actual foot crossing a support edge remains blocked after separating contact patches', () => {
  const feet = [-.8, .8].flatMap((x) => rectangle(x - .1, -.1, x + .1, .1)
    .map((face) => face.map(([px, z]) => [px, 0, z])));
  const samples = sampleContactGeometry(feet, 0);
  const clippedSupport = rectangle(-1, -.2, .85, .2);
  const hit = coverage(samples, clippedSupport);
  assert.ok(hit.covered > 0);
  assert.equal(hit.full, false, 'outer part of the right foot is unsupported');
  assert.equal(coverage(samples, rectangle(-1, -.2, 1, .2)).full, true);
});

test('contact sampling clips slanted geometry to its lowest band and preserves a hollow contact region', () => {
  const slanted = [[[-.1, 0, 0], [.1, 0, 0], [2, 1, 0]]];
  const clipped = sampleContactGeometry(slanted, 0, .025);
  assert.ok(clipped.length > 1);
  assert.ok(clipped.every(([x, z]) => x >= -.1 && x <= .1475 + EPSILON && z === 0));
  const ring = [
    ...rectangle(-1, -1, -.5, 1), ...rectangle(.5, -1, 1, 1),
    ...rectangle(-.5, -1, .5, -.5), ...rectangle(-.5, .5, .5, 1),
  ].map((face) => face.map(([x, z]) => [x, 0, z]));
  const samples = sampleContactGeometry(ring, 0);
  assert.equal(coverage(samples, rectangle(-.4, -.4, .4, .4)).covered, 0, 'a connected ring still has a real hole');
  assert.deepEqual(sampleContactGeometry([], 0), []);
  assert.deepEqual(sampleContactGeometry([[[0, 1, 0], [1, 1, 0], [0, 1, 1]]], 0), []);
});

test('wall triangles surrounding a window do not cover a mounting patch across the opening', () => {
  const wall = [
    ...rectangle(-2, -2, -.5, 2),
    ...rectangle(.5, -2, 2, 2),
    ...rectangle(-.5, -2, .5, -.5),
    ...rectangle(-.5, .5, .5, 2),
  ];
  const patch = corners(-1, -1, 1, 1);
  assert.equal(coverage(patch, wall).full, true, 'all four patch corners touch solid wall');
  assert.equal(coverage(sampleHull(patch), wall).full, false, 'interior samples detect the window');
  assert.equal(coverage(sampleHull(corners(-1.9, -.8, -.7, .8)), wall).full, true);
});

test('interior spokes detect a large off-center hole even when center and boundary are supported', () => {
  const wall = [
    ...rectangle(-1, -1, .2, 1),
    ...rectangle(.6, -1, 1, 1),
    ...rectangle(.2, -1, .6, .2),
    ...rectangle(.2, .6, .6, 1),
  ];
  const patch = corners(-.9, -.9, .9, .9);
  assert.equal(coverage([...patch, [0, 0]], wall).full, true);
  assert.equal(coverage(sampleHull(patch), wall).full, false);
});

test('empty contact geometry cannot be reported as fully supported', () => {
  assert.deepEqual(sampleHull([]), []);
  assert.deepEqual(coverage([], rectangle(-1, -1, 1, 1)), {covered: 0, total: 0, full: false});
  assert.deepEqual(coverage([[0, 0]], []), {covered: 0, total: 1, full: false});
});

test('rotating a contact footprint changes whether it fits a narrow support surface', () => {
  const origin = [3, 0, -2];
  const footprint = sampleHull(corners(2.7, -3, 3.3, -1));
  const surface = rectangle(2.5, -3.2, 3.5, -.8);
  const project = (yaw) => footprint.map(([x, z]) => {
    const point = transformPoint([x, .7, z], origin, {x: 0, y: 0, z: 0, yaw});
    close(point[1], .7, 'yaw preserves support height');
    return [point[0], point[2]];
  });
  assert.equal(coverage(project(0), surface).full, true);
  assert.equal(coverage(project(Math.PI / 2), surface).full, false);
  assert.equal(coverage(project(Math.PI), surface).full, true);
});

test('world transforms rotate about the authored object origin and add height without rotating it', () => {
  const origin = Object.freeze([10, 7, 20]);
  const point = Object.freeze([11, 8, 22]);
  const pose = Object.freeze({x: 3, y: .5, z: -4, yaw: Math.PI / 2});
  closePoint(transformPoint(point, origin, pose), [15, 8.5, 15]);
  closePoint(transformPoint(origin, origin, pose), [13, 7.5, 16]);
  closePoint(transformPoint(point, origin, {x: 0, z: 0, yaw: 0}), point);
});

test('an attached object follows a support already translated and rotated in the floor plane and height', () => {
  const parentOrigin = Object.freeze([10, 0, 20]);
  const childOrigin = Object.freeze([11, .8, 20]);
  const child = Object.freeze({x: 1, y: .5, z: 0, yaw: Math.PI / 2});
  const oldParent = Object.freeze({x: 2, y: .5, z: -1, yaw: Math.PI / 2});
  const nextParent = Object.freeze({x: -1, y: 1.25, z: 3, yaw: Math.PI});
  const carried = carryPose(child, childOrigin, oldParent, nextParent, parentOrigin);
  closePoint([carried.x, carried.y, carried.z, carried.yaw], [-1, 1.25, 3, Math.PI]);
  closePoint(transformPoint(childOrigin, childOrigin, carried), [10, 2.05, 23]);
  // A point one unit along the authored child X axis turns with the support.
  closePoint(transformPoint([12, .8, 20], childOrigin, carried), [9, 2.05, 23]);
  const restored = carryPose(carried, childOrigin, nextParent, oldParent, parentOrigin);
  closePoint([restored.x, restored.y, restored.z, restored.yaw], [child.x, child.y, child.z, child.yaw]);
});

test('support translation preserves attached orientation and height offset; rotation wraps yaw', () => {
  const origin = [0, 0, 0], childOrigin = [1, .7, 2];
  const child = {x: .2, y: .3, z: -.4, yaw: 3};
  const before = {x: 0, y: .1, z: 0, yaw: .5};
  const translated = {x: .4, y: .6, z: -.2, yaw: .5};
  const carried = carryPose(child, childOrigin, before, translated, origin);
  closePoint([carried.x, carried.y, carried.z, carried.yaw], [.6, .8, -.6, 3]);
  const turned = carryPose(carried, childOrigin, translated, {...translated, yaw: .9}, origin);
  close(turned.yaw, 3.4 - 2 * Math.PI, 'wrapped attached orientation');
  close(turned.y, carried.y, 'yaw leaves height unchanged');
  const childWorld = transformPoint(childOrigin, childOrigin, carried);
  const turnedWorld = transformPoint(childOrigin, childOrigin, turned);
  const distance = (point) => Math.hypot(point[0] - translated.x, point[2] - translated.z);
  close(distance(childWorld), distance(turnedWorld), 'rotation preserves distance from support origin');
});

test('the seat is the highest horizontal face seen from above, not its larger underside or the arms', () => {
  const square = (x0, z0, x1, z1, y) => [[[x0, y, z0], [x1, y, z0], [x1, y, z1]], [[x0, y, z0], [x1, y, z1], [x0, y, z1]]];
  const chair = [
    ...square(-.25, -.25, .25, .25, .45),   // underside and base plate, larger than the seat
    ...square(-.2, -.2, .2, .2, .48),       // seat top
    ...square(-.3, -.2, -.26, .2, .65),     // arm tops
    ...square(.26, -.2, .3, .2, .65),
    ...square(-.2, .2, .2, .24, .9),        // back top, above the search range
  ];
  const [low, high] = seatBand(chair, 0);
  assert(low < .48 && .48 < high && high < .65, `${low}-${high}`);
  assert.equal(seatBand(square(-.2, -.2, .2, .2, 1.2), 0), null, 'nothing in seat range');
});

test('support coverage on a binned surface matches testing every triangle', () => {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const triangles = Array.from({length: 400}, () => {
    const c = [rnd() * 3, rnd() * 2];
    return [0, 1, 2].map(() => [c[0] + (rnd() - .5) * .3, c[1] + (rnd() - .5) * .3]);
  });
  // Points on edges and corners exercise the tolerance at cell borders.
  const points = [...Array.from({length: 3000}, () => [rnd() * 3.4 - .2, rnd() * 2.4 - .2]),
    ...triangles.slice(0, 200).flatMap(([a, b]) => [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]])];
  const brute = points.filter((p) => triangles.some((t) => inTriangle(p, t))).length;
  const result = coverage(points, triangles);
  assert.equal(result.covered, brute);
  assert.ok(brute > 500 && brute < points.length);
  for (const p of points.slice(0, 600)) assert.equal(coverage([p], triangles).covered, triangles.some((t) => inTriangle(p, t)) ? 1 : 0);
});

test('coverage of 200,000 support triangles preserves the mesh edges, gaps and far corner', () => {
  const triangles = [];
  for (let x = 0; x < 400; x++) for (let z = 0; z < 250; z++) {
    // Separate tiles leave real gaps inside the overall bounds.
    triangles.push(...rectangle(x, z, x + .8, z + .8));
  }
  const points = [[0, 0], [120.4, 40.4], [399.8, 249.8], [.9, .9], [400, 250]];
  assert.deepEqual(coverage(points, triangles), {covered: 3, total: 5, full: false});
});
