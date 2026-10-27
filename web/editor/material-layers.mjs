// Several features change how a mesh looks for a while: a near wall gone see-through, the walls
// while choosing a new one for a hanging piece, the wall being edited, the selected piece's tint,
// the drag preview. Each used to swap mesh.material itself and put back what it had replaced. When
// two of them overlapped, one stored the other's temporary material as the original and put it
// back later: a wall stayed solid when it should be see-through, a carried vase stayed faint with
// its own colour overwritten by the preview's.
//
// Here a mesh keeps its own material, and each feature only sets or clears a named layer. The
// material shown is rebuilt from the mesh's own one through the layers that are on, in LAYERS
// order, so the later ones win. Code that changes the mesh's own look (lighting presets, an
// imported object's lit/unlit mode) goes through setOwnMaterial / setOwnShadows, which keeps the
// layers on top.
export const LAYERS = ['seeThrough', 'wallChoice', 'editingWall', 'selected', 'preview'];

// mesh → {own: {material, castShadow, receiveShadow}, layers: Map(name → layer), made: [materials]}.
// Not in userData: Object3D.clone() copies userData through JSON.
const states = new WeakMap();

export function ownMaterial(mesh) {return states.get(mesh)?.own.material ?? mesh.material;}

export function ownShadows(mesh) {
  const own = states.get(mesh)?.own ?? mesh;
  return {castShadow: own.castShadow, receiveShadow: own.receiveShadow};
}

export function setOwnMaterial(mesh, material) {
  const state = states.get(mesh);
  if (!state) {mesh.material = material; return;}
  state.own.material = material;
  rebuild(mesh, state);
}

export function setOwnShadows(mesh, shadows) {
  const state = states.get(mesh);
  if (!state) {Object.assign(mesh, shadows); return;}
  Object.assign(state.own, shadows);
  rebuild(mesh, state);
}

export function hasLayer(mesh, name) {return !!states.get(mesh)?.layers.has(name);}

// layer: {material?: (material) => a new material made from it, castShadow?, receiveShadow?},
// or null to take the layer off. Returns whether the mesh changed.
export function setLayer(mesh, name, layer) {
  if (!LAYERS.includes(name)) throw new Error(`unknown material layer ${name}`);
  let state = states.get(mesh);
  if (!layer) {
    if (!state?.layers.delete(name)) return false;
  } else {
    if (!state) {
      state = {own: {material: mesh.material, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow}, layers: new Map(), made: []};
      states.set(mesh, state);
    }
    state.layers.set(name, layer);
  }
  rebuild(mesh, state);
  return true;
}

function rebuild(mesh, state) {
  for (const material of state.made) material.dispose();
  state.made = [];
  const {own} = state;
  let materials = [own.material].flat(), castShadow = own.castShadow, receiveShadow = own.receiveShadow;
  for (const name of LAYERS) {
    const layer = state.layers.get(name);
    if (!layer) continue;
    if (layer.material) materials = materials.map((material) => {const made = layer.material(material); state.made.push(made); return made;});
    if (layer.castShadow !== undefined) castShadow = layer.castShadow;
    if (layer.receiveShadow !== undefined) receiveShadow = layer.receiveShadow;
  }
  mesh.material = !state.made.length ? own.material : Array.isArray(own.material) ? materials : materials[0];
  mesh.castShadow = castShadow; mesh.receiveShadow = receiveShadow;
  if (!state.layers.size) states.delete(mesh);
}
