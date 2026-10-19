// Geometric contact checks, not a rigid-body / load-bearing simulation.
// Plain numeric functions keep wall holes and support-edge checks testable without WebGL.
const EPS = 1e-6;
export const CONTACT = .012;
export const SNAP = .035;
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const yawWrap = (yaw) => Math.atan2(Math.sin(yaw), Math.cos(yaw));

export function inTriangle(point, triangle, tolerance = EPS) {
  const [a, b, c] = triangle;
  const area = cross(a, b, c);
  if (Math.abs(area) < 1e-12) return false;
  const u = cross(a, b, point) / area, v = cross(b, c, point) / area, w = cross(c, a, point) / area;
  return u >= -tolerance && v >= -tolerance && w >= -tolerance;
}

export function convexHull(points) {
  const sorted = [...new Map(points.map((p) => [p.map((v) => v.toFixed(5)).join(','), p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const half = (list) => {
    const result = [];
    for (const p of list) {while (result.length >= 2 && cross(result.at(-2), result.at(-1), p) <= 0) result.pop(); result.push(p);}
    return result;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

export function sampleHull(hull, spacing = .09) {
  if (!hull.length) return [];
  const points = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const steps = Math.max(1, Math.min(64, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / spacing)));
    for (let s = 0; s < steps; s++) points.push([a[0] + (b[0] - a[0]) * s / steps, a[1] + (b[1] - a[1]) * s / steps]);
  }
  const center = [0, 1].map((axis) => hull.reduce((sum, p) => sum + p[axis], 0) / hull.length);
  points.push(center);
  // Interior spokes prevent accepting a mounting/support patch with a large central hole.
  for (const corner of hull) {
    const steps = Math.max(2, Math.min(32, Math.ceil(Math.hypot(corner[0] - center[0], corner[1] - center[1]) / spacing)));
    for (let i = 1; i < steps; i++) points.push([center[0] + (corner[0] - center[0]) * i / steps, center[1] + (corner[1] - center[1]) * i / steps]);
  }
  return points;
}

// Clip each real face to a shallow band at the lowest part of the object. Sampling
// those faces separately keeps the space between legs, skids and casters empty.
// A single hull would invent contact across those gaps and hit a cabinet under a
// desk even when none of the desk's feet touch that cabinet.
export function sampleContactGeometry(triangles, bottom, band = .025, spacing = .045) {
  const unique = new Map(), ceiling = bottom + band;
  const add = (p) => unique.set(p.map((v) => v.toFixed(5)).join(','), p);
  for (const triangle of triangles) {
    if (triangle.every((p) => p[1] > ceiling + EPS)) continue;
    const clipped = [];
    for (let i = 0; i < triangle.length; i++) {
      const a = triangle[i], b = triangle[(i + 1) % triangle.length];
      const insideA = a[1] <= ceiling + EPS, insideB = b[1] <= ceiling + EPS;
      if (insideA) clipped.push(a);
      if (insideA !== insideB) {
        const t = (ceiling - a[1]) / (b[1] - a[1]);
        clipped.push(a.map((v, axis) => v + (b[axis] - v) * t));
      }
    }
    if (!clipped.length) continue;
    const polygon = clipped.map((p) => [p[0], p[2]]);
    polygon.forEach(add);
    for (let i = 1; i + 1 < polygon.length; i++) {
      const a = polygon[0], b = polygon[i], c = polygon[i + 1];
      const edge = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]),
        Math.hypot(a[0] - c[0], a[1] - c[1]), Math.hypot(b[0] - c[0], b[1] - c[1]));
      const steps = Math.max(1, Math.min(64, Math.ceil(edge / spacing)));
      for (let u = 0; u <= steps; u++) for (let v = 0; v <= steps - u; v++) {
        add([a[0] + (b[0] - a[0]) * u / steps + (c[0] - a[0]) * v / steps,
          a[1] + (b[1] - a[1]) * u / steps + (c[1] - a[1]) * v / steps]);
      }
    }
  }
  return [...unique.values()];
}

// Triangles of a support surface binned on a grid, built once per triangle list. Each triangle
// goes into every cell its bounds touch, widened by inTriangle's tolerance, so a point is only
// tested against triangles that could contain it and the answer stays exactly the same.
const grids = new WeakMap();
function triangleGrid(triangles) {
  if (!grids.has(triangles)) {
    const boxes = triangles.map((t) => {
      const xs = t.map((p) => p[0]), zs = t.map((p) => p[1]);
      const box = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
      const margin = 4 * EPS * Math.max(box[2] - box[0], box[3] - box[1]) + 1e-12;
      return [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
    });
    const low = [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1]))];
    const high = [Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
    const n = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(triangles.length))));
    const size = [(high[0] - low[0]) / n || 1, (high[1] - low[1]) / n || 1];
    const cell = (v, axis) => Math.min(n - 1, Math.max(0, Math.floor((v - low[axis]) / size[axis])));
    const cells = new Map();
    boxes.forEach((b, i) => {
      for (let x = cell(b[0], 0); x <= cell(b[2], 0); x++) for (let z = cell(b[1], 1); z <= cell(b[3], 1); z++) {
        const key = x * n + z;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(triangles[i]);
      }
    });
    grids.set(triangles, (p) => p[0] < low[0] || p[1] < low[1] || p[0] > high[0] || p[1] > high[1] ? [] : cells.get(cell(p[0], 0) * n + cell(p[1], 1)) || []);
  }
  return grids.get(triangles);
}

