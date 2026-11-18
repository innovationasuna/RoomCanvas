import {entityGeometry, meshGeometry} from './entity-geometry.mjs';
// Surface collision uses authored triangles; bounds only prune the search.
// Translation is swept continuously, so even a long step cannot jump a thin wall.
import {carryPose} from './placement.mjs';
const EPS = 1e-6;
const CLEARANCE = .0002;
// How much deeper than scanned an intersecting pair may go: noise, not a push.
const DEPTH_TOLERANCE = .005;
const IDENTITY = {x: 0, y: 0, z: 0, yaw: 0};
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const edges = (t) => [subtract(t[1], t[0]), subtract(t[2], t[1]), subtract(t[0], t[2])];
const normal = (t) => cross(subtract(t[1], t[0]), subtract(t[2], t[0]));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const bounds = (points) => {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) {box[k] = Math.min(box[k], p[k]); box[k + 3] = Math.max(box[k + 3], p[k]);}
  return box;
};
const union = (a, b) => [0, 1, 2].map((k) => Math.min(a[k], b[k])).concat([3, 4, 5].map((k) => Math.max(a[k], b[k])));
const overlap = (a, b, margin = EPS) => [0, 1, 2].every((k) => a[k] <= b[k + 3] + margin && a[k + 3] >= b[k] - margin);
const expand = (box, margin) => box.map((v, k) => v + (k < 3 ? -margin : margin));
const corners = (box) => Array.from({length: 8}, (_, n) => [0, 1, 2].map((k) => box[k + ((n >> k) & 1) * 3]));

function axesFor(a, b, end) {
  const ea = edges(a), eb = edges(b), na = normal(a), nb = normal(b);
  const axes = [na, nb];
  for (const x of ea) for (const y of eb) axes.push(cross(x, y));
  // Coplanar triangles also need separating axes in their shared plane.
  for (const edge of ea) axes.push(cross(na, edge));
  for (const edge of eb) axes.push(cross(nb, edge));
  if (end) {
    const ee = edges(end), ne = normal(end); axes.push(ne);
    for (const x of ee) {for (const y of eb) axes.push(cross(x, y)); axes.push(cross(ne, x));}
  }
  return axes.filter((axis) => dot(axis, axis) > 1e-20).map((axis) => {const length = Math.hypot(...axis); return axis.map((v) => v / length);});
}

// Interval SAT for a translating triangle; for a rotating segment the individual
// vertex velocities give conservative projection envelopes, with arc error padding.
export function sweepTriangle(a, b, delta, end = null, padding = 0, contactPolicy = true) {
  const velocities = end ? end.map((p, i) => subtract(p, a[i])) : [delta, delta, delta];
  const planeNormal = normal(b), planeLength = Math.hypot(...planeNormal);
  if (planeLength < 1e-12) return null;
  const pn = planeNormal.map((v) => v / planeLength), planeD = dot(pn, b[0]);
  const pd = a.map((p) => dot(pn, p) - planeD), pv = velocities.map((v) => dot(pn, v));
  // A face already lying on a surface may leave it either way. Adjacent side
  // faces determine which way enters a solid. Sliding along a plane is contact,
  // not collision, including across triangulation seams in a floor/tabletop.
  if (contactPolicy && pd.every((v) => Math.abs(v) <= EPS)) return null;
  if (contactPolicy && pv.every((v) => Math.abs(v) <= EPS) && (Math.min(...pd) >= -EPS || Math.max(...pd) <= EPS)) return null;
  let enter = 0, exit = 1, initiallyTouching = true;
  for (const axis of axesFor(a, b, end)) {
    const pa = a.map((p) => dot(p, axis)), pb = b.map((p) => dot(p, axis));
    const loA = Math.min(...pa), hiA = Math.max(...pa), loB = Math.min(...pb), hiB = Math.max(...pb);
    if (loA > hiB + EPS || hiA < loB - EPS) initiallyTouching = false;
    const speeds = velocities.map((v) => dot(v, axis));
    // Each inequality has the form c + v*t >= 0.
    for (const [c, v] of [[hiB - loA + padding, -Math.min(...speeds)], [hiA - loB + padding, Math.max(...speeds)]]) {
      if (Math.abs(v) < 1e-14) {if (c < -EPS) return null;}
      else if (v > 0) enter = Math.max(enter, -c / v);
      else exit = Math.min(exit, -c / v);
      if (enter > exit + EPS) return null;
    }
  }
  if (exit < -EPS || enter > 1 + EPS) return null;
  if (initiallyTouching && contactPolicy) {
    // Imported/authored meshes sometimes already touch or slightly intersect.
    // Permit tangent motion and escape on THAT triangle, never ignore its mesh.
    // A displacement that deepens the existing overlap is blocked immediately.
    const nb = normal(b), length = Math.hypot(...nb);
    if (length < 1e-12) return null;
    const n = nb.map((v) => v / length), plane = dot(b[0], n);
    const distances = a.map((p) => dot(p, n) - plane), speeds = velocities.map((v) => dot(v, n));
    const negativeDepth = Math.max(0, -Math.min(...distances)), positiveDepth = Math.max(0, Math.max(...distances));
    const away = negativeDepth <= positiveDepth ? Math.min(...speeds) >= -EPS : Math.max(...speeds) <= EPS;
    if (away || (Math.abs(negativeDepth - positiveDepth) < EPS && !end)) return null;
    return 0;
  }
  return Math.max(0, enter);
}

