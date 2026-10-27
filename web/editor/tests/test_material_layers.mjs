import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../../vendor/build/three.module.js';
import {setLayer, hasLayer, ownMaterial, setOwnMaterial, setOwnShadows} from '../material-layers.mjs';
import {setSeeThrough, SEE_THROUGH} from '../wall-visibility.mjs';

function piece(color = 0x8a6f4d) {
  const material = new THREE.MeshStandardMaterial({color});
  let disposed = false;
  material.addEventListener('dispose', () => {disposed = true;});
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.castShadow = mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  return {group, mesh, material, disposed: () => disposed};
}
const editingWall = {material: (m) => Object.assign(m.clone(), {transparent: true, opacity: .18, depthWrite: false})};
const preview = (color) => ({color, castShadow: false, material() {return new THREE.MeshBasicMaterial({color: this.color, transparent: true, opacity: .34});}});

test('#6: a near wall whose hanging piece was being arranged goes back to see-through', () => {
  const wall = piece(0xeeeeee);
  setSeeThrough(wall.group, true);                  // a near wall
  setSeeThrough(wall.group, false);                 // its painting selected: the wall is revealed…
  setLayer(wall.mesh, 'editingWall', editingWall);  // …and shown as the wall being edited
  // Confirmed or Esc: the next frame conceals the wall first, then stops editing it.
  setSeeThrough(wall.group, true);
  setLayer(wall.mesh, 'editingWall', null);
  assert.ok(wall.mesh.material.transparent && wall.mesh.material.opacity === SEE_THROUGH, 'see-through, not stuck solid');
  assert.equal(wall.mesh.castShadow, false);
  setSeeThrough(wall.group, false);
  assert.ok(wall.mesh.material === wall.material && !wall.disposed() && wall.mesh.castShadow);
});

test('#7: a vase carried across the middle of the room keeps its own material', () => {
  for (const startsFaint of [true, false]) {
    const vase = piece();
    if (startsFaint) setSeeThrough(vase.group, true);
    const layer = preview(0x62c6b1);
    setLayer(vase.mesh, 'preview', layer);
    setSeeThrough(vase.group, !startsFaint);        // crosses the middle while dragged
    assert.ok(vase.mesh.material.isMeshBasicMaterial, 'the preview stays on top');
    assert.equal(vase.mesh.material.color.getHex(), 0x62c6b1, 'made again in its own colour');
    layer.color = 0xed766b; vase.mesh.material.color.setHex(layer.color);
    setLayer(vase.mesh, 'preview', null);           // put down
    assert.equal(vase.material.color.getHex(), 0x8a6f4d, 'the preview colour never reaches the own material');
    assert.equal(!!vase.mesh.material.transparent, !startsFaint, 'faint exactly when it is see-through');
    setSeeThrough(vase.group, false);
    assert.ok(vase.mesh.material === vase.material && !vase.disposed() && vase.mesh.castShadow && !hasLayer(vase.mesh, 'seeThrough'));
  }
});

test('later layers win and every made material is disposed, the own one never', () => {
  const chair = piece();
  const made = [], disposed = new Set();
  const track = (layer) => ({...layer, material(m) {
    const next = layer.material.call(this, m);
    made.push(next); next.addEventListener('dispose', () => disposed.add(next));
    return next;
  }});
  setSeeThrough(chair.group, true);
  setLayer(chair.mesh, 'selected', track({material: (m) => Object.assign(m.clone(), {emissiveIntensity: .14})}));
  setLayer(chair.mesh, 'preview', track(preview(0xb39a62)));
  assert.ok(chair.mesh.material.isMeshBasicMaterial && chair.mesh.castShadow === false);
  setLayer(chair.mesh, 'preview', null);
  assert.ok(chair.mesh.material.emissiveIntensity === .14 && chair.mesh.material.transparent, 'selected over see-through');
  setLayer(chair.mesh, 'selected', null); setSeeThrough(chair.group, false);
  assert.ok(made.length >= 3 && made.every((material) => disposed.has(material)));
  assert.ok(chair.mesh.material === chair.material && !chair.disposed());
  assert.throws(() => setLayer(chair.mesh, 'glow', {}), /unknown/);
});

test('the own look can change under a layer: an imported piece switched to lit while selected', () => {
  const imported = piece();
  setLayer(imported.mesh, 'selected', {material: (m) => Object.assign(m.clone(), {emissiveIntensity: .14})});
  const lit = new THREE.MeshPhysicalMaterial({color: 0x123456});
  setOwnMaterial(imported.mesh, lit); setOwnShadows(imported.mesh, {receiveShadow: false});
  assert.ok(imported.mesh.material.isMeshPhysicalMaterial && imported.mesh.material !== lit, 'still tinted, now from the lit material');
  assert.equal(ownMaterial(imported.mesh), lit);
  setLayer(imported.mesh, 'selected', null);
  assert.ok(imported.mesh.material === lit && imported.mesh.receiveShadow === false);
  setOwnMaterial(imported.mesh, imported.material);  // with no layer on, a plain assignment
  assert.equal(imported.mesh.material, imported.material);
});

test('a multi-material mesh keeps one material per group', () => {
  const materials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), materials);
  const group = new THREE.Group(); group.add(mesh);
  setSeeThrough(group, true);
  assert.ok(Array.isArray(mesh.material) && mesh.material.length === 2 && mesh.material.every((m) => m.transparent));
  setSeeThrough(group, false);
  assert.equal(mesh.material, materials);
});
