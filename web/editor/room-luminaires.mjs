// The room's own ceiling luminaires, so the indoor light comes from where the real lamps are.
// Pure functions (no WebGL): which objects are luminaires, the rectangle each one emits from,
// and the spot lights that stand for them. time-lighting.mjs and physical-lighting.mjs light them.

// All luminaire constants in one place.
export const LUMINAIRE_LIGHTS = Object.freeze({
  // One spot per `spacing` metres of a luminaire's length, 1 to `perLuminaire` of them;
  // at most `max` in the room, and shadows from at most `shadows` (those with the largest share).
  spacing: 3.5, perLuminaire: 3, max: 6, shadows: 3,
  // Below the luminaire's underside, so its own housing never enters the downward shadow cone.
  drop: .02,
  // Several shadowed spots: three 1024² maps hold fewer texels than the central lamp's one 2048².
  shadowMap: 1024,
  // Time presets: the central lamp's power (one lamp lights about `referenceArea` m²) times
  // (floor area / referenceArea) ** areaExponent, so a large room is lit across its floor.
  referenceArea: 20, areaExponent: .75,
  // 物理光照: each luminaire's watts from its emitting area (a 0.6 m panel: 36 W) or, for a strip, from its
  // length (LED strip lights run at about 30 W a metre; by area a narrow strip would get a third of that
  // and leave a large room dim), whichever is more, within these bounds.
  wattsPerArea: 100, wattsPerLength: 30, minWatts: 10, maxWatts: 250,
});
export const LUMINAIRE_CATEGORIES = Object.freeze(['light', 'light_fixture', 'luminaire']);

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const nameOf = object => object.userData?.name || object.name;

// room_objects.json marks its ceiling lamps; a table lamp (`lamp`) or a wall light is not one.
export const ceilingLuminaires = objects => objects
  .filter(object => LUMINAIRE_CATEGORIES.includes(object.category) && object.mount === 'ceiling').map(object => object.node);

// The replay lights a finished room before it has an object list, so this name heuristic is the only
// other way luminaires are found (and it lives only here): a node named like a lamp that hangs under
// a ceiling node or whose top reaches the ceiling, all of it in the upper half of the room (not a
// window's daylight backdrop or a door's sidelights), and not part of a wall, window or floor.
// The first match on a path claims its subtree (a strip's housing and diffuser).
export const LUMINAIRE_NAME = /light|lamp|lumin/i;
export function namedLuminaires(THREE, root, {label = () => null, ceilingY, reach = .25}) {
  const names = [], claimed = new Set(), box = new THREE.Box3();
  // The room's own bottom: a replay's Floor0 box also holds whatever the reconstruction nested under it.
  const upperHalf = (box.setFromObject(root).min.y + ceilingY) / 2;
  root.traverse(object => {
    if (object === root) return;
    if (claimed.has(object.parent)) {claimed.add(object); return;}
    const name = nameOf(object);
    // Named like a ceiling and a lamp (the replay calls `CeilingLight0` a ceiling): a lamp.
    if (!name || !LUMINAIRE_NAME.test(name) || ![null, '天花板'].includes(label(name) ?? null)) return;
    let ceiling = false, structure = false;
    for (let parent = object.parent; parent && parent !== root; parent = parent.parent) {
      const kind = label(nameOf(parent));
      if (kind === '天花板') ceiling = true; else if (kind) structure = true;
    }
    if (structure || box.setFromObject(object).isEmpty() || box.min.y < upperHalf) return;
    if (!ceiling && box.max.y < ceilingY - reach) return;
    claimed.add(object); names.push(name);
  });
  return names;
}

