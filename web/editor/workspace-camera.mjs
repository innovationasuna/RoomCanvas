// World dimensions visible at the orbit target, for screen-relative hand movement.
export function workspaceViewSize(camera, distance) {
  const height = camera.isPerspectiveCamera
    ? 2 * distance * Math.tan(camera.fov * Math.PI / 360) / camera.zoom
    : (camera.top - camera.bottom) / camera.zoom;
  return {height, width: camera.isPerspectiveCamera ? height * camera.aspect : (camera.right - camera.left) / camera.zoom};
}

// Fit all corners, including the near ones which grow in a perspective view.
// This only positions the camera; model coordinates and metre measurements stay fixed.
export function frameWorkspaceCamera(THREE, camera, {bounds, target, direction, coverage = .84}) {
  const axis = direction.clone().normalize();
  camera.position.copy(target).add(axis);
  camera.lookAt(target); camera.updateMatrixWorld();
  const rotation = new THREE.Matrix4().extractRotation(camera.matrixWorld).invert();
  const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z =>
    new THREE.Vector3(x ? bounds.max.x : bounds.min.x, y ? bounds.max.y : bounds.min.y,
      z ? bounds.max.z : bounds.min.z).sub(target).applyMatrix4(rotation))));
  const tanY = Math.tan(camera.fov * Math.PI / 360) / camera.zoom;
  const distance = Math.max(.5, ...corners.flatMap(point => [
    point.z + Math.abs(point.x) / (tanY * camera.aspect * coverage),
    point.z + Math.abs(point.y) / (tanY * coverage),
  ]));
  camera.position.copy(target).addScaledVector(axis, distance);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  return distance;
}
