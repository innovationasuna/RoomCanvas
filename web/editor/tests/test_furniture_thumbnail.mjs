import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {THUMBNAIL_SIZE, frameThumbnailCamera} from '../furniture-thumbnail.mjs';

test('thumbnail framing fills the image without clipping tall, wide, flat or small furniture', () => {
  for (const dimensions of [[.5, 1.2, .5], [4, .7, .3], [2, .02, 1.2], [.02, .03, .01], [1, 1, 1]]) {
    const size = new THREE.Vector3(...dimensions);
    const camera = new THREE.PerspectiveCamera(36, THUMBNAIL_SIZE.width / THUMBNAIL_SIZE.height, .01, 1000);
    frameThumbnailCamera(THREE, camera, size);
    let edge = 0;
    for (const x of [-.5, .5]) for (const y of [-.5, .5]) for (const z of [-.5, .5]) {
      const ndc = new THREE.Vector3(size.x * x, size.y * y, size.z * z).project(camera);
      assert.ok(Math.abs(ndc.x) <= .840001 && Math.abs(ndc.y) <= .840001, 'all corners retain the intended image margin');
      assert.ok(ndc.z > -1 && ndc.z < 1, 'no part is clipped by near/far planes');
      edge = Math.max(edge, Math.abs(ndc.x), Math.abs(ndc.y));
    }
    assert.ok(Math.abs(edge - .84) < 1e-6, 'at least one edge fills the usable image area');
    assert.ok(camera.near > 0 && camera.far > camera.near);
  }
});

test('thumbnail fitting changes the camera without changing the model dimensions', () => {
  const camera = new THREE.PerspectiveCamera(36, THUMBNAIL_SIZE.width / THUMBNAIL_SIZE.height, .01, 1000);
  const size = new THREE.Vector3(.5, 1.2, .5), before = size.clone();
  frameThumbnailCamera(THREE, camera, size);
  const small = camera.position.length();
  assert.deepEqual(size, before);
  frameThumbnailCamera(THREE, camera, size.clone().multiplyScalar(10));
  assert.ok(Math.abs(camera.position.length() / small - 10) < 1e-6);
});
