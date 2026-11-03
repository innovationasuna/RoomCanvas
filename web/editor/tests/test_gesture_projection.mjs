import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import * as THREE from '../../vendor/build/three.module.js';

// Exercise the editor's camera application without starting its DOM/WebGL UI.
const editor = readFileSync(new URL('../scene-editor.js', import.meta.url), 'utf8');
const applySource = editor.slice(editor.indexOf('function applyCamera(pose)'), editor.indexOf('function flushGestureMotion()'));
const controlsSource = readFileSync(new URL('../../vendor/examples/jsm/controls/OrbitControls.js', import.meta.url), 'utf8')
  .replace("from 'three'", `from '${new URL('../../vendor/build/three.module.js', import.meta.url).href}'`);
const {OrbitControls} = await import(`data:text/javascript;base64,${Buffer.from(controlsSource).toString('base64')}`);

for (const moving of [false, true]) {
  test(`left orbit preserves right ${moving ? 'moving' : 'stationary'} grab across renders`, () => {
    const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, .1, 100);
    camera.position.set(8, 8, 8);
    const controls = new OrbitControls(camera);
    controls.update(); camera.updateMatrixWorld();
    const applyCamera = runInNewContext(`(${applySource})`, {THREE, camera, controls, requestRender() {}});
    const raycaster = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hand = new THREE.Vector2(.2, -.15), object = new THREE.Vector3(1, 0, 2);
    const hit = () => {
      raycaster.setFromCamera(hand, camera);
      return raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    };
    const base = {radius: 14, zoom: 1, target: [0, 0, 0]};
    for (const [theta, phi] of [[.2, .8], [1.5, 1.2], [-1, 1.45], [2.8, .4]]) {
      const before = object.clone();
      applyCamera({...base, theta, phi});
      // Rebase happens immediately after left orbit, before the renderer runs.
      const grab = hit().sub(object);
      const previousHit = hit();
      camera.updateMatrixWorld();
      assert.ok(hit().distanceTo(previousHit) < 1e-9, 'rebase and render must use the same camera pose');
      if (moving) hand.x += .01;
      const delta = hit().sub(previousHit);
      object.copy(hit().sub(grab));
      assert.ok(object.distanceTo(before.clone().add(delta)) < 1e-9);
      if (!moving) assert.ok(object.distanceTo(before) < 1e-9, 'orbit alone must not move furniture');
      // Another render must not change the same hand's projection.
      camera.updateMatrixWorld();
      assert.ok(hit().sub(grab).distanceTo(object) < 1e-9);
    }
  });
}
