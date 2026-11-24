// Load the photo meshes once. Ancestors contribute their transforms, never their furniture geometry.
import * as THREE from 'three';
import {disposeModel} from './resources.mjs';

export function selectPhotoItems(gltf, ids, roomIds) {
  const wanted = new Set(ids), nodes = gltf.nodes;
  function keep(index, inside) {
    const node = nodes[index];
    const item = wanted.has(node.name);
    const separate = node.extras?.room_id || roomIds?.has(node.name);
    const own = item || (inside && !separate);
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

// Articulation may split an existing textured mesh into a body and moving panels.
function vertexKey(positions, index) {
  return [positions.getX(index), positions.getY(index), positions.getZ(index)].join(',');
}

function meshKey(mesh) {
  return JSON.stringify([mesh.userData.name || mesh.name, mesh.geometry.name,
    [mesh.material].flat().map(m => [m.name, m.map?.name])]);
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
      const meshes = [];
      part.traverse(o => {
        if (!o.isMesh) return;
        const positions = o.geometry.attributes.position, samples = new Set();
        const count = Math.min(12, positions.count);
        for (let i = 0; i < count; i++) {
          samples.add(vertexKey(positions, Math.floor(i * positions.count / count)));
        }
        meshes.push({key: meshKey(o), samples});
      });
      this.items.set(part.userData.name || part.name, {part, world, anchor, meshes});
    }
    this.root.traverse(o => {if (o.isMesh) o.castShadow = o.receiveShadow = true;});
  }

  isNative(name, node) {
    const photo = this.items.get(name);
    if (!photo?.meshes.length) return false;
    const candidates = new Map();
    node.traverse(o => {
      if (!o.isMesh || o.userData.mask) return;
      const key = meshKey(o);
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(o.geometry.attributes.position);
    });
    return photo.meshes.every(({key, samples}) => candidates.get(key)?.some(positions => {
      const matched = new Set();
      for (let i = 0; i < positions.count; i++) {
        const vertex = vertexKey(positions, i);
        if (samples.has(vertex)) matched.add(vertex);
        if (matched.size >= Math.min(3, samples.size)) return true;
      }
      return false;
    }));
  }

  show(slots) {
    this.root.visible = !!slots;
    if (!slots) return;
    for (const [name, {part, world, anchor}] of this.items) {
      const marker = slots.get(name);
      part.visible = !!(marker && anchor);
      if (!part.visible) continue;
      part.matrix.copy(world);
      // Independently fitted geometry can differ by centimetres. A displaced stand-in
      // supplies a confirmed contact point in this version, even when the GLB baked its transform.
      if (anchor.distanceTo(marker) > 0.03) {
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
