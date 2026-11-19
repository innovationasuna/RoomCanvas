// Preserve Math.min/max semantics for empty and non-finite input without spreading a mesh onto the call stack.
export function extent(values, project) {
  let low = Infinity, high = -Infinity;
  for (const item of values) {
    const value = project(item);
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return [low, high];
}

export function bounds2d(points) {
  const [left, right] = extent(points, p => p[0]);
  const [bottom, top] = extent(points, p => p[1]);
  return [[left, bottom], [right, top]];
}
