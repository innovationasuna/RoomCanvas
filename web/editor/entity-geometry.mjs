// The editable group is positioned at origin in the authored room. Only its children
// carry model transforms (including the import's axis correction and metric scale).
const references = new WeakMap();

export function entityGeometry(THREE, {group, origin}) {
  if (!references.has(group)) {
    const nodes = new Map(), matrices = new Map(), bounds = new THREE.Box3(), box = new THREE.Box3();
    const root = new THREE.Matrix4().makeTranslation(origin);
    if (group.parent) root.premultiply(group.parent.matrixWorld);
    function visit(node, matrix) {
      nodes.set(node.userData.name || node.name, node);
      if (node.isMesh) matrices.set(node, matrix);
      if (node.geometry) {
        // Match Box3.setFromObject's conservative envelope, including display-only meshes.
        const source = node.boundingBox === undefined ? node.geometry : node;
        if (source.boundingBox === null) source.computeBoundingBox();
        bounds.union(box.copy(source.boundingBox).applyMatrix4(matrix));
      }
      for (const child of node.children) visit(child, matrix.clone().multiply(child.matrix));
    }
    // Callers have updated the scene matrices. Capture once, before preview joints open.
    visit(group, root);
    references.set(group, {nodes, matrices, bounds});
  }
  return references.get(group);
}

export function applyEntityPose({group, origin}, pose) {
  group.position.set(origin.x + pose.x, origin.y + (pose.y || 0), origin.z + pose.z);
  group.rotation.y = pose.yaw;
  group.visible = pose.visible !== false;
}
