// A picture laid on a surface (a notice on its board, a print in its frame) is a textured slab a fraction of a
// millimetre in front of what holds it. Depth precision alone cannot keep the two apart on every GPU: Apple GPUs
// show the tie as blocks of the backing through the picture. Polygon offset settles the tie in depth-buffer
// units, so the picture wins at any distance and angle.
const THIN = .002;          // m: every vertex within this of the slab's largest face
const MAX_VERTICES = 512;   // pictures are a few quads; anything bigger is not a decal
export const DECAL_OFFSET = {factor: -1, units: -4};
// The room's own floor, ceiling and walls can be single textured quads; they are what pictures lie on.
const STRUCTURE = /^(Floor|Ceiling|Wall)\d*(_\d+)?$/;

function isStructure(mesh) {
  return STRUCTURE.test(mesh.name) || (!!mesh.parent && !mesh.parent.isScene && STRUCTURE.test(mesh.parent.name)
    && mesh.name.startsWith(mesh.parent.name));
}

// Measured per mesh at its world size: instances of one geometry may be scaled differently.
function isThinSlab(THREE, mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position || position.count > MAX_VERTICES) return false;
  const scale = mesh.getWorldScale(new THREE.Vector3());
  const point = (i, v) => v.fromBufferAttribute(position, i).multiply(scale);
  const index = mesh.geometry.index, count = index ? index.count : position.count, at = (i) => index ? index.getX(i) : i;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), triangle = new THREE.Triangle();
  let best = 0; const plane = new THREE.Plane();
  for (let i = 0; i + 2 < count; i += 3) {
    triangle.set(point(at(i), a), point(at(i + 1), b), point(at(i + 2), c));
    const area = triangle.getArea();
    if (area > best) {best = area; triangle.getPlane(plane);}
  }
  if (!(best > 0)) return false;
  for (let i = 0; i < position.count; i++) if (Math.abs(plane.distanceToPoint(point(i, a))) > THIN) return false;
  return true;
}

// Pulls every textured thin slab under root in front of what it lies on. Only the slab's textured material slots
// change, through copies shared among the slabs, so a backing that shares the source material keeps it as it was.
// Returns how many meshes it marked.
export function offsetDecals(THREE, root) {
  root.updateMatrixWorld(true);
  const copies = new Map();
  const offset = (material) => {
    if (!copies.has(material)) {
      const copy = material.clone();
      copy.polygonOffset = true;
      copy.polygonOffsetFactor = Math.min(material.polygonOffsetFactor || 0, DECAL_OFFSET.factor);
      copy.polygonOffsetUnits = Math.min(material.polygonOffsetUnits || 0, DECAL_OFFSET.units);
      copies.set(material, copy);
    }
    return copies.get(material);
  };
  let marked = 0;
  root.traverse((mesh) => {
    if (!mesh.isMesh || isStructure(mesh)) return;
    const materials = [mesh.material].flat();
    if (!materials.some((m) => m?.map) || !isThinSlab(THREE, mesh)) return;
    const next = materials.map((m) => m?.map ? offset(m) : m);
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    marked++;
  });
  return marked;
}
