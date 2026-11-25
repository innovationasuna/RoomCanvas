import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCollision, collisionIndexes, packOwners, triangleIndex} from '../collision.mjs';
import {buildTriangleIndex, readFace} from '../triangle-index.mjs';
import {vertexAt} from '../triangle-geometry.mjs';

const pose = (x = 0, y = 0, z = 0, yaw = 0) => ({x, y, z, yaw});
const owner = (id, triangles) => ({id, name: id, origin: [0, 0, 0], meshes: [{name: id, triangles}]});
const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function box(x0, y0, z0, x1, y1, z1) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  return [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1],
    [3, 2, 6], [3, 6, 7], [0, 3, 7], [0, 7, 4], [1, 5, 6], [1, 6, 2]].map(face => face.map(i => p[i]));
}

function colliders(owners, options) {
  return [buildCollision(owners, options), buildCollision(packOwners(owners).owners, options)];
}

function query(both, method, ...args) {
  const [nested, packed] = both.map(collision => collision[method](...args));
  assert.deepEqual(packed, nested, `${method} must retain the complete verdict and resulting pose`);
  return packed;
}

test('packed indexes retain Float64 values, original face IDs and the exact nested BVH ordering', () => {
  const degenerate = [[[0, 0, 0], [1, 1, 1], [2, 2, 2]], [[0, 0, 0], [1e-6, 0, 0], [0, 1e-6, 0]]];
  const triangles = Array.from({length: 129}, (_, i) => {
    const x = (i * 37 % 17) + 1.123456789012345, size = .3 + i % 3;
    return [[x, -0, .1], [x + size, 0, .1], [x, size, .1 + (i % 5) * 1e-5]];
  });
  triangles.splice(0, 0, degenerate[0]);
  triangles.splice(11, 0, degenerate[1]);
  for (const source of [[], degenerate, triangles]) {
    const packed = packOwners([owner('mesh', source)]).owners[0].meshes[0];
    // Views need not begin at byte zero, and unused buffer contents are not vertices/faces.
    packed.vertices = Float64Array.from([NaN, NaN, NaN, ...packed.vertices, NaN, NaN, NaN]).subarray(3, -3);
    packed.index = Uint32Array.from([0xffffffff, ...packed.index, 0xffffffff]).subarray(1, -1);
    const before = structuredClone(packed), expected = buildTriangleIndex(source), actual = buildTriangleIndex(packed);
    assert.equal(actual.vertices, packed.vertices);
    assert.equal(actual.index, packed.index);
    assert.equal('triangles' in actual, false, 'index construction must not retain an unpacked triangle graph');
    for (const key of ['data', 'faces', 'tree']) assert.deepEqual(actual[key], expected[key], key);
    assert.deepEqual([...actual.faces].sort((a, b) => a - b), source === triangles
      ? source.map((_, i) => i).filter(i => i !== 0 && i !== 11) : []);
    for (const face of actual.faces) {
      assert.deepEqual(readFace(actual, face), readFace(expected, face));
      assert.deepEqual(readFace(actual, face).triangle, source[face]);
    }
    assert.equal(triangleIndex(packed), triangleIndex(packed), 'immutable packed geometry reuses its index');
    assert.deepEqual(packed, before, 'building and reading do not mutate source buffers');
  }
});

test('packed vertex IDs preserve shared references without welding distinct vertices at identical coordinates', () => {
  const a = [0, 0, 0], b = [1, 0, 0], c = [0, 1, 0], separateA = [...a];
  const triangles = [[a, b, c], [separateA, c, b]], source = {triangles};
  const packed = packOwners([owner('mesh', triangles)]).owners[0].meshes[0];
  assert.deepEqual([...packed.index], [0, 1, 2, 3, 2, 1]);
  assert.equal(packed.vertices.length, 12);
  for (const mesh of [source, packed]) {
    assert.equal(vertexAt(mesh, 0, 1), vertexAt(mesh, 1, 2));
    assert.notEqual(vertexAt(mesh, 0, 0), vertexAt(mesh, 1, 0));
  }
  const index = buildTriangleIndex(packed);
  assert.deepEqual(readFace(index, 0).triangle[0], readFace(index, 1).triangle[0]);
});

test('packed owners export the same numeric index packets including empty meshes and multiple owners', () => {
  const owners = [owner('empty', []), owner('solid', box(-1, -1, -1, 1, 1, 1))];
  owners[1].meshes.push({name: 'second-piece', triangles: box(3, 0, 0, 4, 1, 1)});
  assert.deepEqual(collisionIndexes(packOwners(owners).owners), collisionIndexes(owners));
});

test('packed geometry keeps continuous stopping distances and fixed placement decisions', () => {
  const both = colliders([owner('chair', box(-.2, 0, -.2, .2, .5, .2)), owner('wall', box(1, 0, -1, 1.2, 1, 1))]);
  const before = {chair: pose()}, next = {chair: pose(2)};
  const hit = query(both, 'limit', before, next, ['chair']);
  assert.equal(hit.blocked, true);
  assert.equal(hit.other.id, 'wall');
  near(hit.layout.chair.x, .8 - .0002);
  assert.equal(query(both, 'limit', hit.layout, before, ['chair']).blocked, false);
  const contact = query(both, 'checkPlacement', {chair: pose(1.1)}, ['chair']);
  assert.equal(contact.ok, false);
  assert.equal(contact.reason, 'crossing');
  assert.equal(query(both, 'checkPlacement', {chair: pose(1.1, 2, 0, .3)}, ['chair']).ok, true);
  query(both, 'limit', before, {chair: pose(2, 0, .3, .4)}, ['chair']);
});

