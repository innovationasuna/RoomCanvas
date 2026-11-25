// Load the photo meshes once. Ancestors contribute their transforms, never their furniture geometry.
import * as THREE from 'three';
import {disposeModel} from './resources.mjs';

const OBJECT_NAME = /^[A-Z][A-Za-z]*\d+$/;

// Where another room object starts below an item. Cutting the photo model and masking a version
// use this same boundary, so a separate child is neither carried along nor hidden twice.
export function separateObject(name, roomId, isMesh, objects) {
  return !!roomId || !!objects?.has(name) || (!isMesh && OBJECT_NAME.test(name));
}

// holders: objects kept whole, with everything on them (see photoHolders).
export function selectPhotoItems(gltf, ids, objects, holders = []) {
  const wanted = new Set(ids), whole = new Set(holders), nodes = gltf.nodes;
  function keep(index, inside, all = false) {
    const node = nodes[index];
    const item = wanted.has(node.name);
    all ||= whole.has(node.name);
    const own = all || item || (inside && !separateObject(node.name, node.extras?.room_id, node.mesh != null, objects));
    node.children = (node.children || []).filter(child => keep(child, own, all));
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

// The nodes a GLB lists in the JSON chunk at its start, read without the rest of the file:
// [{name, parent (index or null), mesh, roomId}].
export async function modelNodes(url, signal) {
  const response = await fetch(url, {signal});
  if (!response.ok || !response.body) throw new Error(`model HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0, need = 20, head = null;
  try {
    while (size < need) {
      const {done, value} = await reader.read();
      if (done) throw new Error('model ends early');
      chunks.push(value);
      size += value.length;
      if (!head && size >= 20) {
        head = new DataView(concat(chunks, size).buffer);
        if (head.getUint32(0, true) !== 0x46546c67 || head.getUint32(16, true) !== 0x4e4f534a) throw new Error('not a GLB');
        need = 20 + head.getUint32(12, true);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const json = JSON.parse(new TextDecoder().decode(concat(chunks, size).subarray(20, need)));
  const nodes = json.nodes || [], parent = [];
  nodes.forEach((node, k) => (node.children || []).forEach(child => (parent[child] = k)));
  return nodes.map((node, k) => ({name: node.name, parent: parent[k] ?? null, mesh: node.mesh != null, roomId: node.extras?.room_id}));
}

function concat(chunks, size) {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {bytes.set(chunk, at); at += chunk.length;}
  return bytes;
}

const SHELL = /^(Floor|Wall|Ceiling)\d+$/;

// The object each photo item stands on or in, in the pass's room (the nearest above it, not the floor, a wall
// or the ceiling). A holder the build room has, but none of its items, is an earlier version of it: the items
// were placed in a later one (shelves rearranged, say). It is carried: shown as in the pass's room, everything on
// it included (see SmallItemLayer), and inside: the build room's own parts in it, which never show.
export function photoHolders(passNodes, buildNodes, ids, objects, members = {}) {
  const byName = new Map(passNodes.map(node => [node.name, node])), holders = {};
  for (const id of ids) {
    for (let k = byName.get(id)?.parent; k != null; k = passNodes[k].parent) {
      const node = passNodes[k];
      if (!separateObject(node.name, node.roomId, node.mesh, objects)) continue;
      if (!SHELL.test(node.name)) holders[id] = node.name;
      break;
    }
  }
  const built = new Map(buildNodes.map((node, k) => [node.name, k]));
  const standing = id => [id, ...(members[id] || [])].some(name => built.has(name));
  const carried = [...new Set(Object.values(holders))]
    .filter(holder => !ids.includes(holder) && built.has(holder) && ids.every(id => holders[id] !== holder || !standing(id)));
  const under = new Set(carried.map(holder => built.get(holder))), inside = [];
  buildNodes.forEach((node, k) => {
    for (let p = node.parent; p != null; p = buildNodes[p].parent) if (under.has(p)) {inside.push(node.name); break;}
  });
  return {holders, carried, inside};
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
  // holders: the carried objects (see photoHolders), each kept whole where the pass's room has it; contents(name):
  // whether a node in one is another object on it.
  constructor(root, ids, {holders = [], contents = () => false} = {}) {
    this.root = new THREE.Group();
    this.items = new Map();
    this.holders = new Map();
    root.updateMatrixWorld(true);
    const wanted = new Set(ids), whole = new Set(holders), parts = [], frames = [];
    const name = node => node.userData.name || node.name;
    root.traverse(node => {
      if (wanted.has(name(node))) parts.push(node);
      else if (whole.has(name(node))) frames.push(node);
    });
    // The items first: those on a holder leave it, to show at their own times.
    for (const part of [...parts.reverse(), ...frames.reverse()]) {
      const world = part.matrixWorld.clone();
      const anchor = bottomCenter(new THREE.Box3().setFromObject(part));
      this.root.add(part);
      part.matrixAutoUpdate = false;
      part.matrix.copy(world);
      part.matrixWorldNeedsUpdate = true;
      part.visible = false;
      if (wanted.has(name(part))) this.items.set(name(part), {part, world, anchor});
      else {
        const on = [];
        part.traverse(o => {if (o !== part && contents(name(o))) on.push(o);});
        this.holders.set(name(part), {part, contents: on});
      }
    }
    this.root.traverse(o => {if (o.isMesh) o.castShadow = o.receiveShadow = true;});
  }

  // slots: item -> its stand-in's bottom centre in the shown room, or null for an item that room
  // has no stand-in for (it keeps the photo model's own world transform). holders: carried holder ->
  // whether what else stood on it shows yet. Returns what came into view since the layer last showed, for the
  // room view to let take shape (nothing when the layer itself comes into view: it is simply there).
  show(slots, holders) {
    const shown = this.root.visible, appeared = [];
    const set = (o, visible) => {
      if (visible && !o.visible) appeared.push(o);
      o.visible = visible;
    };
    this.root.visible = !!slots;
    if (!slots) return [];
    for (const [name, {part, contents}] of this.holders) {
      const whole = !part.visible;  // a holder coming into view takes what stands on it along
      set(part, !!holders?.has(name));
      for (const o of contents) {
        if (whole) o.visible = !!holders?.get(name);
        else set(o, !!holders?.get(name));
      }
    }
    for (const [name, {part, world, anchor}] of this.items) {
      const marker = slots.get(name);
      set(part, slots.has(name) && !!anchor);
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
    return shown ? appeared : [];
  }

  dispose() { disposeModel(this.root); }
}
