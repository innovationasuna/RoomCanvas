import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createSelectionHighlight} from '../selection-highlight.mjs';
import {setLayer, setOwnMaterial, ownMaterial} from '../material-layers.mjs';
import {exteriorShell} from '../physical-lighting.mjs';

test('textured, vertex-coloured and unlit pieces get a whole-surface green selection and restore exactly', () => {
  const selection = createSelectionHighlight(THREE);
  for (const Material of [THREE.MeshStandardMaterial, THREE.MeshPhysicalMaterial, THREE.MeshBasicMaterial]) {
    const map = new THREE.Texture();
    const original = new Material({color: 0x000055, map, vertexColors: true, alphaTest: .4});
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
    setLayer(mesh, 'selected', selection);
    const shader = {fragmentShader: '#include <map_fragment>\n#include <color_fragment>\n#include <alphatest_fragment>'};
    mesh.material.onBeforeCompile(shader);
    assert.match(shader.fragmentShader, /diffuseColor.rgb = vec3\(/);
    assert.match(shader.fragmentShader, /#include <alphatest_fragment>/);
    assert.equal(mesh.material.map, map, 'texture alpha still cuts out the actual silhouette');
    assert.equal(mesh.material.alphaTest, .4);
    assert.equal(mesh.material.transparent, false);
    assert.equal(mesh.material.depthWrite, true);
    assert.notEqual(mesh.material.customProgramCacheKey(), original.customProgramCacheKey());
    setLayer(mesh, 'selected', null);
    assert.equal(mesh.material, original);
    assert.equal(original.color.getHex(), 0x000055);
    assert.equal(original.map, map);
    assert.equal(original.vertexColors, true);
  }
});

test('selection preserves physical exterior shader uniforms and survives material changes and previews', () => {
  const original = new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const shell = exteriorShell(THREE, {meshes: [{mesh, inward: {n: [0, 0, 1], d: -2}}], ceilingHeight: 3, own: ownMaterial, setOwn: setOwnMaterial});
  shell.set(true);
  const selection = createSelectionHighlight(THREE);
  setLayer(mesh, 'selected', selection);
  const shader = {uniforms: {}, fragmentShader: '#include <color_fragment>'};
  mesh.material.onBeforeCompile(shader);
  assert.deepEqual(shader.uniforms.roomInward.value, [0, 0, 1]);
  assert.match(shader.fragmentShader, /diffuseColor.rgb/);
  const preview = {material: () => new THREE.MeshBasicMaterial({color: 0xed766b})};
  setLayer(mesh, 'preview', preview);
  assert.equal(mesh.material.color.getHex(), 0xed766b, 'placement validity colour wins while arranging');
  setLayer(mesh, 'preview', null);
  assert.match(mesh.material.customProgramCacheKey(), /room-selection-green/);
  shell.set(false);
  const replacement = new THREE.MeshBasicMaterial({color: 0x334455});
  setOwnMaterial(mesh, replacement);
  assert.match(mesh.material.customProgramCacheKey(), /room-selection-green/);
  setLayer(mesh, 'selected', null);
  assert.equal(mesh.material, replacement);
  shell.dispose();
});

test('invisible collision-only materials do not become green geometry', () => {
  const source = new THREE.MeshBasicMaterial({colorWrite: false, depthWrite: false});
  const material = createSelectionHighlight(THREE).material(source);
  assert.equal(material.colorWrite, false);
  assert.equal(material.depthWrite, false);
});
