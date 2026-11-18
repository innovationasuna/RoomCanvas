import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {disposeModel} from '../../replay/resources.mjs';

test('shared mesh, wall source materials and texture images are each released once', () => {
  const root = new THREE.Group(), geometry = new THREE.BoxGeometry(), texture = new THREE.Texture();
  const released = {geometry: 0, material: 0, texture: 0, image: 0, original: 0};
  texture.image = {close() {released.image++;}};
  const material = new THREE.MeshStandardMaterial({map: texture}), source = material.clone();
  geometry.addEventListener('dispose', () => released.geometry++);
  material.addEventListener('dispose', () => released.material++);
  source.addEventListener('dispose', () => released.original++);
  texture.addEventListener('dispose', () => released.texture++);
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, [material]));
  root.userData.sourceMaterials = [source];
  root.userData.fadeMats = [{m: material}]; root.userData.mask = [root.children[0]];
  const scene = new THREE.Scene(); scene.add(root);
  disposeModel(root);
  assert.deepEqual(released, {geometry: 1, material: 1, texture: 1, image: 1, original: 1});
  assert.equal(root.parent, null); assert.equal(root.children.length, 0);
  assert.equal(root.userData.fadeMats, undefined); assert.equal(root.userData.sourceMaterials, undefined);
});