export function coverage(points, triangles) {
  let covered = 0;
  const near = triangles.length > 16 ? triangleGrid(triangles) : () => triangles;
  for (const point of points) if (near(point).some((triangle) => inTriangle(point, triangle))) covered++;
  return {covered, total: points.length, full: points.length > 0 && covered === points.length};
}

export function polygonsOverlap(a, b) {
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length];
    const axis = [q[1] - p[1], p[0] - q[0]];
    const pa = a.map((v) => dot(axis, v)), pb = b.map((v) => dot(axis, v));
    if (Math.max(...pa) <= Math.min(...pb) + EPS || Math.max(...pb) <= Math.min(...pa) + EPS) return false;
  }
  return a.length >= 3 && b.length >= 3;
}

export function transformPoint(point, origin, pose) {
  const x = point[0] - origin[0], z = point[2] - origin[2];
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return [origin[0] + pose.x + c * x + s * z, point[1] + (pose.y || 0), origin[2] + pose.z - s * x + c * z];
}

function inversePoint(point, origin, pose) {
  const x = point[0] - origin[0] - pose.x, z = point[2] - origin[2] - pose.z;
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return [origin[0] + c * x - s * z, point[1] - (pose.y || 0), origin[2] + s * x + c * z];
}

export function carryPose(child, childOrigin, oldParent, nextParent, parentOrigin) {
  const angle = nextParent.yaw - oldParent.yaw, c = Math.cos(angle), s = Math.sin(angle);
  const x = childOrigin[0] + child.x - parentOrigin[0] - oldParent.x;
  const z = childOrigin[2] + child.z - parentOrigin[2] - oldParent.z;
  return {...child, x: parentOrigin[0] + nextParent.x + c * x + s * z - childOrigin[0],
    y: (child.y || 0) + (nextParent.y || 0) - (oldParent.y || 0),
    z: parentOrigin[2] + nextParent.z - s * x + c * z - childOrigin[2], yaw: yawWrap(child.yaw + angle)};
}

export function mountedNormal(normal, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * normal[0] + s * normal[2], 0, -s * normal[0] + c * normal[2]];
}

// Place the center of the authored mounting patch at a clicked wall point. The
// back normal follows the new wall; rotation is around the existing entity origin.
export function mountPose(back, origin, wall, point, gap = .003) {
  const yaw = yawWrap(Math.atan2(back.n[2], back.n[0]) - Math.atan2(wall.n[2], wall.n[0]));
  const turned = transformPoint(back.center, origin, {x: 0, y: 0, z: 0, yaw});
  const distance = dot(wall.n, point) - wall.d - gap;
  return {x: point[0] - wall.n[0] * distance - turned[0], y: point[1] - turned[1],
    z: point[2] - wall.n[2] * distance - turned[2], yaw};
}

// Attachment is derived entirely from the saved transform. No transient wall ID
// is needed, so undo, refresh and v2 JSON imports recover the same target wall.
export function resolveMountedWall(back, origin, pose, walls) {
  const normal = mountedNormal(back.n, pose.yaw);
  const center = transformPoint(back.center, origin, pose);
  let best = null;
  for (const wall of walls) {
    const alignment = dot(normal, wall.n);
    if (alignment < .9999) continue;
    const gap = dot(wall.n, center) - wall.d;
    const u = dot(wall.tangent, center);
    const outside = Math.max(wall.bounds[0][0] - u, 0, u - wall.bounds[1][0]);
    const score = Math.abs(gap) + outside;
    if (!best || score < best.score) best = {wall, gap, score};
  }
  return best;
}

