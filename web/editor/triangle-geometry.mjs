// The page keeps its authored point arrays. The Worker keeps the Float64 vertices
// and Uint32 indices it received, without expanding every face into more arrays.
export const triangleCount = (mesh) => mesh.triangles ? mesh.triangles.length : mesh.index.length / 3;

// A vertex's identity is its original point object or its packed index, never a
// coordinate-based weld. Coincident vertices may still have distinct identities.
export const vertexAt = (mesh, face, corner) => mesh.triangles ? mesh.triangles[face][corner] : mesh.index[face * 3 + corner];

export function readVertex(mesh, vertex, target = null) {
  if (mesh.triangles) return vertex;
  target ||= [0, 0, 0];
  const offset = vertex * 3, vertices = mesh.vertices;
  target[0] = vertices[offset]; target[1] = vertices[offset + 1]; target[2] = vertices[offset + 2];
  return target;
}

export function vertexDot(mesh, vertex, x, y, z) {
  if (mesh.triangles) return x * vertex[0] + y * vertex[1] + z * vertex[2];
  const offset = vertex * 3, vertices = mesh.vertices;
  return x * vertices[offset] + y * vertices[offset + 1] + z * vertices[offset + 2];
}

// Callers that only inspect one face at a time can reuse a three-point scratch
// triangle. Narrow-phase callers may keep a decoded face for the current query;
// neither accessor caches expanded geometry on the mesh.
export function readTriangle(mesh, face, target = null) {
  if (mesh.triangles) return mesh.triangles[face];
  target ||= [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let corner = 0; corner < 3; corner++) readVertex(mesh, mesh.index[face * 3 + corner], target[corner]);
  return target;
}
