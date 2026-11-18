import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {collisionOwners, buildCollision} from '../collision.mjs';
import {createRayQueries} from '../ray-queries.mjs';

test('shared nearest queries match Three rays across poses, articulation, visibility and additions', () => {
  const room = new THREE.Group(), group = new THREE.Group(), entities = new Map();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(20, .1, 20), new THREE.MeshBasicMaterial());
  floor.name = 'Floor0'; floor.position.y = -.05; room.add(floor, group);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 2, .2), new THREE.MeshBasicMaterial({side: THREE.DoubleSide}));
  body.position.y = 1; group.add(body);
  entities.set('cabinet', {id: 'cabinet', name: 'cabinet', group, origin: new THREE.Vector3()});
  const owners = collisionOwners(THREE, room, entities);
  const collision = buildCollision(owners), queries = createRayQueries(THREE, room, owners);
  const ray = new THREE.Raycaster();
  const visible = (hit) => {for (let node = hit.object; node; node = node.parent) if (!node.visible) return false; return true;};
  const compare = (origin, direction, accept = visible) => {
    queries.refresh(); ray.set(new THREE.Vector3(...origin), new THREE.Vector3(...direction).normalize());
    const expected = ray.intersectObject(room, true).find(accept), actual = queries.nearest(ray.ray.origin, ray.ray.direction, Infinity, accept);
    assert.equal(actual?.object, expected?.object);
    if (expected) {assert.ok(Math.abs(actual.distance - expected.distance) < 1e-6); assert.ok(actual.point.distanceTo(expected.point) < 1e-6);}
  };
  compare([0, 1, 3], [0, 0, -1]); compare([3, 2, 3], [0, -1, 0]);
  group.position.set(2, .2, 0); group.rotation.y = .4;
  body.rotation.y = Math.PI / 2; body.position.x = .5;
  compare([2.5, 1, 3], [0, 0, -1]); compare([4, 1, 0], [-1, 0, 0]);
  group.visible = false; compare([4, 1, 0], [-1, 0, 0]);
  group.visible = true;
  const added = new THREE.Mesh(new THREE.BoxGeometry(.5, .5, .5), new THREE.MeshBasicMaterial());
  added.position.set(3, .25, 3); added.userData.contactOnly = true; room.add(added);
  queries.rebuild(collisionOwners(THREE, room, entities)); compare([3, 2, 3], [0, -1, 0]);
  // Clipped/see-through hits must not hide a valid hit behind them.
  compare([3, 2, 3], [0, -1, 0], (hit) => hit.object !== added);
  added.removeFromParent(); queries.rebuild(collisionOwners(THREE, room, entities)); compare([3, 2, 3], [0, -1, 0]);
  assert.equal(buildCollision(owners).audit.builtMeshes, 0);
  assert.equal(collision.audit.builtMeshes, 1);
});

test('ray indexes preserve front/back material sides and normals under mirrored nonuniform transforms', () => {
  const room = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, .2), new THREE.MeshBasicMaterial());
  mesh.scale.set(-2, 1, .5); mesh.rotation.y = .7; room.add(mesh); room.updateMatrixWorld(true);
  const queries = createRayQueries(THREE, room), ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 4), new THREE.Vector3(0, 0, -1));
  for (const side of [THREE.FrontSide, THREE.BackSide, THREE.DoubleSide]) {
    mesh.material.side = side;
    const expected = ray.intersectObject(room, true)[0], actual = queries.nearest(ray.ray.origin, ray.ray.direction);
    assert.ok(Math.abs(expected.distance - actual.distance) < 1e-6);
    assert.ok(expected.face.normal.distanceTo(actual.face.normal) < 1e-6);
  }
});
