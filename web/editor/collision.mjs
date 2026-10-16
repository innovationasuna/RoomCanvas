// Surface collision uses authored triangles; bounds only prune the search.
// Translation is swept continuously, so even a long step cannot jump a thin wall.
import {carryPose} from './placement.mjs?v=wall-draft-13';
const EPS = 1e-6;
const CLEARANCE = .0002;
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
      for (const face of node.faces) {
        const [a, b, c] = face.triangle, e1 = subtract(b, a), e2 = subtract(c, a), h = cross(direction, e2), determinant = dot(e1, h);
        if (Math.abs(determinant) < 1e-14) continue;
        const s = subtract(point, a), u = dot(s, h) / determinant, q = cross(s, e1), v = dot(direction, q) / determinant;
        if (u < -EPS || v < -EPS || u + v > 1 + EPS) continue;
        const t = dot(e2, q) / determinant;
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
export function buildCollision(input, {keepAuthoredOverlaps = false} = {}) {
  const started = performance.now();
  const owners = input.map((owner) => ({...owner, origin: owner.origin || [0, 0, 0], meshes: owner.meshes.map((mesh) => {
    const faces = mesh.triangles.filter((triangle) => dot(normal(triangle), normal(triangle)) > 1e-20).map((triangle) => {
      const raw = normal(triangle), length = Math.hypot(...raw), plane = raw.map((v) => v / length);
      return {triangle, box: bounds(triangle), plane, d: dot(plane,triangle[0])};
    });
    return {...mesh, faces, tree: faces.length ? makeBVH(faces) : null};
  }).filter((mesh) => mesh.tree)}));
  const audit = {objects: owners.length, meshes: owners.reduce((n, o) => n + o.meshes.length, 0), triangles: input.reduce((n, o) => n + o.meshes.reduce((n, m) => n + m.triangles.length, 0), 0), buildMs: performance.now() - started};

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
    function crosses(nodeA, nodeB) {
      if (!overlap(nodeBox(nodeA), nodeB.box)) return false;
      if (nodeA.faces && nodeB.faces) {
        return nodeA.faces.some((fa) => {
          const a = triangle(fa), box = bounds(a);
          return nodeB.faces.some((fb) => overlap(box, fb.box) && trianglesCross(a, fb.triangle));
        });
      }
      if (!nodeA.faces) return crosses(nodeA.left, nodeB) || crosses(nodeA.right, nodeB);
      return crosses(nodeA, nodeB.left) || crosses(nodeA, nodeB.right);
    }
    if (crosses(meshA.tree, meshB.tree)) return 'crossing';

    function contained(source, sourceOwner, sourcePose, target, targetOwner, targetPose) {
      if (!isClosed(target)) return false;
      const toTarget = (point) => localPoint(worldPoint(point, sourceOwner, sourcePose), targetOwner, targetPose);
      function visit(node) {
        if (!overlap(bounds(corners(node.box).map(toTarget)), target.tree.box)) return false;
        if (!node.faces) return visit(node.left) || visit(node.right);
        for (const face of node.faces) {
          const center = centroid(face.triangle), points = [center, ...face.triangle];
          for (const point of points) if (pointInside(target, toTarget(point))) return true;
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

  // A reconstructed room can start with furniture slightly inside its neighbour (a
  // headboard in a wardrobe's socket plate). Those mesh pairs are the room as scanned,
  // not a user's move: they never block. Every other mesh pair still does. Checked on
  // first use and cached; a full pass over every pair at load takes seconds.
  const authored = new Map();
  function known(meshA, ownerA, meshB, ownerB) {
    if (!keepAuthoredOverlaps) return false;
    if (!authored.has(meshA)) authored.set(meshA, new Map());
    const row = authored.get(meshA);
    if (!row.has(meshB)) {
      const box = (mesh, owner) => bounds(corners(mesh.tree.box).map((p) => worldPoint(p, owner, IDENTITY)));
      row.set(meshB, overlap(box(meshA, ownerA), box(meshB, ownerB)) && !!fixedMesh(meshA, ownerA, IDENTITY, meshB, ownerB, IDENTITY));
    }
    return row.get(meshB);
  }

  // An explicit wall remount chooses a destination, unlike an ordinary nudge.
  // Check that destination without sweeping through furniture between walls.
  // Carried children are an assembly: internal support contacts are preserved,
  // while every moved member is checked against all stationary authored meshes.
  function checkPlacement(layout, movedIds) {
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
        if (!overlap(box, obstacleBox) || known(ma, a, mb, b)) continue;
        reason = fixedMesh(ma, a, pose, mb, b, poseB);
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
    function recovering(fb) {
      if (recoveryCache.has(fb)) return recoveryCache.get(fb);
      const n0 = normal(fb.triangle), length = Math.hypot(...n0), n = n0.map((v) => v / length), d = dot(n, fb.triangle[0]);
      const points = corners(meshA.tree.box).map((p) => relative(p, poseA));
      const ds = points.map((p) => dot(n, p) - d);
      const velocities = corners(meshA.tree.box).map((p, i) => dot(n, subtract(relative(p, endA), points[i])));
      const negative = Math.max(0, -Math.min(...ds)), positive = Math.max(0, Math.max(...ds));
      const away = negative < positive ? Math.min(...velocities) >= -EPS : Math.max(...velocities) <= EPS;
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
            if (!overlap(box, obstacleBox) || known(ma, a, mb, b)) continue;
            const pairStart = performance.now();
            const hit = sweepMesh(ma, a, start, end, mb, b, pose, first, assemblyRadius);
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

export function createCollision(THREE, room, entities, specs, {label = () => null, keepAuthoredOverlaps = false} = {}) {
  room.updateMatrixWorld(true);
  const owners = [...entities].map(([id, entity]) => ({id, name: entity.name, origin: entity.origin.toArray(), meshes: [], group: entity.group}));
  const meshOwners = new Map();
  for (const owner of owners) owner.group.traverse((mesh) => {if (mesh.isMesh) meshOwners.set(mesh, owner);});
  const staticOwners = new Map();
  room.traverse((mesh) => {
    if (!mesh.isMesh) return;
    let owner = meshOwners.get(mesh);
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
    const position = mesh.geometry.attributes.position, index = mesh.geometry.index;
    if (!position) return;
    const vertices = Array.from({length: position.count}, (_, i) => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).toArray().map((v, k) => v - owner.origin[k]));
    const triangles = [];
    for (let i = 0, count = index ? index.count : position.count; i + 2 < count; i += 3) triangles.push([0, 1, 2].map((k) => vertices[index ? index.getX(i + k) : i + k]));
    owner.meshes.push({name: mesh.userData.name || mesh.name, triangles});
  });
  return buildCollision([...owners, ...staticOwners.values()], {keepAuthoredOverlaps});
}
