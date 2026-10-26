// Walls carry inward normals. Near walls (exterior-facing or nearly edge-on) are concealed with
// their attached openings: hidden, or see-through in the editor. Collision and support never change.
export function hiddenWalls(walls, direction, previous = new Set()) {
  const length = Math.hypot(...direction), horizontal = Math.hypot(direction[0], direction[2]);
  if (!length || horizontal / length < .01) return new Set();
  const view = [direction[0] / horizontal, 0, direction[2] / horizontal];
  return new Set(walls.filter(wall => {
    const dot = wall.n[0] * view[0] + wall.n[2] * view[2];
    // A wall within ~7 degrees of edge-on reads as stray posts and door frames.
    // Restore beyond ~9 degrees so small camera movements do not flash the edge.
    return dot < (previous.has(wall.name) ? .16 : .12);
  }).map(wall => wall.name));
}

// A short wall between two long ones (a jog in the room outline) is a corner return: it
// disappears with either long wall instead of being left floating. Walls are linked where
// their inner faces end at the same point.
export function deriveJoins(walls, {short = .7, tolerance = .03} = {}) {
  if (!walls.every((wall) => wall.bounds && wall.tangent)) return [];
  const ends = walls.map((wall) => [wall.bounds[0][0], wall.bounds[1][0]].map((t) =>
    [wall.tangent[0] * t + wall.n[0] * wall.d, wall.tangent[2] * t + wall.n[2] * wall.d]));
  const isShort = (i) => walls[i].bounds[1][0] - walls[i].bounds[0][0] < short;
  const next = (i, end) => {
    const point = ends[i][end];
    for (let j = 0; j < walls.length; j++) if (j !== i) for (const other of [0, 1]) {
      if (Math.hypot(point[0] - ends[j][other][0], point[1] - ends[j][other][1]) < tolerance) return [j, 1 - other];
    }
    return null;
  };
  const joins = new Map();
  walls.forEach((wall, i) => {
    if (isShort(i)) return;
    for (const end of [0, 1]) {
      const returns = [];
      let step = next(i, end);
      while (step && isShort(step[0]) && returns.length < walls.length) {returns.push(walls[step[0]].name); step = next(...step);}
      if (!step || !returns.length) continue;
      const pair = [wall.name, walls[step[0]].name].sort();
      joins.set(pair.join('|'), {ends: pair, returns});
    }
  });
  return [...joins.values()];
}

// A fixture with no recorded wall, such as a curtain on a ceiling track, belongs to the
// wall it hangs in front of: within reach of its inner face and overlapping it along the wall.
export function nearestWall(points, walls, reach = .35) {
  let best = null;
  for (const wall of walls) {
    const depth = points.map(p => p[0] * wall.n[0] + p[2] * wall.n[2] - wall.d);
    if (Math.min(...depth) < -.05 || Math.max(...depth) > reach) continue;
    const along = points.map(p => p[0] * wall.tangent[0] + p[2] * wall.tangent[2]);
    if (Math.min(wall.bounds[1][0], Math.max(...along)) <= Math.max(wall.bounds[0][0], Math.min(...along))) continue;
    if (!best || Math.max(...depth) < best.depth) best = {name: wall.name, depth: Math.max(...depth)};
  }
  return best?.name || null;
}

// World-space vertices; a rotated room inflates bounding boxes too much for nearestWall.
export function worldVertices(THREE, root) {
  const points = [];
  root.updateMatrixWorld(true);
  root.traverse(mesh => {
    const position = mesh.isMesh && mesh.geometry.attributes.position;
    for (let i = 0; position && i < position.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld).toArray());
  });
  return points;
}

