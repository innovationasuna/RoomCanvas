// A picture laid on a surface (a notice on its board, a print in its frame) is a textured slab a fraction of a
// millimetre in front of what holds it. Depth precision alone cannot keep the two apart on every GPU: Apple GPUs
// show the tie as blocks of the backing through the picture. Polygon offset settles the tie in depth-buffer
// units, so the picture wins at any distance and angle.
//
// The same tie shows on a part modelled over another part of its object with faces in common (a pale box for the
// tip of a dark bar, as wide and as high as the bar): the two colours take turns, pixel by pixel. The smaller part
// is the detail, and is settled in front the same way.
const THIN = .002;          // m: every vertex within this of the slab's largest face
const FLUSH = .0003;        // m: two faces this close, facing the same way, are one surface
const MAX_VERTICES = 512;   // pictures are a few quads, parts a few boxes; anything bigger is neither
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

// A small mesh's triangles in the room, with their planes, and what bounds them.
function faces(THREE, mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position || position.count > MAX_VERTICES || mesh.isInstancedMesh) return null;
  const index = mesh.geometry.index, count = index ? index.count : position.count, at = (i) => index ? index.getX(i) : i;
  const triangles = [], box = new THREE.Box3();
  let area = 0;
  for (let i = 0; i + 2 < count; i += 3) {
    const triangle = new THREE.Triangle();
    for (const [k, v] of [triangle.a, triangle.b, triangle.c].entries()) box.expandByPoint(v.fromBufferAttribute(position, at(i + k)).applyMatrix4(mesh.matrixWorld));
    const size = triangle.getArea();
    if (!(size > 1e-8)) continue;
    area += size;
    triangles.push({triangle, plane: triangle.getPlane(new THREE.Plane()), middle: triangle.getMidpoint(new THREE.Vector3())});
  }
  return triangles.length ? {mesh, triangles, box: box.expandByScalar(FLUSH), area} : null;
}

// Whether a face of one part lies on a face of the other, both facing the same way. Faces that meet back to back
// (a book against the next one, a vase on its shelf) are hidden, and no tie.
function onOneSurface(part, other) {
  return part.triangles.some(({plane, middle}) => other.triangles.some((face) => face.plane.normal.dot(plane.normal) > .999
    && Math.abs(face.plane.distanceToPoint(middle)) < FLUSH && face.triangle.containsPoint(middle)));
}

// The parts under root that share a surface with a larger part beside them, of another material (two parts of one
// material show no tie). Parts already settled in front (pictures) are left as they are.
function flushParts(THREE, root, associations) {
  const groups = new Map(), found = [];
  root.traverse((mesh) => {
    if (!mesh.isMesh || isStructure(mesh, associations) || [mesh.material].flat().some((m) => !m || m.polygonOffset)) return;
    const own = associations?.get(mesh), node = own && own.nodes === undefined ? mesh.parent : mesh;
    const part = node.parent && faces(THREE, mesh);
    if (part) groups.set(node.parent, [...(groups.get(node.parent) || []), part]);
  });
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.area - b.area);
    parts.forEach((part, i) => {
      const materials = new Set([part.mesh.material].flat());
      const larger = (other) => other.box.intersectsBox(part.box) && [other.mesh.material].flat().some((m) => !materials.has(m));
      if (parts.slice(i + 1).some((other) => larger(other) && onOneSurface(part, other))) found.push(part.mesh);
    });
  }
  return found;
}

// Pulls every textured thin slab under root in front of what it lies on, and every small part in front of the
// larger part it shares a surface with. Only the slab's textured material slots change (all of a part's), through
// copies shared among them, so a backing that shares the source material keeps it as it was.
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
  for (const mesh of flushParts(THREE, root, associations)) {
    const next = [mesh.material].flat().map(offset);
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    marked++;
  }
  return marked;
}
