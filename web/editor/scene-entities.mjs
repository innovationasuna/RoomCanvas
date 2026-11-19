import {topMembers} from './room-catalog.mjs';

export function groupRoomEntities(THREE, {room, config, floorY, originalMatrices}) {
  const entities = new Map();
  // Validate all required names first; never silently publish a partly editable scene.
  const assigned = new Set();
  for (const spec of config.catalog) for (const name of spec.roots) {
    if (assigned.has(name)) throw new Error(`物品重复归组 ${name}`);
    assigned.add(name);
  }
  const members = new Map(config.catalog.map((spec) => [spec.id, topMembers(room, spec.roots)]));
  for (const spec of config.catalog) {
    const bounds = new THREE.Box3();
    members.get(spec.id).forEach((object) => bounds.expandByObject(object));
    const origin = bounds.getCenter(new THREE.Vector3());
    origin.y = floorY;
    const group = new THREE.Group();
    group.name = `Editable_${spec.id}`;
    group.position.copy(origin);
    room.add(group);
    group.updateMatrixWorld(true);
    for (const object of members.get(spec.id)) group.attach(object);
    group.traverse((object) => {if (object.isMesh) object.userData.editorId = spec.id;});
    const dimensions = bounds.getSize(new THREE.Vector3());
    const sizeLabel = `${dimensions.x.toFixed(2)} × ${dimensions.z.toFixed(2)} × ${dimensions.y.toFixed(2)} ${config.units}`;
    entities.set(spec.id, {...spec, group, origin, sizeLabel, dimensions: dimensions.toArray()});
  }
  room.updateMatrixWorld(true);
  let groupingError = 0;
  for (const [object, matrix] of originalMatrices) {
    matrix.elements.forEach((value, i) => {groupingError = Math.max(groupingError, Math.abs(value - object.matrixWorld.elements[i]));});
  }
  if (groupingError > 1e-6) throw new Error('物品归组改变了原始位置');
  return {entities, audit: {groupingError, groupedRoots: assigned.size, meshes: originalMatrices.size}};
}