test('packed containment distinguishes closed solids from open meshes even with duplicated vertex coordinates', () => {
  for (const duplicate of [false, true]) for (const closed of [false, true]) {
    let shell = box(-1, -1, -1, 1, 1, 1);
    if (!closed) shell = shell.slice(0, -2);
    if (duplicate) shell = shell.map(face => face.map(point => [...point]));
    const both = colliders([owner('small', box(-.1, -.1, -.1, .1, .1, .1)), owner('shell', shell)]);
    const result = query(both, 'checkPlacement', {small: pose()}, ['small']);
    assert.equal(result.ok, !closed);
    assert.equal(result.reason, closed ? 'containment' : null);
  }
});

test('packed empty and degenerate meshes neither obstruct moves nor create a solid', () => {
  const both = colliders([owner('item', box(-.1, 0, -.1, .1, .5, .1)), owner('empty', []),
    owner('line', [[[0, 0, 0], [1, 1, 1], [2, 2, 2]]])]);
  assert.equal(query(both, 'checkPlacement', {item: pose()}, ['item']).ok, true);
  assert.equal(query(both, 'limit', {item: pose()}, {item: pose(1)}, ['item']).blocked, false);
});

test('packed scanned overlaps preserve the 5 mm allowance in both movement directions', () => {
  const both = colliders([owner('item', box(-.2, 0, -.1, .005, .5, .1)), owner('wall', box(0, -1, -2, .2, 1, 2))],
    {keepAuthoredOverlaps: true});
  const scanned = {item: pose(), wall: pose()};
  for (const collision of both) collision.prepare('item');
  for (const [moved, sign] of [['item', 1], ['wall', -1]]) {
    for (const [depth, allowed] of [[.005 - 1e-9, true], [.005 + 1e-9, false]]) {
      const next = {...scanned, [moved]: pose(sign * depth)};
      const contact = query(both, 'checkPlacement', next, [moved]);
      assert.equal(contact.ok, allowed);
      assert.equal(contact.reason, allowed ? null : 'deeper');
    }
    const push = query(both, 'limit', scanned, {...scanned, [moved]: pose(sign * .05)}, [moved]);
    assert.equal(push.blocked, true);
    near(sign * push.layout[moved].x, .005 - .0002);
    assert.equal(query(both, 'limit', scanned, {...scanned, [moved]: pose(0, 0, sign * .2)}, [moved]).blocked, false);
  }
});

test('packed equal-area near-coplanar faces keep the established boundary verdict and representative plane', () => {
  // Independent oracle retained from test_collision_bvh: ordering a tied pair of
  // nearly parallel planes differently changes these two boundary decisions.
  const slope = 1e-5, width = Math.hypot(slope * 10, 10) / 10;
  const a = [0, 0, 0], b = [0, 0, 10], left = [-width, 0, 0], right = [1, -slope, 0];
  const top = [[a, left, b], [a, b, right]];
  const lower = new Map([a, b, left, right].map(point => [point, [point[0], -.5, point[2]]]));
  const wedge = [...top, ...top.map(face => face.map(point => lower.get(point)).reverse())];
  for (const [p, q] of [[left, a], [a, right], [right, b], [b, left]]) {
    wedge.push([p, q, lower.get(p)], [q, lower.get(q), lower.get(p)]);
  }
  const both = colliders([owner('box', box(.25, -.02, .5, .35, .08, .6)), owner('wedge', wedge.toReversed())],
    {keepAuthoredOverlaps: true});
  const before = {box: pose()};
  assert.equal(query(both, 'checkPlacement', before, ['box']).ok, true);
  for (const [x, y, blocked, fraction] of [[-.6, -.004999, true, .9993666180234925], [.3, -.005001, false, 1]]) {
    const next = {box: pose(x, y)}, contact = query(both, 'checkPlacement', next, ['box']);
    assert.equal(contact.ok, !blocked);
    assert.equal(contact.reason, blocked ? 'deeper' : null);
    const sweep = query(both, 'limit', before, next, ['box']);
    assert.equal(sweep.blocked, blocked);
    near(sweep.fraction, fraction, 1e-10);
  }
});

test('packed disconnected pieces keep scan permissions local and still stop at a separate thin partition', () => {
  const sheet = box(-.2, .015, -.0005, .2, .5, .0005);
  const rail = [...box(-1, 0, -.02, 1, .02, .02), ...box(.5, 0, -.3, .502, .6, .3)];
  const both = colliders([owner('sheet', sheet), owner('rail', rail)], {keepAuthoredOverlaps: true});
  const scanned = {sheet: pose(), rail: pose()};
  for (const collision of both) collision.prepare('rail');
  assert.equal(query(both, 'checkPlacement', scanned, ['sheet']).ok, true);
  assert.equal(query(both, 'limit', scanned, {...scanned, sheet: pose(.2)}, ['sheet']).blocked, false);
  const through = query(both, 'limit', scanned, {...scanned, sheet: pose(.8)}, ['sheet']);
  assert.equal(through.blocked, true);
  near(through.layout.sheet.x, .3 - .0002);
  assert.equal(query(both, 'checkPlacement', {...scanned, sheet: pose(.4)}, ['sheet']).ok, false);
  const back = query(both, 'limit', scanned, {...scanned, rail: pose(-.8)}, ['rail']);
  assert.equal(back.blocked, true);
  near(back.layout.rail.x, -.3 + .0002);
});