// The rectangle a luminaire emits from, seen from below: the smallest rectangle around its vertices in
// the ground plane (one side lies on an edge of their convex hull), so a strip in a turned room keeps its
// length, where its axis-aligned box would be nearly square. Principal axes would not do for a square
// panel: its spread is the same in every direction. points: flat [x, y, z, ...] in world space;
// centre is the middle of the underside, axis the long side's direction [x, z].
export function fitRectangle(points) {
  if (!points.length) return null;
  let bottom = Infinity;
  const flat = [];
  for (let i = 0; i < points.length; i += 3) {bottom = Math.min(bottom, points[i + 1]); flat.push([points[i], points[i + 2]]);}
  const outline = convexHull(flat);
  let best = null;
  outline.forEach((p, i) => {
    const q = outline[(i + 1) % outline.length], edge = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (edge < 1e-9) return;
    const ax = (q[0] - p[0]) / edge, az = (q[1] - p[1]) / edge;
    let low = Infinity, high = -Infinity, left = Infinity, right = -Infinity;
    for (const [x, z] of outline) {
      const along = x * ax + z * az, across = z * ax - x * az;
      low = Math.min(low, along); high = Math.max(high, along); left = Math.min(left, across); right = Math.max(right, across);
    }
    const area = (high - low) * (right - left);
    if (!best || area < best.area - 1e-12) best = {area, ax, az, low, high, left, right};
  });
  if (!best) return null;
  const {ax, az, low, high, left, right} = best, a = (low + high) / 2, b = (left + right) / 2;
  const center = [ax * a - az * b, bottom, az * a + ax * b];
  const [length, width, axis] = high - low >= right - left ? [high - low, right - left, [ax, az]] : [right - left, high - low, [-az, ax]];
  return {center, axis, length, width, bottom, area: length * width};
}

