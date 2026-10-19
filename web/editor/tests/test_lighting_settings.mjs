import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shadowSettings} from '../lighting-settings.mjs';

const box = (min, max) => [0,1].flatMap(x => [0,1].flatMap(y => [0,1].map(z => [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]])));

test('common shadow settings enclose compact and wide rooms in light space, without wasting the original 30m depth range', () => {
  for (const corners of [box([-3,-2,-12],[3,2,-5]), box([-8,-3,-17],[7,4,-2])]) {
    const {camera, bias, normalBias} = shadowSettings(corners);
    for (const [x,y,z] of corners) {
      assert.ok(x > camera.left && x < camera.right);
      assert.ok(y > camera.bottom && y < camera.top);
      assert.ok(-z > camera.near && -z < camera.far);
    }
    assert.ok(camera.far - camera.near < 30);
    assert.ok(bias < 0 && Math.abs(bias) <= .001);
    assert.ok(normalBias >= .002 && normalBias <= .02);
  }
});

test('rooms behind the fixed light and invalid bounds keep the original shadow configuration', () => {
  assert.equal(shadowSettings(box([-10,-2,-12],[10,4,1])), null);
  assert.equal(shadowSettings([[NaN,0,0]]), null);
  assert.equal(shadowSettings(box([-1,-1,-4],[1,1,-2]), 0), null);
});
