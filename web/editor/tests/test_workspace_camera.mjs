import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {frameWorkspaceCamera, workspaceViewSize} from '../workspace-camera.mjs';

test('perspective framing fits the entire room in wide and portrait viewports', () => {
  for (const aspect of [.45, 1, 2.2]) for (const scale of [.2, 1, 20]) for (const coverage of [.84, .94]) {
    const camera = new THREE.PerspectiveCamera(45, aspect, .02, 3000);
    const bounds = new THREE.Box3(new THREE.Vector3(-2, 0, -3).multiplyScalar(scale), new THREE.Vector3(2, 3, 3).multiplyScalar(scale));
    const target = bounds.getCenter(new THREE.Vector3()); target.y *= .7;
    frameWorkspaceCamera(THREE, camera, {bounds, target, coverage, direction: new THREE.Vector3(1, .6, 1)});
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const projected = new THREE.Vector3(x, y, z).project(camera);
      assert.ok(Math.abs(projected.x) <= coverage + .000001 && Math.abs(projected.y) <= coverage + .000001, 'all corners fit with margin');
      assert.ok(projected.z > -1 && projected.z < 1);
    }
  }
});

test('perspective ground cells shrink with distance, while plan cells retain their measured scale', () => {
  const perspective = new THREE.PerspectiveCamera(45, 1.5, .02, 3000);
  const plan = new THREE.OrthographicCamera(-6, 6, 4, -4, .02, 3000);
  for (const camera of [perspective, plan]) {
    camera.position.set(0, 4, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    const widthAt = z => Math.abs(new THREE.Vector3(.5, 0, z).project(camera).x - new THREE.Vector3(-.5, 0, z).project(camera).x);
    if (camera.isPerspectiveCamera) assert.ok(widthAt(2) > widthAt(-6) * 1.5);
    else assert.ok(Math.abs(widthAt(2) - widthAt(-6)) < 1e-12);
    const distance = camera.position.length();
    const size = workspaceViewSize(camera, distance);
    assert.ok(Number.isFinite(size.width) && size.width > 0);
    assert.ok(Math.abs(size.width / size.height - 1.5) < 1e-12);
    camera.zoom = 2;
    assert.equal(workspaceViewSize(camera, distance).width, size.width / 2);
  }
});
