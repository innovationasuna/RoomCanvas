import test from 'node:test';
import assert from 'node:assert/strict';
import {inTriangle, seatBand} from '../placement.mjs';

const rectangle = (x0, z0, x1, z1, y) => [
  [[x0, y, z0], [x1, y, z0], [x1, y, z1]],
  [[x0, y, z0], [x1, y, z1], [x0, y, z1]],
];
const halfMetreBand = [.45 - .03, .45 + .06 + .03];

// Original exhaustive sampler: deliberately check every face at every point as
// an independent reference for the spatial traversal, including edge rounding.
function exhaustiveSeatBand(triangles, floorY, {from = .25, to = .8, window = .06, cell = .02, minCells = 25} = {}) {
  const flat = triangles.filter(([a, b, c]) => {
    const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n), heights = [a, b, c].map(p => p[1] - floorY);
    return Math.abs(n[1] / (length || 1)) >= .92 && length / 2 >= 1e-8 && Math.min(...heights) >= from && Math.max(...heights) <= to;
  }).map(triangle => ({flat: triangle.map(p => [p[0], p[2]]), y: triangle.reduce((sum, p) => sum + p[1], 0) / 3 - floorY,
    box: [0, 2].map(k => [Math.min(...triangle.map(p => p[k])), Math.max(...triangle.map(p => p[k]))])}));
  if (!flat.length) return null;
  const [xs, zs] = [0, 1].map(k => [Math.min(...flat.map(t => t.box[k][0])), Math.max(...flat.map(t => t.box[k][1]))]);
  const counts = new Map();
  for (let x = xs[0] + cell / 2; x < xs[1]; x += cell) for (let z = zs[0] + cell / 2; z < zs[1]; z += cell) {
    let top = -Infinity;
    for (const t of flat) {
      if (t.y > top && x >= t.box[0][0] && x <= t.box[0][1] && z >= t.box[1][0] && z <= t.box[1][1] && inTriangle([x, z], t.flat)) top = t.y;
    }
    if (top > -Infinity) counts.set(Math.round(top * 100), (counts.get(Math.round(top * 100)) || 0) + 1);
  }
  let best = null;
  for (let start = Math.round(from * 100); start + window * 100 <= Math.round(to * 100); start++) {
    let count = 0;
    for (let bin = start; bin < start + window * 100; bin++) count += counts.get(bin) || 0;
    if (!best || count > best.count) best = {start, count};
  }
  return best.count < minCells ? null : [best.start / 100 - .03, best.start / 100 + window + .03];
}

test('seat samples retain repeated-addition coordinates and closed triangle bounds', () => {
  // start + i * cell would add a 25th point below this upper edge.
  const edge = .49000000000000016, narrow = rectangle(0, 0, edge, .02, .45);
  assert.deepEqual(seatBand(narrow, 0, {minCells: 24}), [.37, .49]);
  assert.equal(seatBand(narrow, 0, {minCells: 25}), null);
  // ceil((edge - firstSample) / cell) would skip the last point's upper face.
  const covered = [...rectangle(0, 0, .5, .02, .45), ...rectangle(edge, 0, .5, .02, .65)];
  assert.equal(seatBand(covered, 0, {minCells: 25}), null);
});

test('seat sampling preserves holes and counts overlapping triangles only once', () => {
  const ring = [
    ...rectangle(0, 0, .125, .5, .5), ...rectangle(.375, 0, .5, .5, .5),
    ...rectangle(.125, 0, .375, .125, .5), ...rectangle(.125, .375, .375, .5, .5),
  ];
  assert.deepEqual(seatBand(ring, 0, {cell: .125, minCells: 12}), halfMetreBand);
  assert.equal(seatBand(ring, 0, {cell: .125, minCells: 13}), null);
  const square = rectangle(0, 0, .25, .25, .5), duplicate = [...square, ...square];
  assert.deepEqual(seatBand(duplicate, 0, {cell: .125, minCells: 4}), halfMetreBand);
  assert.equal(seatBand(duplicate, 0, {cell: .125, minCells: 5}), null);
});

test('only the highest covered face counts, in either triangle order or winding', () => {
  const layers = [...rectangle(0, 0, .5, .5, .3), ...rectangle(0, 0, .5, .5, .5)];
  for (const triangles of [layers, layers.toReversed(), layers.map(t => t.toReversed())]) {
    assert.deepEqual(seatBand(triangles, 0, {cell: .125, minCells: 16}), halfMetreBand);
  }
  const elevated = layers.map(t => t.map(([x, y, z]) => [x, y + 3, z]));
  assert.deepEqual(seatBand(elevated, 3, {cell: .125, minCells: 16}), halfMetreBand);
});

test('equally covered seat windows keep the lower window', () => {
  const layers = [...rectangle(0, 0, .5, .5, .4), ...rectangle(1, 0, 1.5, .5, .6)];
  assert.deepEqual(seatBand(layers, 0, {cell: .125, minCells: 16}), [.35 - .03, .35 + .06 + .03]);
});

test('empty, vertical, degenerate and unsampled faces do not invent a seat', () => {
  for (const triangles of [[], [[[0, .4, 0], [0, .6, 0], [0, .6, 1]]],
    [[[0, .5, 0], [0, .5, 0], [0, .5, 0]]], rectangle(0, 0, .005, .005, .5)]) {
    assert.equal(seatBand(triangles, 0, {minCells: 1}), null);
  }
});

test('seat bands match exhaustive sampling across tilted faces, translations and grid sizes', () => {
  let seed = 117;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const shift of [0, -.1, 10, -10, 1e8, -1e8]) for (const cell of [.02, .03, .125]) {
    const floorY = random() * 4 - 2, triangles = [];
    for (let i = 0; i < 80; i++) {
      const x = shift + random() * .8, z = -shift + random() * .8, y = floorY + random();
      triangles.push([[x, y, z], [x + random() * .2, y + random() * .02, z + random() * .2],
        [x + random() * .2, y + random() * .02, z + random() * .2]]);
    }
    triangles.push(...rectangle(shift, -shift, shift + .3, -shift + .3, floorY + .4));
    for (const window of [.035, .06]) for (const minCells of [1, 25, 100]) {
      const options = {cell, window, minCells, from: .2, to: .75};
      assert.deepEqual(seatBand(triangles, floorY, options), exhaustiveSeatBand(triangles, floorY, options),
        JSON.stringify({shift, floorY, ...options}));
    }
  }
});