function trianglesIntersect(a, b) {
  return axesFor(a, b).every((axis) => {
    const pa = a.map((p) => dot(p, axis)), pb = b.map((p) => dot(p, axis));
    return Math.min(...pa) <= Math.max(...pb) + EPS && Math.max(...pa) >= Math.min(...pb) - EPS;
  });
}

// A fixed placement has no approach direction. Only crossings through the
// interiors of both triangles count here; edge and coplanar support contact is
// legal. Solid containment below catches aligned boxes and enclosed meshes.
function trianglesCross(a, b) {
  for (const [face, other] of [[a, b], [b, a]]) {
    const raw = normal(face), length = Math.hypot(...raw), n = raw.map((v) => v / length);
    const d = dot(n, face[0]), distances = other.map((p) => dot(n, p) - d);
    if (Math.min(...distances) >= -EPS || Math.max(...distances) <= EPS) return false;
  }
  return trianglesIntersect(a, b);
}

const centroid = (triangle) => [0, 1, 2].map((k) => (triangle[0][k] + triangle[1][k] + triangle[2][k]) / 3);
const containsPoint = (box, p, margin = EPS) => [0, 1, 2].every((k) => p[k] >= box[k] - margin && p[k] <= box[k + 3] + margin);

// Closedness is determined from authored triangle edges, independent of normal
// winding. Open sheets can obstruct a crossing but cannot invent a solid volume.
function isClosed(mesh) {
  if (mesh.closed !== undefined) return mesh.closed;
  if ([0, 1, 2].some((k) => mesh.tree.box[k + 3] - mesh.tree.box[k] < EPS)) return mesh.closed = false;
  const vertices = new Map(), counts = new Map();
  const vertexId = (point) => {
    const key = point.map((v) => Math.round(v / EPS)).join(',');
    if (!vertices.has(key)) vertices.set(key, vertices.size);
    return vertices.get(key);
  };
  for (const face of mesh.faces) {
    const ids = face.triangle.map(vertexId);
    for (let i = 0; i < 3; i++) {
      const a = ids[i], b = ids[(i + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return mesh.closed = counts.size > 0 && [...counts.values()].every((count) => count === 2);
}

function pointOnTriangle(point, face) {
  if (Math.abs(dot(point, face.plane) - face.d) > EPS) return false;
  const v0 = subtract(face.triangle[1], face.triangle[0]), v1 = subtract(face.triangle[2], face.triangle[0]), v2 = subtract(point, face.triangle[0]);
  const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  const determinant = d00 * d11 - d01 * d01;
  if (Math.abs(determinant) < 1e-22) return false;
  const u = (d11 * d20 - d01 * d21) / determinant, v = (d00 * d21 - d01 * d20) / determinant;
  return u >= -EPS && v >= -EPS && u + v <= 1 + EPS;
}

function rayBox(point, direction, box) {
  let enter = 0, exit = Infinity;
  for (let k = 0; k < 3; k++) {
    const t0 = (box[k] - point[k]) / direction[k], t1 = (box[k + 3] - point[k]) / direction[k];
    enter = Math.max(enter, Math.min(t0, t1)); exit = Math.min(exit, Math.max(t0, t1));
    if (enter > exit + EPS) return false;
  }
  return exit > EPS;
}

function pointOnMesh(mesh, point) {
  function onBoundary(node) {
    if (!containsPoint(node.box, point)) return false;
    return node.faces ? node.faces.some((face) => containsPoint(face.box, point) && pointOnTriangle(point, face)) : onBoundary(node.left) || onBoundary(node.right);
  }
  return onBoundary(mesh.tree);
}

function pointInside(mesh, point) {
  if (!containsPoint(mesh.tree.box, point) || !isClosed(mesh)) return false;
  // Exact contact is not containment, regardless of the chosen ray direction.
  if (pointOnMesh(mesh, point)) return false;
  const directions = [[1, .371390676, .52917319], [.217341, 1, .618073], [.419517, .731931, 1]];
  let insideVotes = 0;
  for (const direction of directions) {
    const hits = []; let grazing = false;
    function visit(node) {
      if (!rayBox(point, direction, node.box)) return;
      if (!node.faces) {visit(node.left); visit(node.right); return;}
      // Moller-Trumbore, written out in scalars: the same arithmetic as subtract/cross/dot,
      // without allocating arrays for every face of a large mesh.
      const [d0, d1, d2] = direction, [p0, p1, p2] = point;
      for (const face of node.faces) {
        const [a, b, c] = face.triangle;
        const e10 = b[0] - a[0], e11 = b[1] - a[1], e12 = b[2] - a[2], e20 = c[0] - a[0], e21 = c[1] - a[1], e22 = c[2] - a[2];
        const h0 = d1 * e22 - d2 * e21, h1 = d2 * e20 - d0 * e22, h2 = d0 * e21 - d1 * e20;
        const determinant = e10 * h0 + e11 * h1 + e12 * h2;
        if (Math.abs(determinant) < 1e-14) continue;
        const s0 = p0 - a[0], s1 = p1 - a[1], s2 = p2 - a[2], u = (s0 * h0 + s1 * h1 + s2 * h2) / determinant;
        const q0 = s1 * e12 - s2 * e11, q1 = s2 * e10 - s0 * e12, q2 = s0 * e11 - s1 * e10, v = (d0 * q0 + d1 * q1 + d2 * q2) / determinant;
        if (u < -EPS || v < -EPS || u + v > 1 + EPS) continue;
        const t = (e20 * q0 + e21 * q1 + e22 * q2) / determinant;
        if (t <= EPS) continue;
        if (Math.min(u, v, 1 - u - v) < EPS) grazing = true;
        hits.push(t);
      }
    }
    visit(mesh.tree); hits.sort((a, b) => a - b);
    const count = hits.filter((t, i) => i === 0 || t - hits[i - 1] > EPS).length;
    const inside = count % 2 === 1;
    if (!grazing) return inside;
    if (inside) insideVotes++;
  }
  return insideVotes >= 2;
}

function makeBVH(faces) {
  const box = faces.reduce((value, face) => value ? union(value, face.box) : face.box, null);
  if (faces.length <= 10) return {box, faces};
  let axis = 0; for (let k = 1; k < 3; k++) if (box[k + 3] - box[k] > box[axis + 3] - box[axis]) axis = k;
  faces.sort((a, b) => a.box[axis] + a.box[axis + 3] - b.box[axis] - b.box[axis + 3]);
  const mid = faces.length >> 1;
  return {box, left: makeBVH(faces.slice(0, mid)), right: makeBVH(faces.slice(mid))};
}

// Exact support projections of mesh vertices. BVH bounds only prune branches;
// the returned extrema always come from real triangle vertices, including concave meshes.
// With a stop, any value above it is returned as soon as it is found.
function support(mesh, axis, stop = Infinity) {
  let best = -Infinity;
  const upper = (node) => axis.reduce((sum, value, k) => sum + value * node.box[k + (value >= 0 ? 3 : 0)], 0);
  function visit(node) {
    if (best > stop || upper(node) <= best) return;
    if (node.faces) {
      for (const face of node.faces) for (const point of face.triangle) best = Math.max(best, dot(axis, point));
    } else if (upper(node.left) >= upper(node.right)) {visit(node.left); visit(node.right);}
    else {visit(node.right); visit(node.left);}
  }
  visit(mesh.tree);
  return best;
}
const projection = (mesh, axis, offset = 0) => [-support(mesh, axis.map((v) => -v)) + offset, support(mesh, axis) + offset];

// The outer planes of a mesh, or of a piece of it: its faces with all of it behind them, plus its
// bounds, each as an outward normal n with n·x <= d. They bound its convex hull; a flat sheet
// is behind both of its sides.
function outerPlanes(piece, faces) {
  const planes = new Map(), box = piece.tree.box;
  for (let k = 0; k < 3; k++) {
    const n = [0, 1, 2].map((j) => j === k ? 1 : 0);
    planes.set(k, [{n, d: box[k + 3]}, {n: n.map((v) => -v), d: -box[k]}]);
  }
  for (const {plane: n, d} of faces) {
    const key = [...n, d].map((v) => v.toFixed(7)).join(',');
    if (planes.has(key)) continue;
    const sides = [];
    if (support(piece, n, d + EPS) <= d + EPS) sides.push({n, d});
    if (support(piece, n.map((v) => -v), EPS - d) <= EPS - d) sides.push({n: n.map((v) => -v), d: -d});
    planes.set(key, sides);
  }
  return [...planes.values()].flat();
}

// A mesh's outer planes, and its connected pieces (the two sides of a frame, each book of a
// stack) with theirs. Computed on first use.
const hulls = new WeakMap();
function hull(mesh) {
  if (!hulls.has(mesh.tree)) hulls.set(mesh.tree, {});
  const value = hulls.get(mesh.tree);
  value.planes ||= outerPlanes(mesh, mesh.faces);
  return value;
}
function pieces(mesh) {
  const value = hull(mesh);
  if (!value.pieces) {
    const parent = new Map(), key = (p) => p.map((v) => Math.round(v / EPS)).join(',');
    const find = (k) => {while (parent.get(k) !== k) parent.set(k, k = parent.get(parent.get(k))); return k;};
    for (const face of mesh.faces) {
      const [a, ...rest] = face.triangle.map(key);
      for (const k of [a, ...rest]) if (!parent.has(k)) parent.set(k, k);
      for (const k of rest) parent.set(find(k), find(a));
    }
    const groups = new Map();
    for (const face of mesh.faces) {
      const root = find(key(face.triangle[0]));
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(face);
    }
    value.pieces = groups.size === 1 ? [{tree: mesh.tree, planes: value.planes}] : [...groups.values()].map((faces) => {
      const piece = {tree: makeBVH(faces.slice())};
      return {...piece, planes: outerPlanes(piece, faces)};
    });
  }
  return value.pieces;
}

const worldPoint = (p, owner, pose) => {
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return [owner.origin[0] + pose.x + c * p[0] + s * p[2], owner.origin[1] + (pose.y || 0) + p[1], owner.origin[2] + pose.z - s * p[0] + c * p[2]];
};
const localPoint = (p, owner, pose) => {
  const x = p[0] - owner.origin[0] - pose.x, z = p[2] - owner.origin[2] - pose.z;
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return [c * x - s * z, p[1] - owner.origin[1] - (pose.y || 0), s * x + c * z];
};
const interpolate = (a, b, t) => ({...b, x: a.x + (b.x - a.x) * t, y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * t, z: a.z + (b.z - a.z) * t, yaw: wrap(a.yaw + wrap(b.yaw - a.yaw) * t)});

// Pure-data adapter also makes actual collision behavior testable without WebGL.
// All triangle vertices are relative to the owner's authored origin.
const meshIndexes = new WeakMap();
export function buildCollision(input, {keepAuthoredOverlaps = false} = {}) {
  const started = performance.now();
  let builtMeshes = 0, reusedMeshes = 0;
  const owners = input.map((owner) => ({...owner, origin: owner.origin || [0, 0, 0], meshes: owner.meshes.map((mesh) => {
    if (meshIndexes.has(mesh.triangles)) {reusedMeshes++; return {...mesh, ...meshIndexes.get(mesh.triangles)};}
    builtMeshes++;
    const faces = mesh.triangles.map((triangle, faceIndex) => {
      if (dot(normal(triangle), normal(triangle)) <= 1e-20) return null;
      const raw = normal(triangle), length = Math.hypot(...raw), plane = raw.map((v) => v / length);
      return {triangle, faceIndex, box: bounds(triangle), plane, d: dot(plane,triangle[0])};
    }).filter(Boolean);
    const index = {faces, tree: faces.length ? makeBVH(faces) : null};
    meshIndexes.set(mesh.triangles, index);
    return {...mesh, ...index};
  }).filter((mesh) => mesh.tree)}));
  const audit = {builtMeshes, reusedMeshes, objects: owners.length, meshes: owners.reduce((n, o) => n + o.meshes.length, 0), triangles: input.reduce((n, o) => n + o.meshes.reduce((n, m) => n + m.triangles.length, 0), 0), buildMs: performance.now() - started};

  function fixedMesh(meshA, ownerA, poseA, meshB, ownerB, poseB) {
    const relative = (point) => localPoint(worldPoint(point, ownerA, poseA), ownerB, poseB);
    const transformedBoxes = new Map(), transformedFaces = new Map();
    const nodeBox = (node) => {
      if (!transformedBoxes.has(node)) transformedBoxes.set(node, bounds(corners(node.box).map(relative)));
      return transformedBoxes.get(node);
    };
    const triangle = (face) => {
      if (!transformedFaces.has(face)) transformedFaces.set(face, face.triangle.map(relative));
      return transformedFaces.get(face);
    };
    // A transformed face with its bounds and unit plane, computed once per check.
    const planes = new Map();
    const placed = (face) => {
      if (!planes.has(face)) {
        const t = triangle(face), raw = normal(t), length = Math.hypot(...raw);
        const n = length < 1e-12 ? null : raw.map((v) => v / length);
        planes.set(face, {t, box: bounds(t), n, d: n ? dot(n, t[0]) : 0});
      }
      return planes.get(face);
    };
    // Signed distances of a triangle's corners to a plane, as [min, max].
    const span = (points, n, d) => {
      let low = Infinity, high = -Infinity;
      for (const p of points) {const v = dot(n, p) - d; if (v < low) low = v; if (v > high) high = v;}
      return [low, high];
    };
    function crosses(nodeA, nodeB) {
      if (!overlap(nodeBox(nodeA), nodeB.box)) return false;
      if (nodeA.faces && nodeB.faces) {
        for (const fa of nodeA.faces) {
          const a = placed(fa);
          if (!a.n) continue;
          for (const fb of nodeB.faces) {
            if (!overlap(a.box, fb.box)) continue;
            // trianglesCross with both planes computed once: each triangle must straddle the other's.
            const [lowA, highA] = span(a.t, fb.plane, fb.d), [lowB, highB] = span(fb.triangle, a.n, a.d);
            if (lowA < -EPS && highA > EPS && lowB < -EPS && highB > EPS && trianglesIntersect(a.t, fb.triangle)) return true;
          }
        }
        return false;
      }
      if (!nodeA.faces) return crosses(nodeA.left, nodeB) || crosses(nodeA.right, nodeB);
      return crosses(nodeA, nodeB.left) || crosses(nodeA, nodeB.right);
    }
    if (crosses(meshA.tree, meshB.tree)) return 'crossing';

    function contained(source, sourceOwner, sourcePose, target, targetOwner, targetPose) {
      if (!isClosed(target)) return false;
      const toTarget = (point) => localPoint(worldPoint(point, sourceOwner, sourcePose), targetOwner, targetPose);
      // A vertex is shared by about six faces, as one array; test it once.
      const known = new Map();
      const inside = (point) => {
        if (!known.has(point)) known.set(point, pointInside(target, toTarget(point)));
        return known.get(point);
      };
      function visit(node) {
        if (!overlap(bounds(corners(node.box).map(toTarget)), target.tree.box)) return false;
        if (!node.faces) return visit(node.left) || visit(node.right);
        for (const face of node.faces) {
          const center = centroid(face.triangle), points = [center, ...face.triangle];
          for (const point of points) if (inside(point)) return true;
          // Fully coincident shells have no crossing and every boundary sample
          // is contact. Probe both sides but require the probe to be inside BOTH
          // closed meshes, so adjacent touching solids remain legal.
          if (pointOnMesh(target, toTarget(center)) && isClosed(source)) {
            for (const sign of [-1, 1]) {
              const probe = center.map((v, k) => v + sign * face.plane[k] * EPS * 8);
              if (pointInside(target, toTarget(probe)) && pointInside(source, probe)) return true;
            }
          }
        }
        return false;
      }
      return visit(source.tree);
    }
    if (contained(meshA, ownerA, poseA, meshB, ownerB, poseB) || contained(meshB, ownerB, poseB, meshA, ownerA, poseA)) return 'containment';
    return null;
  }

  // How far meshA and each piece of meshB reach past each other's outer planes. The least is
  // the shortest push that parts their hulls along one of those planes: their depth.
  function penetrations(meshA, ownerA, poseA, meshB, ownerB, poseB) {
    const frame = (owner, pose, other, otherPose) => {
      const relative = (p) => localPoint(worldPoint(p, owner, pose), other, otherPose), zero = relative([0, 0, 0]);
      return {zero, basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => subtract(relative(p), zero))};
    };
    const toB = frame(ownerA, poseA, ownerB, poseB), toA = frame(ownerB, poseB, ownerA, poseA);
    const lowest = (mesh, {zero, basis}, n) => projection(mesh, basis.map((axis) => dot(n, axis)), dot(n, zero))[0];
    const own = hull(meshA).planes;
    return pieces(meshB).map((piece) => [...piece.planes.map(({n, d}) => d - lowest(meshA, toB, n)), ...own.map(({n, d}) => d - lowest(piece, toA, n))]);
  }
  const depth = (values) => values.reduce((a, b) => Math.min(a, b), Infinity);

  // A mesh pair that already intersects in the scan (a desk against the wall it was scanned
  // into, a frame sunk into its wall) may intersect, but not deeper than it was scanned, in any
  // pose. Remembered per pair as how deep each piece of meshB may be entered: as deep as in the
  // scan, within the tolerance, so an untouched piece not at all. Null for every other pair.
  // Restoring an old layout changes poses only, so undo cannot create collision permissions.
  const authored = new Map();
  function allowance(meshA, ownerA, meshB, ownerB) {
    // An object brought in later (owner.added) was never part of the scan.
    if (!keepAuthoredOverlaps || ownerA.added || ownerB.added) return null;
    if (!authored.has(meshA)) authored.set(meshA, new Map());
    const row = authored.get(meshA);
    if (!row.has(meshB)) {
      const box = (mesh, owner) => bounds(corners(mesh.tree.box).map((p) => worldPoint(p, owner, IDENTITY)));
      const intersecting = overlap(box(meshA, ownerA), box(meshB, ownerB)) && !!fixedMesh(meshA, ownerA, IDENTITY, meshB, ownerB, IDENTITY);
      row.set(meshB, intersecting ? penetrations(meshA, ownerA, IDENTITY, meshB, ownerB, IDENTITY).map((values) => Math.max(depth(values), 0) + DEPTH_TOLERANCE) : null);
    }
    return row.get(meshB);
  }
  const deeper = (found, allowed) => found.some((values, i) => depth(values) > allowed[i]);

  // The first fraction of a step at which a scanned pair becomes deeper than allowed, or 1. Each
  // penetration changes linearly along a straight step (the yaw segments are short), so the
  // too-deep part, where all of a piece's penetrations pass the allowance, is one interval. A
  // piece already deeper than allowed may not go deeper still.
  function deepens(meshA, ownerA, start, end, meshB, ownerB, poseB, allowed) {
    const from = penetrations(meshA, ownerA, start, meshB, ownerB, poseB), to = penetrations(meshA, ownerA, end, meshB, ownerB, poseB);
    let first = 1;
    from.forEach((values, piece) => {
      const limit = Math.max(allowed[piece], depth(values));
      let enter = 0, exit = 1;
      values.forEach((value, i) => {
        const rate = to[piece][i] - value;
        if (Math.abs(rate) < 1e-14) {if (value <= limit) exit = -1;}
        else if (rate > 0) enter = Math.max(enter, (limit - value) / rate);
        else exit = Math.min(exit, (limit - value) / rate);
      });
      if (enter < exit) first = Math.min(first, enter);
    });
    return first;
  }

  // An explicit wall remount chooses a destination, unlike an ordinary nudge.
  // Check that destination without sweeping through furniture between walls.
  // Carried children are an assembly: internal support contacts are preserved,
  // while every moved member is checked against all stationary authored meshes.
  // One edit asks about the same layout twice (the move, then its drop preview); the answer
  // depends only on the poses, so the last one is reused.
  let last = null;
  function checkPlacement(layout, movedIds) {
    const key = JSON.stringify([movedIds, owners.map((owner) => layout[owner.id] || null)]);
    if (last?.key === key) return last.result;
    const result = checkPlacementOnce(layout, movedIds);
    last = {key, result};
    return result;
  }

  function checkPlacementOnce(layout, movedIds) {
    const started = performance.now(), moved = new Set(movedIds), moving = owners.filter((owner) => moved.has(owner.id));
    if (moving.length !== moved.size || moving.some((owner) => !layout[owner.id] || !['x', 'z', 'yaw'].every((key) => Number.isFinite(layout[owner.id][key])) || !Number.isFinite(layout[owner.id].y ?? 0))) {
      return {ok: false, blocked: true, other: null, reason: 'invalid-pose'};
    }
    const obstacles = owners.filter((owner) => !moved.has(owner.id) && layout[owner.id]?.visible !== false).flatMap((owner) => owner.meshes.map((mesh) => {
      const pose = layout[owner.id] || IDENTITY;
      return {owner, mesh, pose, box: bounds(corners(mesh.tree.box).map((p) => worldPoint(p, owner, pose)))};
    }));
    let other = null, reason = null;
    outer: for (const a of moving.filter((owner) => layout[owner.id]?.visible !== false)) for (const ma of a.meshes) {
      const pose = layout[a.id], box = bounds(corners(ma.tree.box).map((p) => worldPoint(p, a, pose)));
      for (const {owner: b, mesh: mb, pose: poseB, box: obstacleBox} of obstacles) {
        if (!overlap(box, obstacleBox)) continue;
        reason = fixedMesh(ma, a, pose, mb, b, poseB);
        const allowed = reason && allowance(ma, a, mb, b);
        if (allowed && !deeper(penetrations(ma, a, pose, mb, b, poseB), allowed)) reason = null;
        if (reason) {
          other = {id: b.id, name: b.name, mesh: mb.name, movingId: a.id, movingMesh: ma.name};
          break outer;
        }
      }
    }
    audit.lastPlacementMs = performance.now() - started;
    return {ok: !other, blocked: Boolean(other), other, reason};
  }

  function sweepMesh(meshA, ownerA, poseA, endA, meshB, ownerB, poseB, maxFraction, assemblyRadius = 0) {
    const changingYaw = Math.abs(wrap(endA.yaw - poseA.yaw)) > 1e-10;
    const relative = (point, pose) => localPoint(worldPoint(point, ownerA, pose), ownerB, poseB);
    const delta = subtract(relative([0, 0, 0], endA), relative([0, 0, 0], poseA));
    const angle = Math.abs(wrap(endA.yaw - poseA.yaw));
    const radius = Math.max(assemblyRadius, ...corners(meshA.tree.box).map((p) => Math.hypot(p[0], p[2])));
    const padding = changingYaw ? radius * (1 - Math.cos(angle / 2)) : 0;
    const nodeBoxes = new Map(), transformedFaces = new Map();
    function nodeBox(node) {
      if (!nodeBoxes.has(node)) {
        const points = corners(node.box), startPoints = points.map((p) => relative(p, poseA)), startBox = bounds(startPoints);
        const endPoints = changingYaw ? points.map((p) => relative(p, endA)) : null;
        const endBox = changingYaw ? bounds(endPoints) : startBox.map((v,k) => v + delta[k % 3]);
        nodeBoxes.set(node, {startBox, startPoints, endPoints, box: expand(union(startBox, endBox), padding)});
      }
      return nodeBoxes.get(node);
    }
    function broadTime(nodeA, nodeB) {
      const {startBox, startPoints, endPoints, box} = nodeBox(nodeA);
      if (!overlap(box, nodeB.box)) return Infinity;
      // Large diagonal walls have very loose AABBs. Their actual face planes
      // cheaply reject entire chair BVH branches before reaching triangles.
      if (nodeB.faces && !nodeB.faces.some((face) => {
        const values = startPoints.map((p) => dot(p,face.plane)), shift = dot(delta,face.plane);
        const lo = Math.min(...values), hi = Math.max(...values);
        const end = endPoints ? endPoints.map((p) => dot(p,face.plane)) : [lo+shift,hi+shift];
        return Math.min(lo,...end) <= face.d+padding+EPS && Math.max(hi,...end) >= face.d-padding-EPS;
      })) return Infinity;
      if (changingYaw) return 0;
      let enter = 0, exit = 1;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(delta[k]) < 1e-14) continue;
        const t1 = (nodeB.box[k] - startBox[k + 3] - EPS) / delta[k], t2 = (nodeB.box[k + 3] - startBox[k] + EPS) / delta[k];
        enter = Math.max(enter, Math.min(t1,t2)); exit = Math.min(exit, Math.max(t1,t2));
      }
      return enter <= exit + EPS ? enter : Infinity;
    }
    const recoveryCache = new Map();
    const startZero = relative([0, 0, 0], poseA), endZero = relative([0, 0, 0], endA);
    const basis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => subtract(relative(p, poseA), startZero));
    const endBasis = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => subtract(relative(p, endA), endZero));
    function recovering(fb) {
      if (recoveryCache.has(fb)) return recoveryCache.get(fb);
      const n0 = normal(fb.triangle), length = Math.hypot(...n0), n = n0.map((v) => v / length), d = dot(n, fb.triangle[0]);
      const axis = basis.map((v) => dot(n, v)), endAxis = endBasis.map((v) => dot(n, v));
      const [low, high] = projection(meshA, axis, dot(n, startZero) - d);
      const [lowSpeed, highSpeed] = projection(meshA, subtract(endAxis, axis), dot(n, subtract(endZero, startZero)));
      const negative = Math.max(0, -low), positive = Math.max(0, high);
      const away = negative < positive ? lowSpeed >= -EPS : highSpeed <= EPS;
      let touching = false;
      if (away) {
        const scan = (node) => {
          if (touching || !overlap(bounds(corners(node.box).map((p) => relative(p, poseA))), fb.box)) return;
          if (node.faces) touching = node.faces.some((face) => trianglesIntersect(face.triangle.map((p) => relative(p, poseA)), fb.triangle));
          else {scan(node.left); scan(node.right);}
        };
        scan(meshA.tree);
      }
      const result = away && touching;
      recoveryCache.set(fb, result); return result;
    }
    let earliest = maxFraction;
    function visit(nodeA, nodeB) {
      if (broadTime(nodeA,nodeB) >= earliest) return;
      if (nodeA.faces && nodeB.faces) {
        for (const fa of nodeA.faces) {
          if (!transformedFaces.has(fa)) {
            const a = fa.triangle.map((p) => relative(p, poseA)), end = changingYaw ? fa.triangle.map((p) => relative(p, endA)) : null;
            const endBounds = end ? bounds(end) : bounds(a.map((p) => p.map((v, k) => v + delta[k])));
            transformedFaces.set(fa, {a,end,box:expand(union(bounds(a),endBounds),padding)});
          }
          const {a,end,box:sweptBounds} = transformedFaces.get(fa);
          for (const fb of nodeB.faces) {
            if (!overlap(sweptBounds, fb.box)) continue;
            const contact = sweepTriangle(a, fb.triangle, delta, end, padding);
            if (contact !== null && contact < earliest && !recovering(fb)) earliest = contact;
            if (earliest <= 0) return;
          }
        }
      } else {
        const pairs = !nodeA.faces && (nodeB.faces || nodeA.box.reduce((v, _, k) => k < 3 ? v + nodeA.box[k + 3] - nodeA.box[k] : v, 0) > nodeB.box.reduce((v, _, k) => k < 3 ? v + nodeB.box[k + 3] - nodeB.box[k] : v, 0))
          ? [[nodeA.left,nodeB],[nodeA.right,nodeB]] : [[nodeA,nodeB.left],[nodeA,nodeB.right]];
        pairs.sort((a,b) => broadTime(...a) - broadTime(...b));
        for (const pair of pairs) if (earliest > 0) visit(...pair);
      }
    }
    visit(meshA.tree, meshB.tree);
    return earliest;
  }

  function limit(before, next, movedIds) {
    const started = performance.now(), moved = new Set(movedIds), moving = owners.filter((owner) => moved.has(owner.id) && next[owner.id]?.visible !== false);
    const pairTimings = [];
    const root = owners.find((owner) => owner.id === [...moved][0]);
    const poseAt = (owner,t) => {
      const rootPose = interpolate(before[root.id],next[root.id],t);
      return owner === root ? rootPose : carryPose(before[owner.id],owner.origin,before[root.id],rootPose,root.origin);
    };
    const radiusFromRoot = (owner, mesh) => Math.max(...corners(mesh.tree.box).map((p) => {
      const w = worldPoint(p,owner,before[owner.id]);
      return Math.hypot(w[0]-root.origin[0]-before[root.id].x,w[2]-root.origin[2]-before[root.id].z);
    }));
    let segments = 1, distance = 0;
    for (const owner of moving) {
      const a = before[owner.id], b = next[owner.id], yaw = Math.abs(wrap(b.yaw - a.yaw));
      segments = Math.max(segments, Math.ceil(yaw / (Math.PI / 360)));
      const radius = Math.max(0, ...owner.meshes.flatMap((mesh) => corners(mesh.tree.box).map((p) => Math.hypot(p[0], p[2]))));
      distance = Math.max(distance, Math.hypot(b.x - a.x, (b.y || 0) - (a.y || 0), b.z - a.z) + radius * yaw);
    }
    if (distance < 1e-12) return {layout: next, blocked: false, other: null, fraction: 1};
    const stationary = owners.filter((owner) => !moved.has(owner.id) && next[owner.id]?.visible !== false);
    const obstacles = stationary.flatMap((owner) => owner.meshes.map((mesh) => ({owner, mesh, pose: before[owner.id] || IDENTITY,
      box: bounds(corners(mesh.tree.box).map((p) => worldPoint(p, owner, before[owner.id] || IDENTITY)))})));
    let fraction = 1, other = null;
    outer: for (let segment = 0; segment < segments; segment++) {
      let first = 1;
      for (const a of moving) {
        const start = poseAt(a,segment / segments), end = poseAt(a,(segment + 1) / segments);
        for (const ma of a.meshes) {
          const points = corners(ma.tree.box), angle = Math.abs(wrap(end.yaw - start.yaw));
          const assemblyRadius = radiusFromRoot(a,ma), arc = assemblyRadius * (1 - Math.cos(angle / 2));
          const box = expand(union(bounds(points.map((p) => worldPoint(p, a, start))), bounds(points.map((p) => worldPoint(p, a, end)))), arc);
          for (const {owner: b, mesh: mb, pose, box: obstacleBox} of obstacles) {
            if (!overlap(box, obstacleBox)) continue;
            const pairStart = performance.now();
            // A scanned pair is limited by its depth, every other pair by the sweep.
            const allowed = allowance(ma, a, mb, b);
            const hit = allowed ? deepens(ma, a, start, end, mb, b, pose, allowed) : sweepMesh(ma, a, start, end, mb, b, pose, first, assemblyRadius);
            pairTimings.push({moving:ma.name, obstacle:mb.name, owner:b.id, ms:performance.now()-pairStart});
            if (hit < first) {first = hit; other = {id: b.id, name: b.name, mesh: mb.name, movingId:a.id, movingMesh:ma.name};}
            if (first <= 0) break;
          }
          if (first <= 0) break;
        }
        if (first <= 0) break;
      }
      if (first < 1) {fraction = Math.max(0, (segment + first) / segments - CLEARANCE / distance); break outer;}
    }
    const layout = {...next};
    if (fraction < 1) for (const owner of moving) layout[owner.id] = poseAt(owner,fraction);
    audit.lastMs = performance.now() - started;
    audit.lastPairs = pairTimings.sort((a,b) => b.ms-a.ms).slice(0,5);
    return {layout, blocked: fraction < 1, other, fraction};
  }
  return {limit, checkPlacement, audit};
}

