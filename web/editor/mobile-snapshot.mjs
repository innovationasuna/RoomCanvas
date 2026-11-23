import {ownMaterial} from './material-layers.mjs';

// Capture synchronously before any texture encoding awaits. Editor userData can contain circular
// articulation references; only the public snapshot metadata belongs in a portable GLB.
export function captureRoom(THREE, {room, entities, layout, ceilingObjects = [], parts = [], walls = [], wallOwner = () => null, lighting = null, name, floorY, bounds}) {
  const hidden = new Set([...entities.values()].filter(e => layout[e.id]?.visible === false).map(e => e.group));
  const ceilings = new Set(ceilingObjects), rest = new Map();
  for (const part of parts) {
    rest.set(part.node, part.rest);
    for (const rider of part.riders || []) rest.set(rider.node, rider.rest);
  }
  const materials = new Map();
  function copy(source) {
    if (hidden.has(source) || source.isLight || source.isCamera || source.isLine || source.isPoints || source.userData.mobileExclude) return null;
    if (source.isSkinnedMesh) throw new Error('该房间含骨骼模型，暂不能生成完整快照');
    if (source.isMesh && [ownMaterial(source)].flat().every(material => material.colorWrite === false)) return null;
    const target = new source.constructor();
    target.copy({...source, userData: {}}, false);
    target.name = source.userData.name || source.name;
    // Concealment only changes materials; ceilings additionally change object visibility.
    target.visible = ceilings.has(source) || source.visible;
    if (rest.has(source)) {
      target.matrix.copy(rest.get(source));
      target.matrix.decompose(target.position, target.quaternion, target.scale);
      target.matrixAutoUpdate = false;
    }
    if (source.isMesh) {
      const cloneMaterial = m => {
        if (!materials.has(m)) materials.set(m, m.clone());
        return materials.get(m);
      };
      const own = ownMaterial(source);
      target.material = Array.isArray(own) ? own.map(cloneMaterial) : cloneMaterial(own);
      // Geometry is not modified by editor transforms; detached references remain valid on removal.
      target.geometry = source.geometry;
    }
    for (const child of source.children) {const made = copy(child); if (made) target.add(made);}
    return target;
  }
  const root = copy(room);
  const metadata = {
    schema: 1, name, version: crypto.randomUUID(), createdAt: new Date().toISOString(),
    units: 'm', floorY, bounds, interaction: 'static',
    objects: [...entities.values()].filter(e => !hidden.has(e.group)).map(e => ({id: e.id, name: e.name})),
  };
  if (walls.length) metadata.cutaway = {
    walls: walls.map(({name, n, d, tangent, bounds}) => ({name, n: [...n], d, tangent: [...tangent], bounds: bounds.map(p => [...p])})),
    owners: Object.fromEntries(room.children.map(source => {
      const name = source.userData.name || source.name;
      return [name, wallOwner(name)];
    }).filter(([, owner]) => owner)),
    ceilings: ceilingObjects.map(source => source.userData.name || source.name),
  };
  if (lighting) metadata.lighting = JSON.parse(JSON.stringify(lighting));
  root.userData.roomcanvas = metadata;
  root.updateMatrixWorld(true);
  return {root, metadata, dispose() {for (const material of materials.values()) material.dispose();}};
}

export async function encodeRoom(snapshot) {
  try {
    const {GLTFExporter} = await import('three/addons/exporters/GLTFExporter.js');
    const data = await new GLTFExporter().parseAsync(snapshot.root, {binary: true, onlyVisible: true});
    return {blob: new Blob([data], {type: 'model/gltf-binary'}), metadata: snapshot.metadata};
  } finally {snapshot.dispose();}
}
