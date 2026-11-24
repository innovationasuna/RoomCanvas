// Load the photo meshes once. Ancestors contribute their transforms, never their furniture geometry.
import * as THREE from 'three';
import {disposeModel} from './resources.mjs';

const OBJECT_NAME = /^[A-Z][A-Za-z]*\d+$/;

// Where another room object starts below an item. Cutting the photo model and masking a version
// use this same boundary, so a separate child is neither carried along nor hidden twice.
export function separateObject(name, roomId, isMesh, objects) {
  return !!roomId || !!objects?.has(name) || (!isMesh && OBJECT_NAME.test(name));
}

export function selectPhotoItems(gltf, ids, objects) {
  const wanted = new Set(ids), nodes = gltf.nodes;
  function keep(index, inside) {
    const node = nodes[index];
    const item = wanted.has(node.name);
    const own = item || (inside && !separateObject(node.name, node.extras?.room_id, node.mesh != null, objects));
    node.children = (node.children || []).filter(child => keep(child, own));
    if (!own) {
      delete node.mesh;
      delete node.skin;
    }
    delete node.camera;
    if (node.extensions) delete node.extensions.KHR_lights_punctual;
    return own || node.children.length > 0;
  }
  const roots = gltf.scenes?.[gltf.scene || 0]?.nodes || [];
  gltf.scenes = [{nodes: roots.filter(i => keep(i, false))}];
  gltf.scene = 0;
  gltf.animations = [];
}

export function bottomCenter(box) {
  if (box.isEmpty()) return null;
  const point = box.getCenter(new THREE.Vector3());
  point.y = box.min.y;
  return point;
}

// The stage room owns its masks. This one independent layer can follow a seek without
// cloning textures per review round or disposing resources another room is still using.
export class SmallItemLayer {
  constructor(root, ids) {
    this.root = new THREE.Group();
    this.items = new Map();
    root.updateMatrixWorld(true);
    const wanted = new Set(ids), parts = [];
    root.traverse(node => {if (wanted.has(node.userData.name || node.name)) parts.push(node);});
    for (const part of parts.reverse()) {
      const world = part.matrixWorld.clone();
      const anchor = bottomCenter(new THREE.Box3().setFromObject(part));
      this.root.add(part);
      part.matrixAutoUpdate = false;
      part.matrix.copy(world);
      part.matrixWorldNeedsUpdate = true;
      part.visible = false;
      this.items.set(part.userData.name || part.name, {part, world, anchor});
    }
    this.root.traverse(o => {if (o.isMesh) o.castShadow = o.receiveShadow = true;});
  }

  // slots: item -> its stand-in's bottom centre in the shown room, or null for an item that room
  // has no stand-in for (it keeps the photo model's own world transform).
  show(slots) {
    this.root.visible = !!slots;
    if (!slots) return;
    for (const [name, {part, world, anchor}] of this.items) {
      const marker = slots.get(name);
      part.visible = slots.has(name) && !!anchor;
      if (!part.visible) continue;
      part.matrix.copy(world);
      // Independently fitted geometry can differ by centimetres. A displaced stand-in
      // supplies a confirmed contact point in this version, even when the GLB baked its transform.
      if (marker && anchor.distanceTo(marker) > 0.03) {
        const e = part.matrix.elements;
        e[12] += marker.x - anchor.x;
        e[13] += marker.y - anchor.y;
        e[14] += marker.z - anchor.z;
      }
      part.matrixWorldNeedsUpdate = true;
    }
  }

  dispose() { disposeModel(this.root); }
}
