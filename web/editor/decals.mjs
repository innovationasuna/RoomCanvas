// A picture laid on a surface (a notice on its board, a print in its frame) is a textured slab a fraction of a
// millimetre in front of what holds it. Depth precision alone cannot keep the two apart on every GPU: Apple GPUs
// show the tie as blocks of the backing through the picture. Polygon offset settles the tie in depth-buffer
// units, so the picture wins at any distance and angle.
const THIN = .002;          // m: every vertex within this of the slab's largest face
const MAX_VERTICES = 512;   // pictures are a few quads; anything bigger is not a decal

const thinness = new WeakMap();

function isThinSlab(THREE, mesh) {
  const geometry = mesh.geometry, position = geometry?.attributes?.position;
  if (!position || position.count > MAX_VERTICES) return false;
  if (thinness.has(geometry)) return thinness.get(geometry);
  // The plane of the largest triangle, in the mesh's own frame scaled to world size.
  const scale = mesh.getWorldScale(new THREE.Vector3());
  const point = (i, v) => v.fromBufferAttribute(position, i).multiply(scale);
  const index = geometry.index, count = index ? index.count : position.count, at = (i) => index ? index.getX(i) : i;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), triangle = new THREE.Triangle();
  let best = 0; const plane = new THREE.Plane();
  for (let i = 0; i + 2 < count; i += 3) {
    triangle.set(point(at(i), a), point(at(i + 1), b), point(at(i + 2), c));
    const area = triangle.getArea();
    if (area > best) {best = area; triangle.getPlane(plane);}
  }
  let thin = best > 0;
  for (let i = 0; thin && i < position.count; i++) if (Math.abs(plane.distanceToPoint(point(i, a))) > THIN) thin = false;
  thinness.set(geometry, thin);
  return thin;
}

// Pulls every textured thin slab under root in front of what it lies on. Returns how many meshes it marked.
export function offsetDecals(THREE, root) {
  root.updateMatrixWorld(true);
  let marked = 0;
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const materials = [mesh.material].flat();
    if (!materials.some((m) => m?.map) || !isThinSlab(THREE, mesh)) return;
    for (const material of materials) {
      material.polygonOffset = true;
      material.polygonOffsetFactor = Math.min(material.polygonOffsetFactor || 0, -1);
      material.polygonOffsetUnits = Math.min(material.polygonOffsetUnits || 0, -4);
    }
    marked++;
  });
  return marked;
}