// Find the first room boundary in a camera-relative horizontal direction. Test
// finite wall envelopes, not triangles: a door/window is still that boundary and
// must fail mount() rather than letting the ray skip to a wall behind the opening.
export function nearestWallAlongRay(origin, axis, walls, currentWallName) {
  const x = Array.isArray(axis) ? axis[0] : axis?.x;
  const z = Array.isArray(axis) ? axis[2] : axis?.z;
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every(Number.isFinite) || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const length = Math.hypot(x, z);
  if (length < EPS) return null;
  const direction = [x / length, 0, z / length];
  const current = walls.find((wall) => wall.name === currentWallName);
  // Skipping the source face alone would let an outward ray leave the room and
  // accidentally choose another wall in a concave corner. Reject that heading.
  if (current && dot(direction, current.n) < -EPS) return null;
  let nearest = null;
  for (const wall of walls) {
    if (wall.name === currentWallName) continue;
    const facing = dot(direction, wall.n);
    if (facing >= -EPS) continue;
    const distance = (wall.d - dot(wall.n, origin)) / facing;
    if (distance <= EPS) continue;
    const point = origin.map((v, i) => v + direction[i] * distance);
    const u = dot(wall.tangent, point);
    if (u < wall.bounds[0][0] - EPS || u > wall.bounds[1][0] + EPS || point[1] < wall.bounds[0][1] - EPS || point[1] > wall.bounds[1][1] + EPS) continue;
    if (!nearest || distance < nearest.distance - EPS || (Math.abs(distance - nearest.distance) <= EPS && facing < nearest.facing)) nearest = {name: wall.name, point, distance, facing};
  }
  if (!nearest) return null;
  const {name, point, distance} = nearest;
  return {name, point, distance};
}

function triangleNormal([a, b, c]) {
  const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n);
  return {n: n.map((value) => value / (length || 1)), area: length / 2};
}

