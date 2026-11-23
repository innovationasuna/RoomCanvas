// A picture laid on a surface (a notice on its board, a print in its frame) is a textured slab a fraction of a
// millimetre in front of what holds it. Depth precision alone cannot keep the two apart on every GPU: Apple GPUs
// show the tie as blocks of the backing through the picture. Polygon offset settles the tie in depth-buffer
// units, so the picture wins at any distance and angle.
const THIN = .002;          // m: every vertex within this of the slab's largest face
const MAX_VERTICES = 512;   // pictures are a few quads; anything bigger is not a decal
export const DECAL_OFFSET = {factor: -1, units: -4};
// The room's own floor, ceiling and walls can be single textured quads; they are what pictures lie on.
const STRUCTURE = /^(Floor|Ceiling|Wall)\d*(_\d+)?$/;

// GLTFLoader turns a node with several primitives into a group of meshes named after the mesh data, not the
// node; its associations tell which node a mesh belongs to. Without them, a mesh named like its parent is taken
// as one of the parent's primitives.
function isStructure(mesh, associations) {
  const own = associations?.get(mesh);
  const node = own ? (own.nodes !== undefined ? mesh : mesh.parent) : null;
  if (node) return STRUCTURE.test(node.name);
  return STRUCTURE.test(mesh.name) || (!!mesh.parent && !mesh.parent.isScene && STRUCTURE.test(mesh.parent.name)
    && mesh.name.startsWith(mesh.parent.name));
}

// Measured in world space through the full transform (a rotated slab under a non-uniformly scaled parent is
// sheared), per mesh and per GPU instance: instances of one geometry may be sized differently.
function isThinSlab(THREE, mesh, matrix = mesh.matrixWorld) {
  const position = mesh.geometry?.attributes?.position;
  if (!position || position.count > MAX_VERTICES) return false;
  const point = (i, v) => v.fromBufferAttribute(position, i).applyMatrix4(matrix);
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
export function offsetDecals(THREE, root, associations) {
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
    if (!mesh.isMesh || isStructure(mesh, associations)) return;
    const materials = [mesh.material].flat();
    if (!materials.some((m) => m?.map)) return;
    const instance = new THREE.Matrix4();
    const thin = mesh.isInstancedMesh
      ? Array.from({length: mesh.count}, (_, i) => isThinSlab(THREE, mesh, instance.copy(mesh.matrixWorld).multiply(
        new THREE.Matrix4().fromArray(mesh.instanceMatrix.array, i * 16)))).some(Boolean)
      : isThinSlab(THREE, mesh);
    if (!thin) return;
    const next = materials.map((m) => m?.map ? offset(m) : m);
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    marked++;
  });
  return marked;
}
