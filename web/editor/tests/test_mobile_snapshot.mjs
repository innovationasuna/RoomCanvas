import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {captureRoom} from '../mobile-snapshot.mjs';
import {setLayer} from '../material-layers.mjs';

test('snapshot preserves confirmed transforms and imports, restores ceilings/materials, excludes stored items', () => {
  const room = new THREE.Group(), material = new THREE.MeshStandardMaterial({color: '#123456'});
  const wall = new THREE.Mesh(new THREE.BoxGeometry(), material); wall.name = 'Wall0'; room.add(wall);
  setLayer(wall, 'seeThrough', {material: m => {const copy = m.clone(); copy.opacity = 0; return copy;}});
  const ceiling = new THREE.Mesh(new THREE.BoxGeometry(), material); ceiling.name = 'Ceiling0'; ceiling.visible = false; room.add(ceiling);
  const group = new THREE.Group(); group.name = 'Imported'; group.position.set(2, .4, -1); group.rotation.y = .3; room.add(group);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material); mesh.name = 'NewFurniture'; group.add(mesh);
  const contact = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({colorWrite: false}));
  contact.name = 'InvisibleCollisionProxy'; group.add(contact);
  setLayer(mesh, 'selected', {material: m => {const c = m.clone(); c.color.set('red'); return c;}});
  mesh.userData.openable = {node: mesh}; // A real editor has circular articulation pointers.
  const stored = new THREE.Group(); stored.name = 'Stored'; stored.add(new THREE.Mesh(new THREE.BoxGeometry(), material)); room.add(stored);
  const entities = new Map([['new', {id: 'new', group, name: '新家具'}], ['stored', {id: 'stored', group: stored}]]);
  const snapshot = captureRoom(THREE, {room, entities, layout: {new: {visible: true}, stored: {visible: false}}, ceilingObjects: [ceiling], name: '房间', floorY: 0});
  assert.equal(snapshot.root.getObjectByName('Stored'), undefined);
  assert.equal(snapshot.root.getObjectByName('InvisibleCollisionProxy'), undefined);
  assert.equal(snapshot.root.getObjectByName('Ceiling0').visible, true);
  assert.equal(snapshot.root.getObjectByName('Wall0').material.opacity, 1);
  assert.equal(snapshot.root.getObjectByName('NewFurniture').material.color.getHex(), material.color.getHex());
  assert.deepEqual(snapshot.root.getObjectByName('Imported').position.toArray(), [2, .4, -1]);
  assert.equal(snapshot.root.getObjectByName('Imported').rotation.y, .3);
  group.position.x = 8; material.color.set('blue');
  assert.equal(snapshot.root.getObjectByName('Imported').position.x, 2);
  assert.notEqual(snapshot.root.getObjectByName('NewFurniture').material.color.getHex(), material.color.getHex());
  assert.equal(ceiling.visible, false); assert.equal(wall.material.opacity, 0);
  assert.equal(mesh.userData.openable.node, mesh);
  snapshot.dispose();
});

test('openings and their carried items export at rest without changing live preview', () => {
  const room = new THREE.Group(), door = new THREE.Group(), rider = new THREE.Group();
  door.name = 'Door'; rider.name = 'Rider'; room.add(door, rider);
  const rest = new THREE.Matrix4().makeTranslation(1, 0, 0), riderRest = new THREE.Matrix4().makeTranslation(2, 1, 0);
  door.position.x = 3; rider.position.y = 5;
  const snapshot = captureRoom(THREE, {room, entities: new Map(), layout: {}, parts: [{node: door, rest, riders: [{node: rider, rest: riderRest}]}], name: '房间'});
  assert.equal(snapshot.root.getObjectByName('Door').position.x, 1);
  assert.equal(snapshot.root.getObjectByName('Rider').position.y, 1);
  assert.equal(door.position.x, 3); assert.equal(rider.position.y, 5);
  snapshot.dispose();
});

test('snapshot records portable surface ownership without retaining live geometry', () => {
  const room = new THREE.Group(), ceiling = new THREE.Group(), wall = new THREE.Group(), fixture = new THREE.Group();
  ceiling.name = 'CustomCeiling'; wall.name = 'Wall0'; fixture.name = 'CustomWindow';
  room.add(ceiling, wall, fixture);
  const walls = [{name: 'Wall0', n: [1, 0, 0], d: -2, tangent: [0, 0, 1], bounds: [[-2, 0], [2, 3]], triangles: [[[0, 0, 0]]]}];
  const snapshot = captureRoom(THREE, {room, entities: new Map(), layout: {}, name: '房间', walls,
    ceilingObjects: [ceiling], wallOwner: name => name === 'CustomWindow' || name === 'Wall0' ? 'Wall0' : null});
  const cutaway = JSON.parse(JSON.stringify(snapshot.metadata)).cutaway;
  assert.deepEqual(cutaway.owners, {Wall0: 'Wall0', CustomWindow: 'Wall0'});
  assert.deepEqual(cutaway.ceilings, ['CustomCeiling']);
  assert.equal(cutaway.walls[0].triangles, undefined);
  walls[0].n[0] = -1; walls[0].bounds[0][0] = 99;
  assert.equal(snapshot.metadata.cutaway.walls[0].n[0], 1);
  assert.equal(snapshot.metadata.cutaway.walls[0].bounds[0][0], -2);
  snapshot.dispose();
});

test('snapshot freezes lighting and grading so later editor changes do not affect the share', () => {
  const room = new THREE.Group();
  const lighting = {preset: 'physical', profile: 'balanced', indoor: {power: true, angle: 160},
    grading: {exposure: -.4}, labels: {CustomRoof: '天花板'}, environment: true, ao: true};
  const snapshot = captureRoom(THREE, {room, entities: new Map(), layout: {}, name: '房间', lighting});
  lighting.indoor.power = false; lighting.grading.exposure = 1; lighting.labels.CustomRoof = '灯';
  assert.equal(snapshot.metadata.lighting.indoor.power, true);
  assert.equal(snapshot.metadata.lighting.grading.exposure, -.4);
  assert.equal(snapshot.metadata.lighting.labels.CustomRoof, '天花板');
  assert.equal(snapshot.root.userData.roomcanvas.lighting.preset, 'physical');
  snapshot.dispose();
});
