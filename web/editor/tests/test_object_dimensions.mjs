import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {placementMatrix} from '../object-import.mjs';
import {DIMENSION_AXES, createDimensionGuides, disposeObjectTree} from '../object-dimensions.mjs';

test('measurement arrows follow the calibrated display frame, with Z vertical after model conversion', () => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 4, 6));
  const transform = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  const bounds = new THREE.Box3().setFromObject(mesh).applyMatrix4(transform);
  const base = {transform: transform.toArray(), bounds: {min: bounds.min.toArray(), max: bounds.max.toArray()}};
  const shape = new THREE.Group(); shape.applyMatrix4(new THREE.Matrix4().fromArray(placementMatrix(base, 1 / 6)));
  shape.add(mesh);
  const box = new THREE.Box3().setFromObject(shape), guides = createDimensionGuides(THREE, box);
  const vertical = new THREE.Vector3(0, 1, 0).applyQuaternion(guides.root.children[2].quaternion);
  assert.ok(vertical.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-9);
  assert.ok(guides.tips.get('Z').y > box.max.y);
  assert.ok(guides.tips.get('Y').z < box.max.z);
  assert.ok(new THREE.Vector3(...DIMENSION_AXES[0].direction).cross(new THREE.Vector3(...DIMENSION_AXES[1].direction))
    .distanceTo(new THREE.Vector3(...DIMENSION_AXES[2].direction)) < 1e-9);
  guides.select('Z');
  assert.equal(guides.root.children[2].line.material.opacity, 1);
  assert.ok(guides.root.children[0].line.material.opacity < 1);
  disposeObjectTree(shape); disposeObjectTree(guides.root);
});

test('removing an object releases shared model/contact geometry and textures once', () => {
  const geometry = new THREE.BoxGeometry(), map = new THREE.Texture(), material = new THREE.MeshBasicMaterial({map});
  const root = new THREE.Group(); root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const counts = [geometry, material, map].map(resource => {
    const count = {value: 0}; resource.addEventListener('dispose', () => count.value++); return count;
  });
  disposeObjectTree(root);
  assert.deepEqual(counts.map(count => count.value), [1, 1, 1]);
});
