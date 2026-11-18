import {openValue} from './joints.mjs';

// Loaded only by the explicit lightingLab acceptance API.
export function benchmarkQueries(THREE, {room, queries, solid, floorY, hinged, rounds = 5}) {
  const ray = new THREE.Raycaster(), bounds = new THREE.Box3().setFromObject(room), cases = [];
  const center = bounds.getCenter(new THREE.Vector3());
  for (const x of [.2, .5, .8]) for (const z of [.2, .5, .8]) {
    const origin = new THREE.Vector3(bounds.min.x + x * (bounds.max.x - bounds.min.x), floorY + .9, bounds.min.z + z * (bounds.max.z - bounds.min.z));
    for (const direction of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [1, 0, 1]]) cases.push([origin, new THREE.Vector3(...direction).normalize()]);
  }
  const measure = (inputs) => {
    queries.refresh();
    const reference = [], indexed = [];
    let mismatches = 0;
    for (let round = 0; round < rounds; round++) {
      const expected = [], actual = [];
      let start = performance.now();
      for (const [origin, direction] of inputs) {ray.set(origin, direction); expected.push(ray.intersectObject(room, true).find(solid));}
      reference.push(performance.now() - start);
      start = performance.now();
      for (const [origin, direction] of inputs) actual.push(queries.nearest(origin, direction, Infinity, solid));
      indexed.push(performance.now() - start);
      expected.forEach((hit, i) => {
        const other = actual[i];
        // Coincident surfaces may legally return different triangles at the same point.
        if (!!hit !== !!other || hit && Math.abs(hit.distance - other.distance) > 1e-5) mismatches++;
      });
    }
    return {rays: inputs.length, referenceMs: reference, indexedMs: indexed, mismatches};
  };
  const baseline = measure(cases), values = hinged.parts.map((part) => part.value);
  let articulated;
  try {
    for (const part of hinged.parts) hinged.set(part, openValue(part.joint));
    room.updateMatrixWorld(true);
    const parts = hinged.parts.flatMap((part) => {
      const target = new THREE.Box3().setFromObject(part.node).getCenter(new THREE.Vector3());
      const direction = target.clone().sub(center).normalize();
      return [[target.clone().addScaledVector(direction, 2), direction.clone().negate()], [target.clone().add(new THREE.Vector3(0, 2, 0)), new THREE.Vector3(0, -1, 0)]];
    });
    articulated = measure([...cases, ...parts]);
  } finally {
    hinged.parts.forEach((part, i) => hinged.set(part, values[i]));
    queries.refresh();
  }
  return {baseline, articulated, parts: hinged.parts.length, audit: {...queries.audit}};
}