// The pieces and fixed parts of a room with their triangles, read from its meshes once.
const ownerSnapshots = new WeakMap(), relativeMeshes = new WeakMap(), meshSources = new WeakMap();
export const collisionMeshSource = (mesh) => meshSources.get(mesh);
export function triangleIndex(triangles) {
  if (!meshIndexes.has(triangles)) buildCollision([{id: 'query', meshes: [{triangles}]}]);
  return meshIndexes.get(triangles);
}
export function collisionOwners(THREE, room, entities, {label = () => null} = {}) {
  room.updateMatrixWorld(true);
  const owners = [], meshOwners = new Map();
  for (const [id, entity] of entities) {
    const owner = {id, name: entity.name, origin: entity.origin.toArray(), meshes: [], added: !!entity.added};
    owners.push(owner);
    for (const [mesh, matrix] of entityGeometry(THREE, entity).matrices) meshOwners.set(mesh, {owner, matrix});
  }
  const staticOwners = new Map();
  room.traverse((mesh) => {
    // A display mesh with a lighter stand-in for contact (userData.collision === false) is skipped.
    if (!mesh.isMesh || mesh.userData.collision === false) return;
    const reference = meshOwners.get(mesh);
    let owner = reference?.owner;
    if (!owner) {
      let root = mesh; while (root.parent && root.parent !== room) root = root.parent;
      // The flat authored floor is enforced by placement's actual contact patches
      // and floorY constraint. Rechecking 50k chair triangles against the same two
      // large coplanar floor faces adds latency but no additional collision rule.
      if ((root.userData.name || root.name) === 'Floor0') return;
      const id = `room:${root.userData.name || root.name}`;
      const name = label(root.userData.name || root.name) || '固定构件';
      if (!staticOwners.has(id)) staticOwners.set(id, {id, name, origin: [0, 0, 0], meshes: []});
      owner = staticOwners.get(id);
    }
    if (!mesh.geometry.attributes.position) return;
    const data = meshGeometry(THREE, mesh, reference?.matrix ?? mesh.matrixWorld);
    const originKey = owner.origin.join(',');
    let cached = relativeMeshes.get(mesh);
    if (cached?.data !== data || cached.originKey !== originKey) {
      const local = new Map(data.vertices.map((p) => [p, p.map((v, k) => v - owner.origin[k])]));
      cached = {data, originKey, mesh: {name: mesh.userData.name || mesh.name, triangles: data.triangles.map((t) => t.map((p) => local.get(p)))}};
      relativeMeshes.set(mesh, cached);
      meshSources.set(cached.mesh, {mesh, matrix: (reference?.matrix ?? mesh.matrixWorld).clone()});
    }
    owner.meshes.push(cached.mesh);
  });
  const previous = ownerSnapshots.get(room) || new Map();
  const result = [...owners, ...staticOwners.values()].map((owner) => {
    const old = previous.get(owner.id);
    return old && old.name === owner.name && old.added === owner.added && old.origin.every((v, k) => v === owner.origin[k]) && old.meshes.length === owner.meshes.length && old.meshes.every((mesh, k) => mesh === owner.meshes[k]) ? old : owner;
  });
  ownerSnapshots.set(room, new Map(result.map((owner) => [owner.id, owner])));
  return result;
}

