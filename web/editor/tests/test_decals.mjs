import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {offsetDecals} from '../decals.mjs';

const textured = () => new THREE.MeshStandardMaterial({map: new THREE.Texture()});

test('a textured slab a fraction of a millimetre thick is pulled in front of its backing', () => {
  const room = new THREE.Group();
  const photo = new THREE.Mesh(new THREE.BoxGeometry(.6, .8, .0003), textured());
  const backing = new THREE.Mesh(new THREE.BoxGeometry(.62, .82, .012), textured());
  const plain = new THREE.Mesh(new THREE.BoxGeometry(.6, .8, .0003), new THREE.MeshStandardMaterial());
  photo.rotation.y = .7;  // on a slanted wall: thinness is measured across the slab, not along world axes
  room.add(photo, backing, plain);
  assert.equal(offsetDecals(THREE, room), 1);
  assert.equal(photo.material.polygonOffset, true);
  assert.ok(photo.material.polygonOffsetFactor < 0 && photo.material.polygonOffsetUnits < 0);
  assert.equal(backing.material.polygonOffset, false);
  assert.equal(plain.material.polygonOffset, false);
});

test('a scaled-down node is measured at its world size', () => {
  const room = new THREE.Group();
  const sheet = new THREE.Mesh(new THREE.BoxGeometry(1, 1, .01), textured());
  sheet.scale.setScalar(.1);  // 1 mm thick in the room
  room.add(sheet);
  assert.equal(offsetDecals(THREE, room), 1);
});
