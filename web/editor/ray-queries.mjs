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
  function boxEntry(box, far, offset = 0) {
    audit.boxes++;
    let low = 0, high = far;
    for (let k = 0; k < 3; k++) {
      const o = localRay.origin.getComponent(k), d = localRay.direction.getComponent(k);
      if (Math.abs(d) < 1e-15) {if (o < box[offset + k] || o > box[offset + k + 3]) return Infinity; continue;}
      const t0 = (box[offset + k] - o) / d, t1 = (box[offset + k + 3] - o) / d;
      low = Math.max(low, Math.min(t0, t1)); high = Math.min(high, Math.max(t0, t1));
      if (low > high) return Infinity;
    }
    return low;
  }
  // Equal-distance faces used to be resolved by the last hit in the sorted BVH.
  // Repartitioning can change that face's normal/material at a shared edge. Only
  // for an actual tie, follow the old partitions down to the last candidate.
  // No second full tree is built or retained; index.faces keeps the old root order.
  function resolveTie(index, candidates, far) {
    const data = index.data;
    const bounds = (faces) => {
      const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const face of faces) for (let k = 0; k < 3; k++) {
        const offset = face * 10;
        if (data[offset + k] < box[k]) box[k] = data[offset + k];
        if (data[offset + k + 3] > box[k + 3]) box[k + 3] = data[offset + k + 3];
      }
      return box;
    };
    function last(faces, box, root = false) {
      if (faces.length <= 10) {
        for (let i = faces.length - 1; i >= 0; i--) {
          const hit = candidates.get(faces[i]);
          if (hit) return hit;
        }
        return null;
      }
      if (!root) {
        let axis = 0; for (let k = 1; k < 3; k++) if (box[k + 3] - box[k] > box[axis + 3] - box[axis]) axis = k;
        // Preserve the old arithmetic order too: subtracting two precomputed
        // centers can round differently for coincident faces.
        faces.sort((a, b) => data[a * 10 + axis] + data[a * 10 + axis + 3] - data[b * 10 + axis] - data[b * 10 + axis + 3]);
      }
      const mid = faces.length >> 1, left = faces.slice(0, mid), right = faces.slice(mid);
      const leftBox = bounds(left), rightBox = bounds(right);
      const leftFirst = boxEntry(leftBox, far) <= boxEntry(rightBox, far);
      const later = leftFirst ? right : left, earlier = leftFirst ? left : right;
      return later.some(face => candidates.has(face))
        ? last(later, leftFirst ? rightBox : leftBox)
        : last(earlier, leftFirst ? leftBox : rightBox);
    }
    return last(Array.from(index.faces), index.tree.box, true);
  }
  function nearest(origin, direction, far = Infinity, accept = () => true) {
    audit.queries++;
    let best = null, distance = far;
    for (const item of entries) {
      const {mesh, index} = item;
      const {tree, data} = index;
      let tied = null;
      localRay.origin.copy(origin).applyMatrix4(item.inverse);
      v.copy(origin).add(direction).applyMatrix4(item.inverse).sub(localRay.origin);
      const scale = v.length();
      if (!scale) continue;
      localRay.direction.copy(v).multiplyScalar(1 / scale);
      function visit(node) {
        if (boxEntry(tree.boxes, distance * scale, node * 6) === Infinity) return;
        const link = node * 4, count = tree.links[link + 3];
        if (!count) {
          const leftId = tree.links[link], rightId = tree.links[link + 1];
          const left = boxEntry(tree.boxes, distance * scale, leftId * 6), right = boxEntry(tree.boxes, distance * scale, rightId * 6);
          if (left <= right) {visit(leftId); visit(rightId);} else {visit(rightId); visit(leftId);}
          return;
        }
        const start = tree.links[link + 2], end = start + count;
        for (let position = start; position < end; position++) {
          const faceIndex = tree.order[position];
          audit.triangles++;
          const offset = faceIndex * 10, triangle = index.triangles[faceIndex];
          const materialIndex = mesh.geometry.groups.find((group) => faceIndex * 3 >= group.start && faceIndex * 3 < group.start + group.count)?.materialIndex || 0;
          const material = Array.isArray(mesh.material) ? mesh.material[materialIndex] : mesh.material;
          if (!material) continue;
          const facing = localRay.direction.dot(v.set(data[offset + 6], data[offset + 7], data[offset + 8])) * item.sign;
          if (material.side === THREE.FrontSide && facing >= 0 || material.side === THREE.BackSide && facing <= 0) continue;
          if (!localRay.intersectTriangle(a.fromArray(triangle[0]), b.fromArray(triangle[1]), c.fromArray(triangle[2]), false, point)) continue;
          const d = point.distanceTo(localRay.origin) / scale;
          if (d > distance || d < 0) continue;
          const normal = new THREE.Vector3(data[offset + 6], data[offset + 7], data[offset + 8]).applyMatrix3(item.localNormal).multiplyScalar(item.sign).normalize();
          const hit = {object: mesh, distance: d, point: point.clone().applyMatrix4(item.world), faceIndex,
            face: {normal, materialIndex}, normal: normal.clone().applyNormalMatrix(item.normal)};
          if (!accept(hit)) continue;
          if (d === distance && best?.object === mesh) {
            tied ||= new Map([[best.faceIndex, best]]);
            tied.set(hit.faceIndex, hit);
          } else tied = null;
          best = hit; distance = d;
        }
      }
      visit(0);
      if (tied) best = resolveTie(index, tied, distance * scale);
    }
    return best;
  }
  rebuild();
  return {rebuild, refresh, nearest, audit};
}
