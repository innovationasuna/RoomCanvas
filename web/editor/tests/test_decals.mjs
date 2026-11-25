import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {offsetDecals} from '../decals.mjs';

const textured = () => new THREE.MeshStandardMaterial({map: new THREE.Texture()});
const offset = (mesh) => [mesh.material].flat().map((m) => m.polygonOffset && [m.polygonOffsetFactor, m.polygonOffsetUnits]);

test('a textured slab a fraction of a millimetre thick is pulled in front of its backing', () => {
  const room = new THREE.Group();
  const photo = new THREE.Mesh(new THREE.BoxGeometry(.6, .8, .0003), textured());
  const backing = new THREE.Mesh(new THREE.BoxGeometry(.62, .82, .012), textured());
  const plain = new THREE.Mesh(new THREE.BoxGeometry(.6, .8, .0003), new THREE.MeshStandardMaterial());
  photo.rotation.y = .7;  // on a slanted wall: thinness is measured across the slab, not along world axes
  room.add(photo, backing, plain);
  assert.equal(offsetDecals(THREE, room), 1);
  assert.deepEqual(offset(photo), [[-1, -4]]);
  assert.deepEqual(offset(backing), [false]);
  assert.deepEqual(offset(plain), [false]);
});

test('the room\'s own floor, ceiling and walls are not pictures, but what hangs under them is', () => {
  const room = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), textured()); floor.name = 'Floor0';
  const ceiling = new THREE.Group(); ceiling.name = 'Ceiling0';
  const ceilingPart = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), textured()); ceilingPart.name = 'Ceiling0_1';
  const poster = new THREE.Mesh(new THREE.PlaneGeometry(.5, .7), textured()); poster.name = 'Poster';
  ceiling.add(ceilingPart); room.add(floor, ceiling); floor.add(poster);
  assert.equal(offsetDecals(THREE, room), 1);
  assert.deepEqual([offset(floor), offset(ceilingPart), offset(poster)], [[false], [false], [[-1, -4]]]);
});

test('only the slab\'s textured slots change, through copies, so a backing sharing the material keeps it', () => {
  const room = new THREE.Group(), shared = textured(), bare = new THREE.MeshStandardMaterial();
  const geometry = new THREE.BoxGeometry(.6, .8, .0003); geometry.addGroup(0, 6, 0); geometry.addGroup(6, 30, 1);
  const photo = new THREE.Mesh(geometry, [shared, bare]);
  const backing = new THREE.Mesh(new THREE.BoxGeometry(.62, .82, .012), shared);
  room.add(photo, backing);
  assert.equal(offsetDecals(THREE, room), 1);
  assert.deepEqual(offset(photo), [[-1, -4], false]);
  assert.equal(photo.material[1], bare);
  assert.equal(backing.material, shared);
  assert.equal(shared.polygonOffset, false);
});

test('instances of one geometry are measured at their own world size, in either order', () => {
  for (const order of [0, 1]) {
    const room = new THREE.Group(), geometry = new THREE.BoxGeometry(1, 1, .01);
    const thin = new THREE.Mesh(geometry, textured()), thick = new THREE.Mesh(geometry, textured());
    thin.scale.set(1, 1, .1);  // 1 mm thick in the room; the other stays 10 mm
    room.add(...(order ? [thick, thin] : [thin, thick]));
    assert.equal(offsetDecals(THREE, room), 1);
    assert.deepEqual([offset(thin), offset(thick)], [[[-1, -4]], [false]]);
  }
});

test('a rotated slab under a non-uniformly scaled parent is measured through the shear', () => {
  const room = new THREE.Group(), parent = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.BoxGeometry(1, 1, .01), textured());
  slab.rotation.y = Math.PI / 4; parent.scale.set(1, 1, .1);
  parent.add(slab); room.add(parent);
  assert.equal(offsetDecals(THREE, room), 1);
});

test('loader associations say which node a primitive belongs to, whatever the primitive is named', () => {
  const room = new THREE.Group(), floor = new THREE.Group(); floor.name = 'Floor0';
  const part = new THREE.Mesh(new THREE.PlaneGeometry(6, 5), textured()); part.name = 'Plane_1';
  const photo = new THREE.Mesh(new THREE.PlaneGeometry(.5, .7), textured()); photo.name = 'Photo';
  floor.add(part, photo); room.add(floor);
  const associations = new Map([[floor, {nodes: 0}], [part, {meshes: 0, primitives: 1}], [photo, {nodes: 1, meshes: 1, primitives: 0}]]);
  assert.equal(offsetDecals(THREE, room, associations), 1);
  assert.deepEqual([offset(part), offset(photo)], [[false], [[-1, -4]]]);
});

test('a part modelled over the end of a larger one, faces in common, is pulled in front of it', () => {
  const room = new THREE.Group(), item = new THREE.Group(), dark = new THREE.MeshStandardMaterial(), pale = new THREE.MeshStandardMaterial();
  const bar = new THREE.Mesh(new THREE.BoxGeometry(.27, .02, .024), dark);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(.05, .02, .024), pale); tip.position.x = .11;  // ends where the bar ends
  const other = new THREE.Mesh(new THREE.BoxGeometry(.05, .02, .024), pale); other.position.set(.4, 0, 0);
  item.rotation.y = .3; item.add(bar, tip, other); room.add(item);
  assert.equal(offsetDecals(THREE, room), 1);
  assert.deepEqual([offset(bar), offset(tip), offset(other)], [[false], [[-1, -4]], [false]]);
  assert.equal(other.material, pale);
});

test('parts that only touch, or share a surface in one material, are left alone', () => {
  const room = new THREE.Group(), red = new THREE.MeshStandardMaterial(), blue = new THREE.MeshStandardMaterial();
  const book = new THREE.Mesh(new THREE.BoxGeometry(.03, .2, .15), red);
  const next = new THREE.Mesh(new THREE.BoxGeometry(.03, .2, .15), blue); next.position.x = .03;  // side by side, flush fronts
  const onTop = new THREE.Mesh(new THREE.BoxGeometry(.02, .01, .1), blue); onTop.position.y = .105;  // lying on the first
  const same = new THREE.Mesh(new THREE.BoxGeometry(.03, .1, .15), red); same.position.y = -.05;  // inside the first, same material
  room.add(book, next, onTop, same);
  assert.equal(offsetDecals(THREE, room), 0);
  assert.deepEqual([book, next, onTop, same].map(offset), [[false], [false], [false], [false]]);
});

test('primitives of two nodes of one object are compared; a picture already in front is not moved again', () => {
  const room = new THREE.Group(), item = new THREE.Group(), dark = new THREE.MeshStandardMaterial(), pale = new THREE.MeshStandardMaterial();
  const barNode = new THREE.Group(), bar = new THREE.Mesh(new THREE.BoxGeometry(.27, .02, .024), dark);
  const tip = new THREE.Mesh(new THREE.BoxGeometry(.05, .02, .024), pale); tip.position.x = .11;
  const label = new THREE.Mesh(new THREE.BoxGeometry(.05, .0003, .024), textured()); label.position.y = .01;
  barNode.add(bar); item.add(barNode, tip, label); room.add(item);
  const associations = new Map([[bar, {primitives: 0}], [barNode, {nodes: 0}], [tip, {nodes: 1, primitives: 0}], [label, {nodes: 2, primitives: 0}]]);
  assert.equal(offsetDecals(THREE, room, associations), 2);
  assert.deepEqual([offset(bar), offset(tip), offset(label)], [[false], [[-1, -4]], [[-1, -4]]]);
});