// Vertical samples of the real seat mesh. The grid only narrows the triangle
// search; it never fills holes or turns an empty chair volume into a solid box.
function meshSupport(triangles) {
  const grid = new Map(), cell = .06;
  for (const triangle of triangles) {
    const low = [0, 2].map(axis => Math.floor(Math.min(...triangle.map(p => p[axis])) / cell));
    const high = [0, 2].map(axis => Math.floor(Math.max(...triangle.map(p => p[axis])) / cell));
    for (let x = low[0]; x <= high[0]; x++) for (let z = low[1]; z <= high[1]; z++) {
      const key = `${x}:${z}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({triangle, projected: triangle.map(p => [p[0], p[2]])});
    }
  }
  return (point) => {
    let height = -Infinity;
    for (const {triangle: [a, b, c], projected} of grid.get(`${Math.floor(point[0]/cell)}:${Math.floor(point[1]/cell)}`) || []) {
      if (!inTriangle(point, projected)) continue;
      const denominator = cross(projected[0], projected[1], projected[2]);
      const u = cross(point, projected[1], projected[2]) / denominator;
      const v = cross(projected[0], point, projected[2]) / denominator;
      height = Math.max(height, u*a[1] + v*b[1] + (1-u-v)*c[1]);
    }
    return height;
  };
}

// THREE is injected so the numeric module has no CDN or node_modules dependency.
// The seat of a chair, as seen from above: on a 2 cm grid over the chair, the highest
// horizontal face 25-80 cm above the floor; the seat is the 6 cm height window that most
// of those points fall in. The seat's underside and base are hidden below it, arms and
// backs cover little. Returns [low, high] above the floor, or null.
export function seatBand(triangles, floorY, {from = .25, to = .8, window = .06, cell = .02, minCells = 25} = {}) {
  const flat = triangles.filter((triangle) => {
    const {n, area} = triangleNormal(triangle);
    const heights = triangle.map((p) => p[1] - floorY);
    return Math.abs(n[1]) >= .92 && area >= 1e-8 && Math.min(...heights) >= from && Math.max(...heights) <= to;
  }).map((triangle) => ({flat: triangle.map((p) => [p[0], p[2]]), y: triangle.reduce((sum, p) => sum + p[1], 0) / 3 - floorY,
    box: [0, 2].map((k) => [Math.min(...triangle.map((p) => p[k])), Math.max(...triangle.map((p) => p[k]))])}));
  if (!flat.length) return null;
  const [xs, zs] = [0, 1].map((k) => [Math.min(...flat.map((t) => t.box[k][0])), Math.max(...flat.map((t) => t.box[k][1]))]);
  const counts = new Map();
  for (let x = xs[0] + cell / 2; x < xs[1]; x += cell) for (let z = zs[0] + cell / 2; z < zs[1]; z += cell) {
    let top = -Infinity;
    for (const t of flat) {
      if (t.y > top && x >= t.box[0][0] && x <= t.box[0][1] && z >= t.box[1][0] && z <= t.box[1][1] && inTriangle([x, z], t.flat)) top = t.y;
    }
    if (top > -Infinity) counts.set(Math.round(top * 100), (counts.get(Math.round(top * 100)) || 0) + 1);
  }
  let best = null;
  for (let start = Math.round(from * 100); start + window * 100 <= Math.round(to * 100); start++) {
    let count = 0;
    for (let bin = start; bin < start + window * 100; bin++) count += counts.get(bin) || 0;
    if (!best || count > best.count) best = {start, count};
  }
  if (best.count < minCells) return null;
  return [best.start / 100 - .03, best.start / 100 + window + .03];
}

export function createPlacement(THREE, room, entities, specs, floorY, ceilingY, {openings: openingsByWall = {}} = {}) {
  room.updateMatrixWorld(true);
  const byName = new Map();
  room.traverse((object) => {byName.set(object.userData.name || object.name, object);});
  const meshCache = new Map();
  function geometry(names) {
    const vertices = [], triangles = [], seen = new Set();
    for (const name of names) {
      const root = byName.get(name);
      if (!root) throw new Error(`缺少放置几何：${name}`);
      root.traverse((mesh) => {
        if (!mesh.isMesh || seen.has(mesh)) return;
        seen.add(mesh);
        if (!meshCache.has(mesh)) {
          const positions = mesh.geometry.attributes.position;
          const localVertices = Array.from({length: positions.count}, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).toArray());
          const index = mesh.geometry.index;
          const count = index ? index.count : positions.count;
          const faces = [];
          for (let i = 0; i < count; i += 3) faces.push([0, 1, 2].map((k) => localVertices[index ? index.getX(i + k) : i + k]));
          meshCache.set(mesh, {vertices: localVertices, triangles: faces});
        }
        const data = meshCache.get(mesh);
        for (const v of data.vertices) vertices.push(v);
        for (const t of data.triangles) triangles.push(t);
      });
    }
    return {vertices, triangles};
  }
  const surfaces = [];
  function addSurfaces(owner, names, label) {
    for (const name of names) {
      const flat = geometry([name]).triangles.filter((triangle) => {
        const {n, area} = triangleNormal(triangle);
        return Math.abs(n[1]) >= .995 && area >= 1e-8 && Math.max(...triangle.map((p) => p[1])) - Math.min(...triangle.map((p) => p[1])) < .003;
      });
      // Authored shelves/cabinet have reversed winding. Use the highest physical face,
      // not the normal sign, and never confuse a shelf's underside with its top.
      const y = flat.reduce((height, triangle) => Math.max(height, triangle.reduce((sum, p) => sum + p[1], 0) / 3), -Infinity);
      const triangles = flat.filter((triangle) => triangle.every((p) => Math.abs(p[1] - y) < .003)).map((triangle) => triangle.map((p) => [p[0], p[2]]));
      if (!triangles.length) throw new Error(`没有可用水平支撑面：${name}`);
      surfaces.push({id: `${owner || 'floor'}:${name}`, owner, y, label, triangles});
    }
  }
  addSurfaces(null, ['Floor0'], '地面');
  for (const [id, spec] of Object.entries(specs)) if (spec.surfaces) addSurfaces(id, spec.surfaces, entities.get(id).name);
  const seats = {};
  for (const [id, spec] of Object.entries(specs)) if (spec.seat) {
    const originY = entities.get(id).origin.toArray()[1];
    const range = spec.seat === 'auto' ? seatBand(geometry(spec.body).triangles, originY) : spec.seat.range;
    if (!range) continue;  // e.g. a stool scanned as a closed block
    seats[id] = range.map((y) => +y.toFixed(2));
    const [low, high] = range.map(y => y + originY);
    const triangles = geometry(spec.body).triangles.filter(triangle => {
      const {n, area} = triangleNormal(triangle);
      return Math.abs(n[1]) >= .92 && area >= 1e-8 && triangle.every(p => p[1] >= low && p[1] <= high);
    });
    if (!triangles.length) throw new Error(`没有可用椅面：${id}`);
    surfaces.push({id: `${id}:seat`, owner: id, label: `${entities.get(id).name} · 椅面`,
      minY: Math.min(...triangles.flat().map(p => p[1])), heightAt: meshSupport(triangles)});
  }

  const walls = [];
  const floorVertices = geometry(['Floor0']).vertices;
  const floorCenter = floorVertices.reduce((out, p) => out.map((v, i) => v + p[i] / floorVertices.length), [0, 0, 0]);
  for (const object of room.children.filter((root) => /^Wall\d+$/.test(root.userData.name || root.name))) {
    const name = object.userData.name || object.name, groups = [];
    for (const triangle of geometry([name]).triangles) {
      let {n, area} = triangleNormal(triangle);
      if (Math.abs(n[1]) > .01 || area < 1e-6) continue;
      n = [n[0], 0, n[2]];
      const length = Math.hypot(...n); n = n.map((v) => v / length);
      const d = dot(n, triangle[0]);
      // Floating-point winding differences at a window must not split one face.
      let group = groups.find((face) => dot(face.n, n) > .999999 && Math.abs(face.d - d) < .001);
      if (!group) {group = {name, n, d, area: 0, triangles: []}; groups.push(group);}
      group.area += area; group.triangles.push(triangle);
    }
    const dominant = groups.reduce((best, face) => !best || face.area > best.area ? face : best, null);
    if (!dominant) continue;
    // A wall solid has two large parallel faces and thin end caps. Keep only its
    // room-facing large face, never the outer skin or a door/window reveal.
    const sign = dot(dominant.n, floorCenter) >= dominant.d ? 1 : -1;
    const inward = dominant.n.map((v) => v * sign);
    const parallel = groups.filter((face) => Math.abs(dot(face.n, inward)) > .9999).map((face) => {
      const side = dot(face.n, inward) > 0 ? 1 : -1;
      return {...face, n: face.n.map((v) => v * side), d: face.d * side};
    });
    const face = parallel.reduce((best, candidate) => !best || candidate.d > best.d ? candidate : best, null);
    const tangent = [-face.n[2], 0, face.n[0]];
    const triangles2d = face.triangles.map((triangle) => triangle.map((p) => [dot(tangent, p), p[1]]));
    const points = triangles2d.flat();
    const bounds = [0, 1].map((bound) => [0, 1].map((axis) => Math[bound ? 'max' : 'min'](...points.map((p) => p[axis]))));
    const openingNames = openingsByWall[name] || [];
    const openings = openingNames.map((opening) => convexHull(geometry([opening]).vertices.map((p) => [dot(tangent, p), p[1]])));
    const u = (bounds[0][0] + bounds[1][0]) / 2;
    walls.push({...face, tangent, triangles2d, bounds, openings,
      center: [tangent[0] * u + face.n[0] * face.d, (bounds[0][1] + bounds[1][1]) / 2, tangent[2] * u + face.n[2] * face.d]});
  }

  const bodies = new Map();
  for (const [id, spec] of Object.entries(specs)) {
    const {vertices, triangles} = geometry(spec.body);
    const bottom = vertices.reduce((a, p) => Math.min(a, p[1]), Infinity);
    // Ceiling clearance includes the desk monitor, ornaments and other grouped parts.
    const groupBounds = new THREE.Box3().setFromObject(entities.get(id).group);
    const top = groupBounds.max.y;
    const base = spec.wall ? [] : sampleContactGeometry(triangles, bottom);
    const body = {id, origin: entities.get(id).origin.toArray(), bottom, mountBottom: groupBounds.min.y, top, base, vertices, wall: null};
    if (spec.wall) {
      let best = null;
      // The original attachment defines the object's back; future attachments are
      // inferred from its transformed back normal and patch, not a fixed wall ID.
      for (const face of walls) {
        const distances = vertices.map((p) => dot(face.n, p) - face.d);
        const gap = Math.min(...distances);
        if (gap < -.10 || gap > .35) continue;
        const points = sampleHull(convexHull(vertices.map((p) => [dot(face.tangent, p), p[1]])));
        const cover = coverage(points, face.triangles2d);
        const score = Math.abs(gap) + (1 - cover.covered / cover.total) * 2;
        if (!best || score < best.score) best = {...face, points, gap, score};
      }
      body.wall = best;
      if (!best) throw new Error(`无法识别${entities.get(id).name}的安装墙面`);
      const low = [0, 1].map((i) => Math.min(...best.points.map((p) => p[i])));
      const high = [0, 1].map((i) => Math.max(...best.points.map((p) => p[i])));
      const u = (low[0] + high[0]) / 2, depth = best.d + best.gap;
      body.back = {n: best.n, center: [best.tangent[0] * u + best.n[0] * depth,
        (low[1] + high[1]) / 2, best.tangent[2] * u + best.n[2] * depth],
        points: best.points.map(([t, y]) => [best.tangent[0] * t + best.n[0] * depth, y, best.tangent[2] * t + best.n[2] * depth])};

    }
    bodies.set(id, body);
  }
  meshCache.clear();

  const worldBase = (body, pose) => body.base.map(([x, z]) => transformPoint([x, body.bottom, z], body.origin, pose));
  function levels(id, layout, maxHeight) {
    const body = bodies.get(id), points = worldBase(body, layout[id]);
    return surfaces.filter((surface) => surface.owner !== id && (!surface.owner || layout[surface.owner]?.visible !== false)).map((surface) => {
      const offset = surface.owner ? (layout[surface.owner].y || 0) : 0;
      if ((surface.minY ?? surface.y) + offset > maxHeight + CONTACT) return null;
      const projected = points.map((point) => {
        const p = surface.owner ? inversePoint(point, bodies.get(surface.owner).origin, layout[surface.owner]) : point;
        return [p[0], p[2]];
      });
      if (surface.heightAt) {
        const heights = projected.map(surface.heightAt).filter(Number.isFinite);
        if (!heights.length) return null;
        const y = Math.max(...heights) + offset;
        if (y > maxHeight + CONTACT) return null;
        return {...surface, y, covered: heights.length, total: points.length,
          full: heights.length === points.length && Math.max(...heights) - Math.min(...heights) <= CONTACT};
      }
      const hit = coverage(projected, surface.triangles);
      return {...surface, y: surface.y + offset, ...hit};
    }).filter((s) => s && s.covered).sort((a, b) => b.y - a.y);
  }

  function currentWall(body, pose) {return resolveMountedWall(body.back, body.origin, pose, walls);}
  function wallPatch(body, pose, wall) {
    return body.back.points.map((point) => {
      const world = transformPoint(point, body.origin, pose);
      return [dot(wall.tangent, world), world[1]];
    });
  }
  function wallState(id, layout) {
    const body = bodies.get(id), pose = layout[id], attachment = currentWall(body, pose);
    if (!attachment) return {state: 'draft', label: '朝向未贴合墙面', detail: '请使用点选换墙，重新选择安装墙面'};
    const {wall, gap} = attachment;
    const points = wallPatch(body, pose, wall);
    const result = coverage(points, wall.triangles2d);
    const overlapsOpening = wall.openings.some((opening) => polygonsOverlap(convexHull(points), opening));
    const width = Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]));
    let reason = null;
    if (body.mountBottom + (pose.y || 0) < floorY - CONTACT || body.top + (pose.y || 0) > ceilingY + CONTACT) reason = '安装位置超出地面或天花板，请调整高度';
    else if (width > wall.bounds[1][0] - wall.bounds[0][0] + EPS) reason = '该墙面宽度不足，无法完整容纳此物体';
    else if (overlapsOpening) reason = '安装范围覆盖门窗，请选择实体墙面';
    else if (!result.full) reason = '安装范围超出墙边或覆盖开口，请选择完整的实体墙面';
    if (reason) return {state: 'blocked', label: '安装范围超出墙面', detail: reason, wall: wall.name, gap};
    // Existing authoring may include thin mounting brackets or a small original inset.
    if (Math.abs(gap) > .04) return {state: 'draft', label: '等待贴合墙面', detail: '点击贴合墙面，保持背面靠墙', wall: wall.name, gap};
    return {state: 'stable', label: '已贴合墙面', detail: '上下左右沿墙移动，前后按当前视角换墙', wall: wall.name, gap};
  }

  function mount(id, layout, wallName, worldPoint) {
    const body = bodies.get(id), wall = walls.find((face) => face.name === wallName);
    const point = Array.isArray(worldPoint) ? worldPoint : worldPoint?.toArray?.();
    if (!body?.wall || !wall || !point || point.length !== 3 || !point.every(Number.isFinite)) return {ok: false, message: '请选择有效的房间墙面'};
    // A ray hit can lie on a reveal or the wall's outside skin. Its projection must
    // still be a real patch of the inner wall and must accommodate the whole mount.
    const pose = mountPose(body.back, body.origin, wall, point);
    const candidate = {...layout, [id]: pose}, status = wallState(id, candidate);
    if (status.state !== 'stable' || status.wall !== wall.name) return {ok: false, message: status.detail || '该墙面无法容纳此物体'};
    layout[id] = pose;
    return {ok: true, wall: wall.name};
  }

  function assess(id, layout, ancestors = new Set()) {
    if (ancestors.has(id)) return {state: 'blocked', label: '支撑关系循环', detail: '请将其中一件物体落到地面'};
    const body = bodies.get(id), pose = layout[id];
    if (body.wall) return wallState(id, layout);
    const bottom = body.bottom + (pose.y || 0);
    if (bottom < floorY - CONTACT || body.top + (pose.y || 0) > ceilingY + CONTACT) return {state: 'blocked', label: '超出房间高度', detail: '请调整到地面与天花板之间'};
    const candidates = levels(id, layout, bottom);
    const contact = candidates.find((surface) => surface.full && Math.abs(surface.y - bottom) <= CONTACT);
    if (contact) {
      if (contact.owner) {
        const path = new Set(ancestors); path.add(id);
        if (assess(contact.owner, layout, path).state !== 'stable') return {state: 'draft', label: '支撑物尚未落稳', detail: `请先安放${entities.get(contact.owner).name}`, support: contact.owner};
      }
      return {state: 'stable', label: `已放稳 · ${contact.label}`, detail: '底部支撑点检查通过，移动支撑物时会一起随动', support: contact.owner, surface: contact.id, height: contact.y};
    }
    const first = candidates[0];
    if (first && !first.full && Math.abs(first.y - bottom) <= CONTACT) return {state: 'draft', label: '支撑边缘不足', detail: '请向支撑面内侧移动，避免部分底座悬空'};
    return {state: 'draft', label: '已抬起 · 等待落位', detail: first ? '移动到目标上方，再点击落到支撑面' : '下方没有完整支撑面，请移回房间或台面范围'};
  }

  function descend(id, layout, maxHeight, explicit = false) {
    const body = bodies.get(id), bottom = body.bottom + (layout[id].y || 0);
    const surface = levels(id, layout, maxHeight)[0];
    if (!surface) return {ok: false, message: '下方没有可用支撑面，请移回房间或台面范围'};
    if (!surface.full) return {ok: false, surface, message: '底部超出支撑面边缘，请向内侧移动后再落位'};
    if (surface.owner && assess(surface.owner, layout).state !== 'stable') return {ok: false, message: '支撑物还没有放稳，请先安放支撑物'};
    if (body.top + surface.y - body.bottom > ceilingY + CONTACT) return {ok: false, message: '落位后会超出天花板高度'};
    if (explicit || Math.abs(surface.y - bottom) <= SNAP || surface.y > bottom) {
      layout[id].y = surface.y - body.bottom;
      return {ok: true, surface};
    }
    return {ok: true};
  }

  function constrain(id, before, next, direction) {
    const body = bodies.get(id);
    if (body.wall) {
      const attachment = currentWall(body, before[id]);
      if (!attachment) return {ok: false, message: '请先使用点选换墙，选择安装墙面'};
      const {wall} = attachment;
      // Normal nudging stays on the current wall. Relocation uses mount() instead
      // of switching silently when a step approaches another parallel segment.
      next[id].yaw = before[id].yaw;
      const center = transformPoint(body.back.center, body.origin, next[id]);
      const normalOffset = dot(wall.n, center) - wall.d - .003;
      next[id].x -= wall.n[0] * normalOffset;
      next[id].z -= wall.n[2] * normalOffset;
      const status = wallState(id, next);
      return status.state === 'stable' && status.wall === wall.name ? {ok: true} : {ok: false, message: status.detail};
    }

    if (body.top + (next[id].y || 0) > ceilingY + CONTACT && (next[id].y || 0) >= (before[id].y || 0) - EPS) return {ok: false, message: '已到天花板高度，无法继续上升'};
    const prevBottom = body.bottom + (before[id].y || 0), bottom = body.bottom + (next[id].y || 0);
    if (direction === 'down') {
      // Stop at the first surface, even for large steps; partial contacts never tunnel through.
      const first = levels(id, next, prevBottom)[0];
      if (first && first.y >= bottom - SNAP) return descend(id, next, prevBottom, true);
    } else if (direction !== 'up') {
      const first = levels(id, next, bottom + SNAP)[0];
      if (first?.full && Math.abs(first.y - bottom) <= SNAP) return descend(id, next, bottom + SNAP);
    }
    if (bottom < floorY - CONTACT && bottom <= prevBottom + EPS) return {ok: false, message: '物体不能穿过地面'};
    return {ok: true};
  }

  function settle(id, layout) {
    if (bodies.get(id).wall) return constrain(id, layout, layout, 'wall');
    return descend(id, layout, bodies.get(id).bottom + (layout[id].y || 0) + SNAP, true);
  }

  function supportAtPoint(owner, point, layout) {
    if (owner && layout[owner]?.visible === false) return null;
    const local = owner ? inversePoint(point, bodies.get(owner).origin, layout[owner]) : point;
    const projected = [local[0], local[2]], offset = owner ? (layout[owner].y || 0) : 0;
    for (const surface of surfaces.filter(s => s.owner === owner)) {
      const height = surface.heightAt ? surface.heightAt(projected) : coverage([projected], surface.triangles).full ? surface.y : -Infinity;
      if (Number.isFinite(height) && Math.abs(height + offset - point[1]) <= CONTACT) return {...surface, point: [point[0], height + offset, point[2]]};
    }
    return null;
  }

  const settleAt = (id, layout, height) => descend(id, layout, height + SNAP, true);

  // statusOf: each piece's assess() in `before`, when the caller already has them.
  function carry(id, before, next, statusOf = (other) => assess(other, before)) {
    if (next[id]?.visible === false) return {ok: true, moved: []};
    const children = new Map();
    for (const other of bodies.keys()) {
      if (before[other]?.visible === false || next[other]?.visible === false) continue;
      const status = statusOf(other);
      // A lifted support is a draft, but objects still geometrically resting on it
      // must follow every subsequent move and its eventual landing.
      if (!status.support) continue;
      if (!children.has(status.support)) children.set(status.support, []);
      children.get(status.support).push(other);
    }
    const seen = new Set([id]);
    function visit(parent) {
      for (const child of children.get(parent) || []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next[child] = carryPose(before[child], bodies.get(child).origin, before[parent], next[parent], bodies.get(parent).origin);
        visit(child);
      }
    }
    visit(id);
    for (const child of seen) {
      const body = bodies.get(child);
      if (body.top + (next[child].y || 0) > ceilingY + CONTACT && (next[child].y || 0) >= (before[child].y || 0) - EPS) return {ok: false, message: '上方承载的物体会碰到天花板'};
    }
    return {ok: true, moved: [...seen]};
  }
  function wallFrame(id, layout) {
    const body = bodies.get(id);
    if (!body?.wall) return null;
    const pose = layout[id], attachment = currentWall(body, pose);
    if (!attachment) return null;
    const {wall} = attachment, points = wallPatch(body, pose, wall);
    const low = [0, 1].map((i) => Math.min(...points.map((p) => p[i]))), high = [0, 1].map((i) => Math.max(...points.map((p) => p[i])));
    const u = (low[0] + high[0]) / 2;
    return {name: wall.name, n: wall.n.slice(), tangent: wall.tangent.slice(), width: high[0] - low[0], height: high[1] - low[1],
      center: [wall.tangent[0] * u + wall.n[0] * (wall.d + .018), (low[1] + high[1]) / 2, wall.tangent[2] * u + wall.n[2] * (wall.d + .018)]};
  }
  function directionTarget(id, layout, axis) {
    const body = bodies.get(id);
    if (!body?.wall || !layout[id]) return null;
    const attachment = currentWall(body, layout[id]);
    if (!attachment) return null;
    const origin = transformPoint(body.back.center, body.origin, layout[id]);
    return nearestWallAlongRay(origin, axis, walls, attachment.wall.name);
  }
  const wallTargets = () => walls.map(({name, n, d, tangent, triangles, center, bounds}) => ({name, n: n.slice(), d,
    tangent: tangent.slice(), triangles, center: center.slice(), bounds: bounds.map((p) => p.slice())}));
  function projectedBase(id, layout) {
    const body = bodies.get(id), pose = layout[id];
    return convexHull(body.base.map(p => {
      const world = transformPoint([p[0], body.bottom, p[1]], body.origin, pose);
      return [world[0], world[2]];
    }));
  }
  return {assess, constrain, settle, settleAt, supportAtPoint, carry, projectedBase, wallFrame, wallTargets, mount, directionTarget, isWall: (id) => !!bodies.get(id)?.wall,
    audit: {surfaces: surfaces.length, walls: walls.length, seats,
      contacts: [...bodies.values()].filter((b) => !b.wall).map((b) => ({id: b.id, samples: b.base.length})),
      mounted: [...bodies.values()].filter((b) => b.wall).map((b) => ({id: b.id, wall: b.wall.name, gap: b.wall.gap}))}};

}
