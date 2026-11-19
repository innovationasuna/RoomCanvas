import {meshGeometry} from './entity-geometry.mjs';
import {triangleIndex, collisionMeshSource} from './collision.mjs';

// Placement and walking share immutable triangle indexes. Each ray is transformed
// into the index's captured frame, so doors, drawers and carried objects use their
// current articulated matrix without rebuilding any triangles.
export function createRayQueries(THREE, room, owners = []) {
  let entries = [];
  const fallback = new WeakMap(), v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const localRay = new THREE.Ray(), point = new THREE.Vector3();
  const audit = {queries: 0, triangles: 0, boxes: 0};
  function entry(mesh, triangles, reference, origin) {
    return {mesh, index: triangleIndex(triangles), toLocal: reference.clone().invert().multiply(new THREE.Matrix4().makeTranslation(...origin)),
      localNormal: new THREE.Matrix3().setFromMatrix4(reference).transpose(), sign: Math.sign(reference.determinant()),
      world: new THREE.Matrix4(), inverse: new THREE.Matrix4(), normal: new THREE.Matrix3(), sourceWorld: null};
  }
  function rebuild(next = owners) {
    owners = next;
    const previous = new Map(entries.map((item) => [item.mesh, item])), indexed = new Map();
    for (const owner of owners) for (const mesh of owner.meshes) {
      const source = collisionMeshSource(mesh);
      if (!source) continue;
      const old = previous.get(source.mesh);
      const index = triangleIndex(mesh.triangles);
      indexed.set(source.mesh, old?.index === index ? old : entry(source.mesh, mesh.triangles, source.matrix, owner.origin));
    }
    // The floor is deliberately excluded from furniture collision but is essential
    // to safe spawn queries. Any other query-only mesh follows the same contract.
    room.updateMatrixWorld(true);
    room.traverse((mesh) => {
      if (!mesh.isMesh || mesh.userData.collision === false || indexed.has(mesh) || !mesh.geometry?.attributes.position) return;
      let item = fallback.get(mesh);
      const version = `${mesh.geometry.attributes.position.version}:${mesh.geometry.index?.version ?? -1}`;
      if (!item || item.geometry !== mesh.geometry || item.version !== version) {
        const data = meshGeometry(THREE, mesh);
        item = entry(mesh, data.triangles, mesh.matrixWorld, [0, 0, 0]);
        item.geometry = mesh.geometry; item.version = version; fallback.set(mesh, item);
      }
      indexed.set(mesh, item);
    });
    entries = [...indexed.values()].filter((item) => item.index.tree);
    refresh();
  }
  function refresh() {
    room.updateMatrixWorld(true);
    for (const item of entries) if (!item.sourceWorld?.equals(item.mesh.matrixWorld)) {
      item.sourceWorld = item.mesh.matrixWorld.clone();
      item.world.multiplyMatrices(item.mesh.matrixWorld, item.toLocal);
      item.inverse.copy(item.world).invert();
      item.normal.getNormalMatrix(item.mesh.matrixWorld);
    }
  }
  function boxEntry(box, far) {
    audit.boxes++;
    let low = 0, high = far;
    for (let k = 0; k < 3; k++) {
      const o = localRay.origin.getComponent(k), d = localRay.direction.getComponent(k);
      if (Math.abs(d) < 1e-15) {if (o < box[k] || o > box[k + 3]) return Infinity; continue;}
      const t0 = (box[k] - o) / d, t1 = (box[k + 3] - o) / d;
      low = Math.max(low, Math.min(t0, t1)); high = Math.min(high, Math.max(t0, t1));
      if (low > high) return Infinity;
    }
    return low;
  }
  function nearest(origin, direction, far = Infinity, accept = () => true) {
    audit.queries++;
    let best = null, distance = far;
    for (const item of entries) {
      const {mesh, index} = item;
      localRay.origin.copy(origin).applyMatrix4(item.inverse);
      v.copy(origin).add(direction).applyMatrix4(item.inverse).sub(localRay.origin);
      const scale = v.length();
      if (!scale) continue;
      localRay.direction.copy(v).multiplyScalar(1 / scale);
      function visit(node) {
        if (boxEntry(node.box, distance * scale) === Infinity) return;
        if (!node.faces) {
          const left = boxEntry(node.left.box, distance * scale), right = boxEntry(node.right.box, distance * scale);
          if (left <= right) {visit(node.left); visit(node.right);} else {visit(node.right); visit(node.left);}
          return;
        }
        for (const face of node.faces) {
          audit.triangles++;
          const materialIndex = mesh.geometry.groups.find((group) => face.faceIndex * 3 >= group.start && face.faceIndex * 3 < group.start + group.count)?.materialIndex || 0;
          const material = Array.isArray(mesh.material) ? mesh.material[materialIndex] : mesh.material;
          if (!material) continue;
          const facing = localRay.direction.dot(v.fromArray(face.plane)) * item.sign;
          if (material.side === THREE.FrontSide && facing >= 0 || material.side === THREE.BackSide && facing <= 0) continue;
          if (!localRay.intersectTriangle(a.fromArray(face.triangle[0]), b.fromArray(face.triangle[1]), c.fromArray(face.triangle[2]), false, point)) continue;
          const d = point.distanceTo(localRay.origin) / scale;
          if (d > distance || d < 0) continue;
          const normal = new THREE.Vector3().fromArray(face.plane).applyMatrix3(item.localNormal).multiplyScalar(item.sign).normalize();
          const hit = {object: mesh, distance: d, point: point.clone().applyMatrix4(item.world), faceIndex: face.faceIndex,
            face: {normal, materialIndex}, normal: normal.clone().applyNormalMatrix(item.normal)};
          if (!accept(hit)) continue;
          best = hit; distance = d;
        }
      }
      visit(index.tree);
    }
    return best;
  }
  rebuild();
  return {rebuild, refresh, nearest, audit};
}
