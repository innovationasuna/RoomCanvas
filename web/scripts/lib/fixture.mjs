// Shared CPU-only authored GLB fixture for the editor acceptance scripts.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {initialLayout} from '../../editor/layout.mjs';
import {createPlacement} from '../../editor/placement.mjs';
import {roomConfig, flattenObjects, topMembers} from '../../editor/room-catalog.mjs';

// Decode only authored positions/indices/transforms. Ignoring material and image data
// makes this fixture loader deterministic in Node without mocking a browser or WebGL.
export function loadGeometry(THREE, file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.readUInt32LE(0), 0x46546c67, 'fixture is GLB');
  assert.equal(bytes.readUInt32LE(4), 2, 'fixture is GLB v2');
  let json, bin;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
    if (type === 0x004e4942) bin = chunk;
    offset += length + 8;
  }
  assert(json && bin, 'GLB contains JSON and binary geometry');
  const types = {5120: [Int8Array, 'getInt8'], 5121: [Uint8Array, 'getUint8'], 5122: [Int16Array, 'getInt16'],
    5123: [Uint16Array, 'getUint16'], 5125: [Uint32Array, 'getUint32'], 5126: [Float32Array, 'getFloat32']};
  const sizes = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16};
  function accessor(index) {
    const data = json.accessors[index], view = json.bufferViews[data.bufferView];
    assert(!data.sparse && !data.normalized && view.buffer === 0, 'fixture uses plain local geometry accessors');
    const [Type, reader] = types[data.componentType], size = sizes[data.type];
    const array = new Type(data.count * size), width = Type.BYTES_PER_ELEMENT;
    const stride = view.byteStride || size * width, start = (view.byteOffset || 0) + (data.byteOffset || 0);
    const values = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    for (let item = 0; item < data.count; item++) for (let axis = 0; axis < size; axis++) {
      array[item * size + axis] = values[reader](start + item * stride + axis * width, true);
    }
    return new THREE.BufferAttribute(array, size);
  }
  const geometries = json.meshes.map((mesh) => mesh.primitives.map((primitive) => {
    assert(primitive.mode === undefined || primitive.mode === 4, 'fixture uses triangle meshes');
    assert(!primitive.targets, 'fixture has no animated morph collision geometry');
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', accessor(primitive.attributes.POSITION));
    if (primitive.indices !== undefined) geometry.setIndex(accessor(primitive.indices));
    return geometry;
  }));
  const material = new THREE.MeshBasicMaterial();
  const nodes = json.nodes.map((node, index) => {
    assert(node.skin === undefined, 'fixture has no skinned collision geometry');
    const parts = node.mesh === undefined ? [] : geometries[node.mesh];
    const object = parts.length === 1 ? new THREE.Mesh(parts[0], material) : new THREE.Group();
    if (parts.length > 1) parts.forEach((geometry, primitive) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${node.name || `node_${index}`}:primitive_${primitive}`;
      object.add(mesh);
    });
    object.name = node.name || `node_${index}`;
    object.userData.name = object.name;
    if (node.matrix) new THREE.Matrix4().fromArray(node.matrix).decompose(object.position, object.quaternion, object.scale);
    else {
      if (node.translation) object.position.fromArray(node.translation);
      if (node.rotation) object.quaternion.fromArray(node.rotation);
      if (node.scale) object.scale.fromArray(node.scale);
    }
    return object;
  });
  json.nodes.forEach((node, i) => (node.children || []).forEach((child) => nodes[i].add(nodes[child])));
  const room = new THREE.Group();
  json.scenes[json.scene || 0].nodes.forEach((node) => room.add(nodes[node]));
  room.updateMatrixWorld(true);
  return room;
}

// The room's object list, written by web/scripts/room_objects.py.
export function sceneConfig(sceneDir) {
  return roomConfig(JSON.parse(fs.readFileSync(path.join(sceneDir, 'room_objects.json'), 'utf8')));
}

// Three.js comes from the room's published preview when it has one, otherwise from web/vendor/.
const repoVendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../vendor');
export async function createFixture(sceneDir, threeDir = fs.existsSync(path.join(sceneDir, 'preview/vendor')) ? path.join(sceneDir, 'preview/vendor') : repoVendor) {
  const THREE = await import(pathToFileURL(path.join(threeDir, 'build/three.module.js')));
  const room = loadGeometry(THREE, path.join(sceneDir, 'Room.glb'));
  const config = sceneConfig(sceneDir);
  const before = new Map();
  room.traverse((object) => {if (object.isMesh) before.set(object, object.matrixWorld.clone());});
  flattenObjects(room, config.nodes);
  const roots = new Map(room.children.map((root) => [root.userData.name || root.name, root]));
  const floorY = new THREE.Box3().setFromObject(roots.get('Floor0')).max.y;
  const ceilingY = new THREE.Box3().setFromObject(roots.get('Wall0')).max.y;
  const entities = new Map();
  const members = new Map(config.catalog.map((spec) => [spec.id, topMembers(room, spec.roots)]));
  for (const spec of config.catalog) {
    const bounds = new THREE.Box3();
    members.get(spec.id).forEach((object) => bounds.expandByObject(object));
    const origin = bounds.getCenter(new THREE.Vector3()); origin.y = floorY;
    const group = new THREE.Group(); group.name = `Editable_${spec.id}`; group.position.copy(origin);
    room.add(group); group.updateMatrixWorld(true);
    members.get(spec.id).forEach((object) => group.attach(object));
    group.traverse((mesh) => {if (mesh.isMesh) mesh.userData.editorId = spec.id;});
    entities.set(spec.id, {...spec, origin, group, bounds});
  }
  room.updateMatrixWorld(true);
  // Grouping must leave every mesh where the reconstruction put it, as in the browser.
  for (const [mesh, matrix] of before) {
    assert(matrix.elements.every((value, i) => Math.abs(value - mesh.matrixWorld.elements[i]) < 1e-6), `grouping moved ${mesh.name}`);
  }
  const placement = createPlacement(THREE, room, entities, config.placement, floorY, ceilingY, {openings: config.openings});
  const ids = config.catalog.map(({id}) => id);
  const initial = initialLayout(ids);
  return {THREE, room, roots, floorY, ceilingY, entities, placement, ids, initial, config};
}
