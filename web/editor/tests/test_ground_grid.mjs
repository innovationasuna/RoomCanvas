import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createGroundGrid} from '../ground-grid.mjs';

function update(grid, camera) {
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  grid.onBeforeRender(null, null, camera);
}
function surfaceHit(grid, camera, point) {
  const ndc = point.clone().project(camera);
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
  // Bypass the guide's intentional picking opt-out to test its actual world geometry.
  const hits = []; THREE.Mesh.prototype.raycast.call(grid, ray, hits);
  assert.ok(hits.length, 'the projected ground point must intersect the real mesh');
  assert.ok(hits[0].point.distanceTo(point) < 1e-6);
  return hits[0].point;
}

test('the grid stays on the floor under pans, zooms, overhead and grazing views', () => {
  const target = new THREE.Vector3(), floorY = 2;
  const grid = createGroundGrid(THREE, {floorY, target});
  const camera = new THREE.OrthographicCamera(-10, 10, 6, -6, .02, 3000);
  for (const [x, z] of [[0, 0], [1000, -800], [-1200, 900]]) {
    target.set(x, floorY + .65, z);
    for (const zoom of [.45, 1, 8]) {
      camera.zoom = zoom;
      for (const elevation of [.015, .08, .7, Math.PI / 2 - .001]) {
        camera.position.copy(target).add(new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation)).multiplyScalar(12));
        camera.lookAt(target); update(grid, camera);
        for (const delta of [-1, 0, 1]) {
          const point = new THREE.Vector3(x + delta, floorY - .001, z + delta);
          surfaceHit(grid, camera, point);
        }
        const positions = grid.geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          const vertex = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(grid.matrixWorld);
          assert.ok(Math.abs(vertex.y - (floorY - .001)) < 1e-8, 'all geometry is horizontal, not screen aligned');
        }
        const radius = grid.material.uniforms.fadeDistance.value;
        assert.ok(grid.scale.x > radius && grid.scale.y > radius, 'every mesh edge lies beyond the faded region');
      }
    }
  }
});

test('ground projection compresses at low angles and keeps real occlusion depth', () => {
  const target = new THREE.Vector3(1000, 0, -800);
  const grid = createGroundGrid(THREE, {floorY: 0, target});
  for (const camera of [new THREE.OrthographicCamera(-10, 10, 8, -8, .02, 3000), new THREE.PerspectiveCamera(60, 1.6, .02, 3000)]) {
    let previousGap = Infinity;
    for (const elevation of [.7, .12, .015]) {
      camera.position.copy(target).add(new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation)).multiplyScalar(12));
      camera.lookAt(target); update(grid, camera);
      const p = new THREE.Vector3(1000.25, -.001, -800.75);
      surfaceHit(grid, camera, p);
      const ndc = p.clone().project(camera);
      const gap = Math.abs(ndc.y - p.clone().add(new THREE.Vector3(0, 0, 1)).project(camera).y);
      assert.ok(gap < previousGap, 'one-metre ground spacing must compress toward an edge-on view');
      previousGap = gap;
      assert.ok(p.clone().add(new THREE.Vector3(0, .1, 0)).project(camera).z < ndc.z, 'objects resting on the floor occlude the guide');
    }
  }
  assert.equal(grid.receiveShadow, false);
  assert.equal(grid.castShadow, false);
  assert.deepEqual(new THREE.Raycaster(new THREE.Vector3(1000, 5, -800), new THREE.Vector3(0, -1, 0)).intersectObject(grid), []);
});
