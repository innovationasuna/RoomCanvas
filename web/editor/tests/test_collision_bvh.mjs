import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {buildCollision, sweepTriangle, triangleIndex} from '../collision.mjs';
import {createRayQueries} from '../ray-queries.mjs';
import {nodeBox, nodeFaces, readFace} from '../triangle-index.mjs';

const triangleAt = (x, y = 0, z = 0, size = .4) => [[x, y, z], [x + size, y, z], [x, y + size, z]];

function boundsOf(triangles) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const triangle of triangles) for (const point of triangle) for (let axis = 0; axis < 3; axis++) {
    box[axis] = Math.min(box[axis], point[axis]);
    box[axis + 3] = Math.max(box[axis + 3], point[axis]);
  }
  return box;
}

function checkTree(triangles, excluded = new Set()) {
  // Construction may rearrange index records, never the authored faces or points.
  for (const triangle of triangles) {
    triangle.forEach(Object.freeze);
    Object.freeze(triangle);
  }
  Object.freeze(triangles);
  const index = triangleIndex(triangles), seen = new Set(), visitedNodes = new Set();
  const expected = triangles.flatMap((_, i) => excluded.has(i) ? [] : [i]);
  assert.equal(index.triangles, triangles, 'geometry remains shared with its immutable source');
  assert.ok(index.data instanceof Float64Array, 'face bounds and planes retain double precision');
  assert.equal(index.data.length, triangles.length * 10, 'original face IDs address their own metadata');
  assert.ok(index.faces instanceof Uint32Array, 'root ordering stores numeric face IDs');
  assert.deepEqual(Array.from(index.faces).sort((a, b) => a - b), expected);
  assert.equal(triangleIndex(triangles), index, 'reusing immutable geometry retains its index');
  for (const faceId of index.faces) {
    const face = readFace(index, faceId);
    assert.equal(face.faceIndex, faceId);
    assert.equal(face.triangle, triangles[face.faceIndex]);
    assert.deepEqual(Array.from(face.box), boundsOf([face.triangle]));
    assert.ok(face.plane.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...face.plane) - 1) < 1e-12);
    assert.equal(face.d, face.plane[0] * face.triangle[0][0] + face.plane[1] * face.triangle[0][1] + face.plane[2] * face.triangle[0][2]);
  }
  if (!expected.length) {assert.equal(index.tree, null); return;}
  const tree = index.tree;
  assert.ok(tree.boxes instanceof Float64Array, 'node bounds retain double precision');
  assert.ok(tree.links instanceof Uint32Array, 'node links and leaf ranges are numeric');
  assert.ok(tree.order instanceof Uint32Array, 'leaves retain face IDs without face objects');
  assert.equal(tree.boxes.length % 6, 0);
  const nodeCount = tree.boxes.length / 6;
  assert.equal(tree.links.length, nodeCount * 4);
  assert.equal(tree.order.length, expected.length);
  assert.deepEqual(tree.box, Array.from(nodeBox(tree, 0)));
  function visit(node) {
    assert.ok(node >= 0 && node < nodeCount && !visitedNodes.has(node), 'each node has one valid parent');
    visitedNodes.add(node);
    let faces;
    const leaf = nodeFaces(tree, node);
    if (leaf) {
      assert.ok(leaf.length > 0 && leaf.length <= 10, 'nonempty bounded leaves');
      faces = Array.from(leaf);
      for (const faceId of faces) {
        assert.ok(!seen.has(faceId), 'a face occurs in exactly one leaf');
        seen.add(faceId);
        assert.equal(readFace(index, faceId).triangle, triangles[faceId]);
      }
    } else {
      const left = tree.links[node * 4], right = tree.links[node * 4 + 1];
      assert.notEqual(left, right, 'both children cover separate partitions');
      faces = [...visit(left), ...visit(right)];
    }
    assert.deepEqual(Array.from(nodeBox(tree, node)), boundsOf(faces.map(faceId => triangles[faceId])), 'tight bounds cover all descendants');
    return faces;
  }
  visit(0);
  assert.equal(visitedNodes.size, nodeCount, 'compact buffers contain only reachable nodes');
  assert.deepEqual([...seen].sort((a, b) => a - b), expected);
}

test('BVH leaves cover every original face across empty, small and uneven partitions', () => {
  for (const count of [0, 1, 10, 11, 21, 65, 257]) {
    checkTree(Array.from({length: count}, (_, i) => triangleAt(i * .7, i % 3, i % 7)));
  }
});

