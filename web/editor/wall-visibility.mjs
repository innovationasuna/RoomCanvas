// Walls carry inward normals. Hide exterior-facing and nearly edge-on walls,
// including their attached openings. Visibility never changes collision/support.
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

export function createWallVisibility(room, walls, {owner, joins: chains = deriveJoins(walls)}) {
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
      for (const {root, owner} of parts) {
        const visible = !hidden.has(owner);
        if (root.visible !== visible) {root.visible = visible; changed = true;}
      }
      return {hidden: [...hidden].sort(), revealed, changed};
    },
  };
}
