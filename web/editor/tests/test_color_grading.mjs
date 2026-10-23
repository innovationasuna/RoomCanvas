import {test} from 'node:test';
import assert from 'node:assert/strict';
import {colorGrading, DEFAULT_GRADING, whiteBalanceGains} from '../color-grading.mjs';

test('grading defaults are neutral, independent and finite even with malformed input', () => {
  const a = colorGrading(); a.exposure = 1;
  assert.deepEqual(colorGrading(), DEFAULT_GRADING);
  assert.deepEqual(colorGrading({exposure: Infinity, whiteBalance: NaN, contrast: '1', saturation: undefined}), DEFAULT_GRADING);
  assert.deepEqual(colorGrading({exposure: -5, whiteBalance: 3, contrast: 10, saturation: -2}), {exposure: -2, whiteBalance: 1, contrast: 1.4, saturation: 0});
});
test('white balance preserves neutral luminance and reverses the warm/cool channel relationship', () => {
  assert.deepEqual(whiteBalanceGains(0), [1, 1, 1]);
  for (const value of [-1, -.5, .5, 1]) {
    const [r, g, b] = whiteBalanceGains(value);
    assert.ok(Math.abs(.2126 * r + .7152 * g + .0722 * b - 1) < 1e-12);
    assert.ok(value > 0 ? r > b : b > r);
  }
});