test('BVH partitioning handles sorted, reversed, coincident and highly uneven centers', () => {
  const sorted = Array.from({length: 257}, (_, i) => triangleAt((i - 128) / 10));
  const repeated = Array.from({length: 257}, (_, i) => triangleAt(Math.floor(i / 17), 0, 0));
  const coincident = Array.from({length: 257}, (_, i) => {
    const size = 1 + i % 7;
    return [[-size, -size, 0], [size, -size, 0], [0, size, 0]];
  });
  const uneven = Array.from({length: 257}, (_, i) => triangleAt(i / 1e6, i % 3 / 1e6, 0, .123456789012345));
  uneven.splice(17, 0, triangleAt(-1e8, 0, 0), triangleAt(1e8, 0, 0));
  for (const triangles of [sorted, sorted.toReversed(), repeated, coincident, uneven]) checkTree(triangles);
});

test('discarding degenerate faces preserves the original numbering of retained faces', () => {
  const triangles = Array.from({length: 33}, (_, i) => triangleAt(i));
  const degenerate = [
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
    [[0, 0, 0], [1e-6, 0, 0], [0, 1e-6, 0]],
  ];
  triangles.splice(0, 0, degenerate[0]);
  triangles.splice(11, 0, degenerate[1]);
  triangles.push(degenerate[2]);
  checkTree(triangles, new Set([0, 11, triangles.length - 1]));
  checkTree([...degenerate], new Set([0, 1, 2]));
});

test('partitioning retains the stable root-axis face order used by connected-piece analysis', () => {
  const centers = Array.from({length: 65}, (_, i) => ((i * 37) % 17) * 4);
  const expected = centers.map((_, i) => i).sort((a, b) => centers[a] - centers[b]);
  for (const axis of [0, 1, 2]) {
    const triangles = centers.map((center, i) => {
      const size = 1 + i % 3;
      return [[center - size, -1, 0], [center + size, -1, 0], [center, 1, 0]]
        .map(point => point.map((_, k) => point[(k - axis + 3) % 3]));
    });
    assert.deepEqual(Array.from(triangleIndex(triangles).faces), expected);
  }
});

test('BVH rays retain the original stable-sort traversal result across axis changes and equal-distance faces', () => {
  const usedAxes = new Set();
  // Keep the old builder and traversal as a behavioral reference. The new tree
  // may have different partitions, but its equal-distance hit must stay the same.
  function reference(faces) {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const face of faces) for (let axis = 0; axis < 3; axis++) {
      if (face.box[axis] < box[axis]) box[axis] = face.box[axis];
      if (face.box[axis + 3] > box[axis + 3]) box[axis + 3] = face.box[axis + 3];
    }
    if (faces.length <= 10) return {box, faces};
    let axis = 0;
    for (let k = 1; k < 3; k++) if (box[k + 3] - box[k] > box[axis + 3] - box[axis]) axis = k;
    usedAxes.add(axis);
    faces.sort((a, b) => a.box[axis] + a.box[axis + 3] - b.box[axis] - b.box[axis + 3]);
    const mid = faces.length >> 1;
    return {box, left: reference(faces.slice(0, mid)), right: reference(faces.slice(mid))};
  }
  function oldNearest(tree, ray, accept) {
    let best = null, distance = Infinity, tied = false;
    const point = new THREE.Vector3();
    function entry(box) {
      let low = 0, high = distance;
      for (let k = 0; k < 3; k++) {
        const origin = ray.origin.getComponent(k), direction = ray.direction.getComponent(k);
        if (Math.abs(direction) < 1e-15) {if (origin < box[k] || origin > box[k + 3]) return Infinity; continue;}
        const t0 = (box[k] - origin) / direction, t1 = (box[k + 3] - origin) / direction;
        low = Math.max(low, Math.min(t0, t1)); high = Math.min(high, Math.max(t0, t1));
        if (low > high) return Infinity;
      }
      return low;
    }
    function visit(node) {
      if (entry(node.box) === Infinity) return;
      if (!node.faces) {
        if (entry(node.left.box) <= entry(node.right.box)) {visit(node.left); visit(node.right);}
        else {visit(node.right); visit(node.left);}
        return;
      }
      for (const face of node.faces) {
        if (!ray.intersectTriangle(...face.points, false, point)) continue;
        const d = point.distanceTo(ray.origin);
        if (d > distance || d < 0) continue;
        const hit = {distance: d, point: point.clone(), faceIndex: face.faceIndex, normal: face.normal,
          face: {materialIndex: face.faceIndex % 2}};
        if (!accept(hit)) continue;
        tied = d === distance && best !== null;
        best = hit; distance = d;
      }
    }
    visit(tree);
    return {hit: best, tied};
  }
  const cloud = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
    // Different shapes with identical boxes exercise ties on every axis.
    cloud.push([[x * 4, y * 3, z * 2], [x * 4 + .5, y * 3, z * 2 + .5], [x * 4, y * 3 + .5, z * 2 + .5]],
      [[x * 4 + .5, y * 3, z * 2], [x * 4, y * 3 + .5, z * 2], [x * 4 + .5, y * 3 + .5, z * 2 + .5]]);
  }
  const shuffled = [...cloud, ...cloud.slice(0, 33)];
  let seed = 108;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const cases = [cloud, cloud.toReversed(), shuffled, Array.from({length: 129}, (_, i) => cloud[i % 2]),
    Array.from({length: 161}, (_, i) => triangleAt((i % 11) / 10, (Math.floor(i / 11) % 7) / 10, (i % 3) / 10, .15))];
  let tiedQueries = 0;
  for (const [i, triangles] of cases.entries()) {
    const tree = reference(triangles.map((triangle, faceIndex) => {
      const points = triangle.map(point => new THREE.Vector3(...point));
      return {faceIndex, points, box: boundsOf([triangle]), normal: THREE.Triangle.getNormal(...points, new THREE.Vector3())};
    }));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float64Array(triangles.flat(2)), 3));
    triangles.forEach((_, faceIndex) => geometry.addGroup(faceIndex * 3, 3, faceIndex % 2));
    const materials = [0, 1].map(() => new THREE.MeshBasicMaterial({side: THREE.DoubleSide}));
    const room = new THREE.Group(); room.add(new THREE.Mesh(geometry, materials));
    const queries = createRayQueries(THREE, room);
    for (let f = 0; f < triangles.length; f += Math.max(1, Math.floor(triangles.length / 12))) {
      const triangle = triangles[f], center = [0, 1, 2].map(k => triangle.reduce((sum, p) => sum + p[k], 0) / 3);
      for (const point of [...triangle, center]) for (const axis of [0, 1, 2]) for (const sign of [-1, 1]) {
        const origin = new THREE.Vector3(...point).setComponent(axis, tree.box[axis + (sign < 0 ? 3 : 0)] - sign);
        const direction = new THREE.Vector3().setComponent(axis, sign), ray = new THREE.Ray(origin, direction);
        for (const accept of [() => true, hit => hit.face.materialIndex === 0]) {
          const {hit: expected, tied} = oldNearest(tree, ray, accept);
          const actual = queries.nearest(origin, direction, Infinity, accept);
          if (tied) tiedQueries++;
          const label = `geometry ${i}, face ${f}, axis ${axis}, direction ${sign}`;
          assert.equal(actual?.faceIndex, expected?.faceIndex, label);
          assert.equal(actual?.face.materialIndex, expected?.face.materialIndex, label);
          if (expected) {
            assert.ok(Math.abs(actual.distance - expected.distance) < 1e-12, label);
            assert.ok(actual.point.distanceTo(expected.point) < 1e-12, label);
            assert.ok(actual.normal.distanceTo(expected.normal) < 1e-12, label);
          } else assert.equal(actual, null, label);
        }
      }
    }
  }
  assert.deepEqual([...usedAxes].sort(), [0, 1, 2]);
  assert.ok(tiedQueries > 0, 'the reference observes actual nearest-distance ties');
});

