import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createRoomVisibility} from '../room-visibility.mjs';

function fixture() {
  const scene = new THREE.Scene(), model = new THREE.Group();
  model.userData.roomcanvas = {schema: 1};
  scene.add(model);
  const mesh = (name, size, at, visible = true) => {
    const root = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial());
    root.name = name; root.position.set(...at); root.visible = visible; model.add(root);
    return root;
  };
  mesh('Floor0', [4, .1, 4], [0, -.05, 0]);
  mesh('Wall0', [.1, 3, 4], [-2, 1.5, 0]);
  mesh('Wall1', [.1, 3, 4], [2, 1.5, 0]);
  mesh('Ceiling0', [4, .1, 4], [0, 3, 0]);
  mesh('CeilingLight0', [.3, .1, .3], [0, 2.9, 0]);
  mesh('Skirting_Wall1', [.12, .1, 4], [1.98, .05, 0]);
  mesh('Socket_Wall1_00', [.12, .1, .1], [1.98, .3, 0]);
  mesh('Window0', [.2, 1.5, 1], [1.98, 1.5, 0]);
  mesh('Editable_Noticeboard0', [.1, 1, .6], [1.9, 1.5, 1.4]);
  mesh('Chair0', [.5, 1, .5], [1.6, .5, 1]);
  mesh('Socket_Wall1_01', [.12, .1, .1], [1.98, .3, 1], false);
  return {scene, model, visible: name => model.getObjectByName(name).visible};
}

test('legacy shared scene cuts near walls and fixtures, follows orbit, restores the room for walking', () => {
  const {scene, visible} = fixture(), controller = createRoomVisibility(THREE, scene);
  assert.deepEqual(controller.update([4, 3, 4]).hidden, ['Wall1']);
  for (const name of ['Wall1', 'Ceiling0', 'CeilingLight0', 'Skirting_Wall1', 'Socket_Wall1_00', 'Window0', 'Editable_Noticeboard0']) assert.equal(visible(name), false, name);
  for (const name of ['Wall0', 'Floor0', 'Chair0']) assert.equal(visible(name), true, name);
  assert.equal(controller.update([4, 3, 4]).changed, false);
  assert.deepEqual(controller.update([-4, 3, -4]).hidden, ['Wall0']);
  assert(visible('Window0') && visible('Skirting_Wall1'));
  controller.update([-4, 3, -4], {walking: true});
  for (const name of ['Wall0', 'Wall1', 'Ceiling0', 'CeilingLight0', 'Window0', 'Editable_Noticeboard0']) assert.equal(visible(name), true, name);
  assert.equal(visible('Socket_Wall1_01'), false, 'preserves pre-existing hidden parts');
  controller.update([4, 3, 4]);
  assert(!visible('Ceiling0') && !visible('Wall1'), 'leaving walkthrough resumes cutaway');
  controller.update([0, 10, 0]);
  assert(visible('Wall0') && visible('Wall1') && !visible('Ceiling0'), 'top view keeps perimeter and removes roof');
});

test('legacy wall geometry uses world transforms instead of axis-aligned bounds', () => {
  const {scene, model} = fixture();
  model.rotation.y = Math.PI / 4;
  model.position.set(10, 0, -5);
  const controller = createRoomVisibility(THREE, scene);
  const direction = new THREE.Vector3(4, 3, 0).transformDirection(model.matrixWorld).toArray();
  assert.deepEqual(controller.update(direction).hidden, ['Wall1']);
});

test('explicit snapshot surface ownership handles custom names and leaves furniture alone', () => {
  const {scene, model, visible} = fixture();
  model.getObjectByName('Window0').name = 'CustomWindow';
  model.getObjectByName('CeilingLight0').name = 'CustomLamp';
  model.userData.roomcanvas.cutaway = {
    walls: [{name: 'Wall1', n: [-1, 0, 0]}],
    owners: {Wall1: 'Wall1', CustomWindow: 'Wall1'}, ceilings: ['Ceiling0', 'CustomLamp'],
  };
  const controller = createRoomVisibility(THREE, scene);
  controller.update([4, 3, 4]);
  assert(!visible('CustomWindow') && !visible('CustomLamp') && visible('Chair0'));
  controller.update([4, 3, 4], {walking: true});
  assert(visible('CustomWindow') && visible('CustomLamp'));
});
