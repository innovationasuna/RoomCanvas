import test from 'node:test';
import assert from 'node:assert/strict';
import {analogDelta} from '../placement-motion.mjs';
import {groundBasis} from '../layout.mjs';

test('diagonal analog movement preserves speed across camera angles', () => {
  for (const right of [{x:1,z:0}, {x:.6,z:.8}, {x:-1,z:0}]) {
    const d = analogDelta(Math.SQRT1_2, Math.SQRT1_2, .2, groundBasis(right));
    assert.ok(Math.abs(Math.hypot(d.x,d.z) - .2) < 1e-9);
    assert.equal(d.y, 0);
  }
});

test('wall analog input remains tangential and vertical, following camera right', () => {
  const d = analogDelta(.6,.8,.5,groundBasis({x:-1,z:0}),[1,0,0]);
  assert.deepEqual(d,{x:-.3,y:.4,z:0});
  assert.equal(Math.hypot(d.x,d.y,d.z), .5);
});