export function createCollision(THREE, room, entities, specs, {label = () => null, keepAuthoredOverlaps = false} = {}) {
  return buildCollision(collisionOwners(THREE, room, entities, {label}), {keepAuthoredOverlaps});
}

// Owners as flat arrays (shared vertices and an index per mesh), to hand to a worker without
// copying; unpackOwners rebuilds exactly the same triangles, sharing vertices as before.
export function packOwners(owners) {
  const transfer = [];
  const packed = owners.map(({meshes, ...owner}) => ({...owner, meshes: meshes.map(({name, triangles}) => {
    const ids = new Map(), points = [];
    const index = new Uint32Array(triangles.length * 3);
    triangles.forEach((triangle, t) => triangle.forEach((point, k) => {
      if (!ids.has(point)) {ids.set(point, points.length); points.push(point);}
      index[t * 3 + k] = ids.get(point);
    }));
    const vertices = new Float64Array(points.length * 3);
    points.forEach((point, i) => vertices.set(point, i * 3));
    transfer.push(vertices.buffer, index.buffer);
    return {name, vertices, index};
  })}));
  return {owners: packed, transfer};
}
export function unpackOwners(packed) {
  return packed.map(({meshes, ...owner}) => ({...owner, meshes: meshes.map(({name, vertices, index}) => {
    const points = Array.from({length: vertices.length / 3}, (_, i) => [vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]]);
    return {name, triangles: Array.from({length: index.length / 3}, (_, t) => [points[index[t * 3]], points[index[t * 3 + 1]], points[index[t * 3 + 2]]])};
  })}));
}