// The near walls stay in the picture, see-through, with what hangs on them and the tall pieces
// that stand against them (a built-in wardrobe), instead of leaving those standing in the open. A
// see-through mesh casts and takes no shadow and writes no depth, so what is behind it shows, and the
// editor's picking passes through it (seeThrough). Opacity 0 hides it the same way: the lights treat
// it as they treat a see-through one, so hiding a wall does not let the sun in.
export const SEE_THROUGH = .08;
export function setSeeThrough(root, on, opacity = SEE_THROUGH) {
  const was = root.userData.seeThrough ? root.userData.seeThroughOpacity : null;
  if (was === (on ? opacity : null)) return false;
  if (was !== null && on) setSeeThrough(root, false);
  root.userData.seeThrough = on;
  if (on) root.userData.seeThroughOpacity = opacity; else delete root.userData.seeThroughOpacity;
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (on) {
      mesh.userData.solid = {material: mesh.material, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow};
      const faint = (material) => {
        const clone = Object.assign(material.clone(), {transparent: true, depthWrite: false,
          opacity: Math.min(material.opacity ?? 1, opacity)});
        // Glass with transmission shows the room behind from a small blurred render, in blocks:
        // as a faint layer over the room it would print a mosaic over everything seen through it.
        if ('transmission' in clone) clone.transmission = 0;
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(faint) : faint(mesh.material);
      // Nor take one: the shadow map's square texels on window glass would print over the room seen through it.
      mesh.castShadow = mesh.receiveShadow = false;
    } else if (mesh.userData.solid) {
      for (const material of [mesh.material].flat()) material.dispose();
      ({material: mesh.material, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow} = mesh.userData.solid);
      delete mesh.userData.solid;
    }
  });
  return true;
}
export function seeThrough(object) {
  for (let node = object; node; node = node.parent) if (node.userData?.seeThrough) return true;
  return false;
}

// A tall piece standing with its back to a wall: the side of its footprint nearest the wall lies
// within `reach` of the wall's inner face, it overlaps the wall along its length, and it is at
// least `height` tall above the floor. points: world corners of its box.
export function againstWall(points, wall, {reach = .2, height = 1.6, floor = 0} = {}) {
  const depth = points.map(p => p[0] * wall.n[0] + p[2] * wall.n[2] - wall.d);
  if (Math.min(...depth) < -.05 || Math.min(...depth) > reach) return false;
  const along = points.map(p => p[0] * wall.tangent[0] + p[2] * wall.tangent[2]);
  if (Math.min(wall.bounds[1][0], Math.max(...along)) <= Math.max(wall.bounds[0][0], Math.min(...along))) return false;
  return Math.max(...points.map(p => p[1])) - floor >= height;
}

// A tall piece in the half of the room nearer the camera blocks the view as a near wall would.
// center: its footprint's centre; view: from the room's centre towards the camera (horizontal).
// Once see-through it returns only `margin` past the middle, so orbiting does not flicker it.
export function inNearHalf(center, roomCenter, view, wasNear = false, margin = .1) {
  const length = Math.hypot(view[0], view[2]);
  if (!length) return false;
  const along = ((center[0] - roomCenter[0]) * view[0] + (center[2] - roomCenter[2]) * view[2]) / length;
  return wasNear ? along > -margin : along > margin;
}

// conceal(root, on) shows a near wall's part as hidden or see-through (default: hidden) and
// returns whether anything changed.
const hide = (root, on) => {
  if (root.visible === !on) return false;
  root.visible = !on;
  return true;
};
export function createWallVisibility(room, walls, {owner, joins: chains = deriveJoins(walls), conceal = hide}) {
  const parts = room.children.map(root => ({root, owner: owner(root.userData?.name || root.name)})).filter(part => part.owner);
  const names = new Set(walls.map(wall => wall.name));
  const joins = chains.filter(join => [...join.ends, ...join.returns].every(name => names.has(name)));
  let hidden = new Set();
  return {
    update(direction, {enabled = true, reveal = false, revealWalls = []} = {}) {
      hidden = enabled && !reveal ? hiddenWalls(walls, direction, hidden) : new Set();
      const revealed = revealWalls.filter(name => hidden.has(name));
      for (const name of revealWalls) hidden.delete(name);
      for (const join of joins) {
        const disconnected = join.ends.some(name => hidden.has(name));
        for (const name of join.returns) {
          if (disconnected) hidden.add(name);
          else hidden.delete(name);
        }
      }
      let changed = false;
      for (const {root, owner} of parts) if (conceal(root, hidden.has(owner))) changed = true;
      return {hidden: [...hidden].sort(), revealed, changed};
    },
  };
}
