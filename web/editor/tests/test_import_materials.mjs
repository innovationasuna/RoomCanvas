import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {createImportMaterials} from '../import-materials.mjs';

test('vertex-colour import gains a lit material and normals without modifying shared source geometry or collision proxies', () => {
  const geometry = new THREE.BoxGeometry(); geometry.deleteAttribute('normal');
  const colors = new Float32Array(geometry.attributes.position.count * 3).fill(.25);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors,3));
  const source = new THREE.MeshBasicMaterial({vertexColors:true});
  const mesh = new THREE.Mesh(geometry,source), proxy = new THREE.Mesh(geometry,source);
  proxy.userData.contactOnly = true;
  const root = new THREE.Group(); root.add(mesh,proxy);
  const adapter = createImportMaterials(THREE,root);
  assert.ok(mesh.material.isMeshBasicMaterial);
  assert.equal(proxy.material,source); assert.equal(proxy.geometry,geometry);
  assert.ok(!geometry.attributes.normal);
  assert.ok(mesh.geometry.attributes.normal);
  assert.deepEqual([...mesh.geometry.attributes.color.array],[...colors]);
  adapter.setMode('pbr');
  assert.ok(mesh.material.isMeshStandardMaterial); assert.equal(mesh.material.metalness,0);
  assert.equal(mesh.material.vertexColors,true); assert.equal(mesh.receiveShadow,true);
  assert.deepEqual([...mesh.geometry.attributes.color.array],[...colors]);
  assert.equal(adapter.snapshot().normalsAdded,1);
  adapter.setMode('original'); assert.ok(mesh.material.isMeshBasicMaterial); assert.equal(mesh.receiveShadow,false);
  adapter.dispose(); assert.equal(mesh.material,source); assert.equal(mesh.geometry,geometry);
});

test('authored Physical/PBR maps and parameters survive switching, and shared source materials remain intact', () => {
  const texture = new THREE.Texture(); texture.colorSpace = THREE.SRGBColorSpace;
  const source = new THREE.MeshPhysicalMaterial({map:texture,roughness:.22,metalness:.7,clearcoat:.8});
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(),source);
  let sourceDisposed = false; source.addEventListener('dispose',() => {sourceDisposed=true;});
  const root = new THREE.Group(); root.add(mesh);
  const adapter = createImportMaterials(THREE,root,{mode:'pbr'});
  assert.ok(mesh.material.isMeshPhysicalMaterial); assert.notEqual(mesh.material,source);
  assert.equal(mesh.material.map,texture); assert.equal(mesh.material.roughness,.22);
  assert.equal(mesh.material.metalness,.7); assert.equal(mesh.material.clearcoat,.8);
  assert.equal(texture.colorSpace,THREE.SRGBColorSpace);
  mesh.material.roughness=.9; assert.equal(source.roughness,.22);
  assert.throws(() => adapter.setMode('invalid'));
  adapter.dispose(); assert.equal(sourceDisposed,false); assert.equal(mesh.material,source);
});

test('unlit textured imports keep texture and alpha semantics in the opt-in PBR path', () => {
  const texture=new THREE.Texture(); texture.colorSpace=THREE.SRGBColorSpace;
  const source=new THREE.MeshBasicMaterial({map:texture,color:0x778899,transparent:true,opacity:.6,alphaTest:.1,depthWrite:false});
  const mesh=new THREE.Mesh(new THREE.PlaneGeometry(),source), root=new THREE.Group();root.add(mesh);
  const adapter=createImportMaterials(THREE,root,{mode:'pbr'});
  assert.equal(mesh.material.map,texture); assert.equal(mesh.material.color.getHex(),source.color.getHex());
  assert.equal(mesh.material.opacity,.6); assert.equal(mesh.material.alphaTest,.1); assert.equal(mesh.material.depthWrite,false);
  adapter.dispose();
});

test('native PBR imports retain textures and lighting independently of the legacy colour toggle', () => {
  const texture = new THREE.Texture(), roughness = new THREE.Texture();
  const source = new THREE.MeshStandardMaterial({map: texture, roughnessMap: roughness, metalness: .4});
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), source), root = new THREE.Group(); root.add(mesh);
  const adapter = createImportMaterials(THREE, root, {preservePBR: true});
  for (const mode of ['original', 'pbr', 'original']) {
    adapter.setMode(mode);
    assert.ok(mesh.material.isMeshStandardMaterial);
    assert.equal(mesh.material.map, texture);
    assert.equal(mesh.material.roughnessMap, roughness);
    assert.equal(mesh.material.metalness, .4);
    assert.equal(mesh.receiveShadow, true);
  }
  assert.equal(adapter.snapshot().mode, 'pbr');
  adapter.dispose(); assert.equal(mesh.material, source);
});
