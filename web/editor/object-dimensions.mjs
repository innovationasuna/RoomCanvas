// Measurement labels use ViewForge's Z-up convention in the editor's Y-up display frame.
export const DIMENSION_AXES = [
  {axis: 'X', label: 'X（宽）', direction: [1, 0, 0], component: 0, color: '#c64745'},
  {axis: 'Y', label: 'Y（深）', direction: [0, 0, -1], component: 2, color: '#25854c'},
  {axis: 'Z', label: 'Z（高）', direction: [0, 1, 0], component: 1, color: '#326cc7'},
];

export function createDimensionGuides(THREE, box) {
  const root = new THREE.Group(), tips = new Map(), arrows = new Map();
  const size = box.getSize(new THREE.Vector3()), span = Math.max(size.x, size.y, size.z);
  const origin = new THREE.Vector3(box.min.x - span * .06, box.min.y, box.max.z + span * .06);
  for (const spec of DIMENSION_AXES) {
    const direction = new THREE.Vector3(...spec.direction), length = Math.max(size.getComponent(spec.component), span * .15);
    const arrow = new THREE.ArrowHelper(direction, origin, length, spec.color, span * .08, span * .045);
    arrow.traverse(object => {
      object.renderOrder = 10;
      if (object.material) {object.material.depthTest = false; object.material.depthWrite = false; object.material.transparent = true;}
    });
    root.add(arrow); arrows.set(spec.axis, arrow);
    tips.set(spec.axis, origin.clone().addScaledVector(direction, length + span * .06));
  }
  return {root, tips, select(axis) {
    for (const [name, arrow] of arrows) arrow.traverse(object => {if (object.material) object.material.opacity = name === axis ? 1 : .55;});
  }};
}

// A model can share geometry/materials with its own contact clone. Dispose each resource once.
export function disposeObjectTree(root) {
  const resources = new Set();
  root.traverse(object => {
    if (object.geometry) resources.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) {
      resources.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}
