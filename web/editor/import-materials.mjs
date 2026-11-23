import {setOwnMaterial, setOwnShadows} from './material-layers.mjs';

// Keep the existing vertex-colour display and an independent, reversible lit version.
// Only the visible reconstruction is registered here; collision proxies are untouched.
export function createImportMaterials(THREE, root, {mode = 'original', preservePBR = false} = {}) {
  const entries = [], resources = new Set();
  root.traverse(mesh => {
    if (!mesh.isMesh || mesh.userData.contactOnly) return;
    const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const geometry = mesh.geometry;
    if (!geometry.attributes.normal) {mesh.geometry = geometry.clone(); mesh.geometry.computeVertexNormals(); resources.add(mesh.geometry);}
    const vertexColors = !!mesh.geometry.attributes.color;
    const original = source.map(() => new THREE.MeshBasicMaterial({vertexColors, side: THREE.DoubleSide}));
    const lit = source.map(material => {
      if (material.isMeshStandardMaterial) {
        const clone = material.clone(); clone.vertexColors = vertexColors; clone.side = THREE.DoubleSide; return clone;
      }
      // GLTFLoader has already assigned colour/data spaces. Do not convert vertex colours twice.
      return new THREE.MeshStandardMaterial({color: material.color?.clone() || 0xffffff,
        map: material.map || null, vertexColors, roughness: .75, metalness: 0, side: THREE.DoubleSide,
        transparent: material.transparent, opacity: material.opacity, alphaTest: material.alphaTest,
        alphaMap: material.alphaMap || null, depthWrite: material.depthWrite});
    });
    for (const material of [...source, ...original, ...lit]) resources.add(material);
    entries.push({mesh, source, original, lit, array: Array.isArray(mesh.material), sourceGeometry: geometry,
      receiveShadow: mesh.receiveShadow, normalAdded: !geometry.attributes.normal});
  });
  // Native textured PBR assets keep their material when legacy vertex-colour lighting is off.
  let activeMode;
  function setMode(next) {
    if (!['original', 'pbr'].includes(next)) throw new Error('未知导入材质模式');
    const effective = preservePBR ? 'pbr' : next;
    if (effective === activeMode) return false;
    activeMode = effective;
    for (const entry of entries) {
      const lit = effective === 'pbr';
      const materials = lit ? entry.lit : entry.original;
      // The mesh's own look: a selection tint or a see-through layer stays on top of it.
      setOwnMaterial(entry.mesh, entry.array ? materials : materials[0]);
      setOwnShadows(entry.mesh, {receiveShadow: lit});
    }
    return entries.length > 0;
  }
  setMode(mode);
  return {
    setMode,
    snapshot() {return {mode: activeMode, meshes: entries.length, normalsAdded: entries.filter(e => e.normalAdded).length,
      vertexColorMeshes: entries.filter(e => e.mesh.geometry.attributes.color).length,
      litTypes: [...new Set(entries.flatMap(e => e.lit.map(m => m.type)))],
      sourcePBR: entries.filter(e => e.source.every(m => m.isMeshStandardMaterial)).length};},
    dispose() {
      for (const entry of entries) {
        setOwnMaterial(entry.mesh, entry.array ? entry.source : entry.source[0]);
        setOwnShadows(entry.mesh, {receiveShadow: entry.receiveShadow}); entry.mesh.geometry = entry.sourceGeometry;
      }
      // Source materials may be shared with the GLTF scene; their ownership stays with the caller.
      const sources = new Set(entries.flatMap(entry => entry.source));
      for (const resource of resources) if (!sources.has(resource)) resource.dispose();
    },
  };
}

export function updateImportLighting(entities, mode, rig) {
  const changed = [...entities.values()].filter(entity => entity.importMaterials?.setMode(mode));
  if (changed.length) rig?.invalidateWindowReflection();
  return changed;
}