// Andrew's monotone chain; [x, z] points, counter-clockwise, without collinear points.
function convexHull(points) {
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o, p, q) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const half = list => list.reduce((out, p) => {
    while (out.length > 1 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
    out.push(p); return out;
  }, []);
  const lower = half(sorted), upper = half(sorted.reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const emits = material => !!material?.emissive && material.emissive.r + material.emissive.g + material.emissive.b > 0 && material.emissiveIntensity > 0;
export const glowing = mesh => [mesh.material].flat().some(emits);

// The meshes that glow (a diffuser) when the luminaire has any, otherwise all of them (a downlight's rim).
export function luminaireShape(object) {
  object.updateWorldMatrix(true, true);
  const meshes = [];
  object.traverse(mesh => {if (mesh.isMesh && mesh.geometry?.attributes?.position) meshes.push(mesh);});
  const lit = meshes.filter(glowing), points = [];
  for (const mesh of lit.length ? lit : meshes) {
    const position = mesh.geometry.attributes.position, e = mesh.matrixWorld.elements;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i), z = position.getZ(i);
      points.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
  }
  const shape = fitRectangle(points);
  return shape && shape.area > 0 ? shape : null;
}

// Found by name in the room (GLTFLoader keeps a renamed node's own name in userData.name).
export function findLuminaires(room, names = []) {
  if (!names.length) return [];
  const wanted = new Set(names), found = new Map();
  room.traverse(object => {const name = nameOf(object); if (object !== room && wanted.has(name) && !found.has(name)) found.set(name, object);});
  return names.flatMap(name => {
    const object = found.get(name), shape = object && luminaireShape(object);
    return shape ? [{name, object, ...shape}] : [];
  });
}

export const luminaireWatts = (area, length = 0) => clamp(
  Math.max(area * LUMINAIRE_LIGHTS.wattsPerArea, length * LUMINAIRE_LIGHTS.wattsPerLength), LUMINAIRE_LIGHTS.minWatts, LUMINAIRE_LIGHTS.maxWatts);

// Spots straight down from each luminaire's underside, evenly along its long axis. share: the part of
// the room's emitting area a spot stands for (sums to 1); watts: its part of its luminaire's 物理光照 watts.
// Over the cap: fewer spots on the luminaires where they stand closest, then only the largest
// luminaires keep one, and each dropped one's share and watts go to the nearest kept spot.
export function planLuminaireLights(luminaires, options = {}) {
  const {spacing, perLuminaire, max, shadows, drop} = {...LUMINAIRE_LIGHTS, ...options};
  if (!luminaires.length || max <= 0) return [];
  const total = luminaires.reduce((sum, {area}) => sum + area, 0);
  const counts = luminaires.map(({length}) => clamp(Math.round(length / spacing), 1, perLuminaire));
  let sum = counts.reduce((a, b) => a + b, 0);
  // Among equally dense ones, the luminaire nearest the middle loses a spot first: equal strips in a row
  // keep a symmetric plan, and the outer ones keep lighting the room's edges.
  const middle = [0, 2].map(k => luminaires.reduce((s, {center}) => s + center[k], 0) / luminaires.length);
  const offCentre = luminaires.map(({center}) => Math.hypot(center[0] - middle[0], center[2] - middle[1]));
  while (sum > max) {
    let best = -1;
    counts.forEach((n, i) => {
      if (n <= 1) return;
      const gap = luminaires[i].length / n, bestGap = best < 0 ? Infinity : luminaires[best].length / counts[best];
      if (gap < bestGap - 1e-6 || (gap < bestGap + 1e-6 && offCentre[i] < offCentre[best] - 1e-3)) best = i;
    });
    if (best < 0) break;
    counts[best]--; sum--;
  }
  const order = luminaires.map((_, i) => i).sort((a, b) => luminaires[b].area - luminaires[a].area || a - b);
  const kept = new Set(order.slice(0, max));
  const lights = [];
  luminaires.forEach((luminaire, i) => {
    if (!kept.has(i)) return;
    const n = counts[i], {center, axis, length, bottom, area, name} = luminaire;
    for (let k = 0; k < n; k++) {
      const offset = ((k + .5) / n - .5) * length;
      lights.push({luminaire: name, position: [center[0] + axis[0] * offset, bottom - drop, center[2] + axis[1] * offset],
        share: area / total / n, watts: luminaireWatts(area, length) / n, folded: []});
    }
  });
  luminaires.forEach((luminaire, i) => {
    if (kept.has(i)) return;
    const distance = light => Math.hypot(light.position[0] - luminaire.center[0], light.position[1] - luminaire.bottom, light.position[2] - luminaire.center[2]);
    const nearest = lights.reduce((best, light) => distance(light) < distance(best) ? light : best);
    nearest.share += luminaire.area / total; nearest.watts += luminaireWatts(luminaire.area, luminaire.length); nearest.folded.push(luminaire.name);
  });
  // Shadows from the largest shares; among equal ones, those nearest the middle of all the spots.
  const mid = [0, 2].map(k => lights.reduce((s, {position}) => s + position[k], 0) / lights.length);
  const away = ({position}) => Math.hypot(position[0] - mid[0], position[2] - mid[1]);
  const rank = (a, b) => (Math.abs(lights[b].share - lights[a].share) > 1e-9 ? lights[b].share - lights[a].share : 0)
    || (Math.abs(away(lights[a]) - away(lights[b])) > 1e-3 ? away(lights[a]) - away(lights[b]) : 0) || a - b;
  const shadowed = new Set(lights.map((_, i) => i).sort(rank).slice(0, shadows));
  return lights.map((light, i) => ({...light, castShadow: shadowed.has(i)}));
}

// The floor enclosed by the walls' inner faces: a shoelace sum over their segments, each taken with the
// room on the same side (its inward normal), so their order does not matter. Bounded by the room box's
// footprint, which is also the answer when the walls do not enclose anything.
// walls: [{n, d, tangent, bounds: [[u0, y0], [u1, y1]]}] as placement.wallTargets() gives them.
export function floorArea(walls, boxArea) {
  const segments = walls.filter(wall => Number.isFinite(wall.d) && wall.tangent && wall.bounds).map(({n, d, tangent, bounds}) =>
    [bounds[0][0], bounds[1][0]].map(u => [n[0] * d + tangent[0] * u, n[2] * d + tangent[2] * u]));
  if (segments.length < 3) return boxArea;
  const points = segments.flat(), ox = points.reduce((s, p) => s + p[0], 0) / points.length, oz = points.reduce((s, p) => s + p[1], 0) / points.length;
  const twice = segments.reduce((sum, [a, b]) => sum + (a[0] - ox) * (b[1] - oz) - (b[0] - ox) * (a[1] - oz), 0);
  const area = Math.abs(twice) / 2;
  return area > 1 ? Math.min(area, boxArea) : boxArea;
}

// The time presets' total lamp power for a lit room: the central lamp's, scaled with the floor area.
export const areaFactor = area => Math.max(1, area / LUMINAIRE_LIGHTS.referenceArea) ** LUMINAIRE_LIGHTS.areaExponent;

// A wider cone spreads shadow texels over more world space; scale the normal bias to keep
// grazing-angle acne controlled without adding a second shadow map. `height`: lamp above the floor.
export function spotShadowBias(height, halfAngle, mapSize) {
  const tan = Math.tan(halfAngle), texel = 2 * height * tan / mapSize;
  return {normalBias: clamp(texel * .5, .004, .025), bias: -clamp(tan / mapSize * .43, .00015, .0016)};
}
