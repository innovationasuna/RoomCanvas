// Match the shelf's 60 × 54 frame so object-fit does not add wide letterboxing.
export const THUMBNAIL_SIZE = Object.freeze({width: 240, height: 216});

// Fit a model centered at the origin to both image axes, with an 8% margin per edge.
// A sphere fit wastes space on narrow/tall furniture; perspective corner constraints keep
// every part inside the frame while bringing the camera as close as the bounds allow.
export function frameThumbnailCamera(THREE, camera, size) {
  const direction = new THREE.Vector3(1, .65, 1).normalize();
  camera.position.copy(direction);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const rotation = new THREE.Matrix4().extractRotation(camera.matrixWorld).invert();
  const corners = [-.5, .5].flatMap(x => [-.5, .5].flatMap(y => [-.5, .5].map(z =>
    new THREE.Vector3(size.x * x, size.y * y, size.z * z).applyMatrix4(rotation))));
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
  const tanX = tanY * camera.aspect, coverage = .84;
  const distance = Math.max(.01, ...corners.flatMap(p => [p.z + Math.abs(p.x) / (tanX * coverage), p.z + Math.abs(p.y) / (tanY * coverage)]));
  const margin = Math.max(size.length() * .05, .001);
  camera.position.copy(direction).multiplyScalar(distance);
  camera.near = Math.max(.001, distance - Math.max(...corners.map(p => p.z)) - margin);
  camera.far = distance - Math.min(...corners.map(p => p.z)) + margin;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
}