test('a ray on a shared edge retains the original face and normal when several distances tie', () => {
  const flat = [[0, 0, 0], [-1, 0, 0], [0, 0, 10]], sloped = [[0, 0, 0], [0, 0, 10], [1, -.5, 0]];
  const triangles = Array.from({length: 21}, (_, i) => i === 10 ? sloped : flat);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(triangles.flat(2), 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({side: THREE.DoubleSide})), room = new THREE.Group();
  room.add(mesh);
  const hit = createRayQueries(THREE, room).nearest(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, -1, 0));
  assert.equal(hit?.faceIndex, 20);
  assert.equal(hit.distance, 1);
  assert.deepEqual(hit.normal.toArray(), [0, 1, 0]);
});

test('BVH grouping preserves scanned-overlap decisions for equal-area near-parallel faces', () => {
  const slope = 1e-5, width = Math.hypot(slope * 10, 10) / 10;
  const a = [0, 0, 0], b = [0, 0, 10], left = [-width, 0, 0], right = [1, -slope, 0];
  // Equal-area top faces share a rounded normal direction. Connected-piece
  // analysis must retain the same representative when the BVH is regrouped.
  const top = [[a, left, b], [a, b, right]];
  const lower = new Map([a, b, left, right].map(point => [point, [point[0], -.5, point[2]]]));
  const wedge = [...top, ...top.map(triangle => triangle.map(point => lower.get(point)).reverse())];
  for (const [p, q] of [[left, a], [a, right], [right, b], [b, left]]) {
    wedge.push([p, q, lower.get(p)], [q, lower.get(q), lower.get(p)]);
  }
  const vertices = [[.25, -.02, .5], [.35, -.02, .5], [.35, .08, .5], [.25, .08, .5],
    [.25, -.02, .6], [.35, -.02, .6], [.35, .08, .6], [.25, .08, .6]];
  const box = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]]
    .map(face => face.map(i => vertices[i]));
  const owner = (id, triangles) => ({id, name: id, meshes: [{name: id, triangles}]});
  const pose = (x = 0, y = 0) => ({x, y, z: 0, yaw: 0});
  const collision = buildCollision([owner('box', box), owner('wedge', wedge.toReversed())], {keepAuthoredOverlaps: true});
  const before = {box: pose()};
  assert.equal(collision.checkPlacement(before, ['box']).ok, true, 'authored overlap is allowed');
  for (const [x, y, blocked, fraction] of [[-.6, -.004999, true, .9993666180234925], [.3, -.005001, false, 1]]) {
    const next = {box: pose(x, y)}, contact = collision.checkPlacement(next, ['box']);
    assert.equal(contact.ok, !blocked);
    assert.equal(contact.reason, blocked ? 'deeper' : null);
    const sweep = collision.limit(before, next, ['box']);
    assert.equal(sweep.blocked, blocked);
    assert.ok(Math.abs(sweep.fraction - fraction) < 1e-10);
  }
});

