import test from 'node:test';
import assert from 'node:assert/strict';
import {objectLabel, metricScale, savedMeasurement, placementMatrix, sizeInMeters} from '../viewforge-import.mjs';

const apply = (m, [x, y, z]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

test('ViewForge run ids become short names', () => {
  assert.equal(objectLabel('20260926_sofa_web_114146_561893'), 'sofa');
  assert.equal(objectLabel('20261015_roomabc_Table0_C_20261015_a01'), 'roomabc_Table0_C');
  assert.equal(objectLabel('20260913_stuffed_toy_slim_a01'), 'stuffed_toy_slim');
  assert.equal(objectLabel('20260918_Cody_walkthrough_20260918'), 'Cody_walkthrough');
});

test('one measured edge scales the model; a saved calibration is offered first', () => {
  const base = {lengths: {X: 1, Y: .4, Z: .32}};
  assert.equal(metricScale(base, 'Z', 1.6), 5);
  assert.throws(() => metricScale(base, 'Z', 0));
  assert.throws(() => metricScale(base, 'W', 1));
  assert.deepEqual(savedMeasurement({calibration: {axis: 'Z', dimensions_m: {X: 3.4, Y: 1.4, Z: 1.1}}}), {axis: 'Z', meters: 1.1});
  assert.equal(savedMeasurement({calibration: null}), null);
});

test('the placement matrix centres the footprint, stands the model on y = 0 and scales it', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const base = {transform: identity, bounds: {min: [-1, -.5, 2], max: [3, .5, 4]}};
  const m = placementMatrix(base, 2);
  assert.ok(close(apply(m, [1, -.5, 3]), [0, 0, 0]), 'bottom centre → origin');
  assert.ok(close(apply(m, [3, .5, 4]), [4, 2, 2]));
  assert.deepEqual(sizeInMeters(base, 2), [8, 2, 4]);
  // A display transform (here a quarter turn about Y, then the bounds of the turned model).
  const turn = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
  const turned = placementMatrix({transform: turn, bounds: {min: [0, 0, -2], max: [2, 1, 0]}}, 1);
  assert.ok(close(apply(turned, [1, 0, 0]), [-1, 0, 0]), 'the transform is applied before centring');
});