test('BVH continuous collision agrees with an exhaustive triangle sweep through scattered walls', () => {
  const moving = [[0, .2, .2], [0, .8, .2], [0, .2, .8]];
  const walls = Array.from({length: 129}, (_, i) => {
    const x = (i - 64) * .25 + .125, y = (i % 4 - 1) * 2, z = (i % 3 - 1) * 2;
    return [[x, y, z], [x, y + 1, z], [x, y, z + 1]];
  });
  const pose = (x = 0, y = 0, z = 0) => ({x, y, z, yaw: 0});
  const owner = (id, triangles) => ({id, name: id, meshes: [{name: id, triangles}]});
  for (const triangles of [walls, walls.toReversed()]) {
    const collision = buildCollision([owner('moving', [moving]), owner('walls', triangles)]);
    for (const delta of [[10, 0, 0], [-10, 0, 0], [10, 1, 0], [10, 0, 1], [0, 5, 0]]) {
      const hits = triangles.map(triangle => sweepTriangle(moving, triangle, delta)).filter(hit => hit !== null);
      const first = hits.length ? Math.min(...hits) : 1;
      const result = collision.limit({moving: pose()}, {moving: pose(...delta)}, ['moving']);
      assert.equal(result.blocked, first < 1, JSON.stringify(delta));
      if (first < 1) {
        assert.equal(result.other.id, 'walls');
        assert.ok(result.fraction <= first && first - result.fraction < 1e-4, 'stops just before the first real face');
      } else assert.equal(result.fraction, 1);
    }
  }
});

test('BVH rays match exhaustive Three rays, including original face indices, materials and rejected front hits', () => {
  const triangles = [[[0, 0, 0], [0, 0, 0], [0, 0, 0]]], targets = [];
  for (let x = 0; x < 10; x++) for (let y = 0; y < 8; y++) {
    triangles.push(triangleAt(x, y, 0, .8), triangleAt(x, y, .2 + (x % 3) * .01, .8));
    targets.push([x + .2, y + .2, 3]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float64Array(triangles.flat(2)), 3));
  triangles.forEach((_, i) => geometry.addGroup(i * 3, 3, i % 2));
  const materials = [0, 1].map(() => new THREE.MeshBasicMaterial({side: THREE.DoubleSide}));
  const mesh = new THREE.Mesh(geometry, materials), room = new THREE.Group();
  mesh.position.set(.35, -.1, .2); mesh.rotation.y = .17; mesh.scale.set(1.2, .8, 1.5);
  room.add(mesh);
  const queries = createRayQueries(THREE, room), ray = new THREE.Raycaster();
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(mesh.matrixWorld);
  const compare = (point, accept = () => true, far = Infinity) => {
    ray.set(new THREE.Vector3(...point).applyMatrix4(mesh.matrixWorld), direction);
    ray.far = far;
    const expected = ray.intersectObject(room, true).find(accept);
    const actual = queries.nearest(ray.ray.origin, ray.ray.direction, far, accept);
    assert.equal(actual?.faceIndex, expected?.faceIndex, JSON.stringify(point));
    assert.equal(actual?.face.materialIndex, expected?.face.materialIndex);
    if (expected) {
      assert.equal(actual.object, mesh);
      assert.ok(Math.abs(actual.distance - expected.distance) < 1e-9);
      assert.ok(actual.point.distanceTo(expected.point) < 1e-9);
    } else assert.equal(actual, null);
  };
  for (const target of targets) {
    compare(target);
    compare(target, hit => hit.face.materialIndex === 1); // The nearer layer uses material 0.
  }
  for (const x of [-1, 0, 4, 9, 10]) compare([x + .9, 3.9, 3]);
  compare(targets[0], () => true, .1);
});
