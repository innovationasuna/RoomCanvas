// Collision metadata stays numeric. Queries retain the original triangle/point
// arrays; face IDs always refer to their original triangle positions.
const STRIDE = 10; // bounding box (6), unit plane normal (3), plane distance (1)

function partitionFaces(data, faces, start, end, mid, axis) {
  const center = face => data[face * STRIDE + axis] + data[face * STRIDE + axis + 3];
  let low = start, high = end - 1, budget = 4 * (end - start);
  while (low < high) {
    budget -= high - low + 1;
    if (budget < 0) {
      const sorted = faces.slice(low, high + 1).sort((a, b) => center(a) - center(b));
      for (let i = 0; i < sorted.length; i++) faces[low + i] = sorted[i];
      return;
    }
    const pivot = center(faces[(low + high) >> 1]);
    let left = low, right = high;
    while (left <= right) {
      while (center(faces[left]) < pivot) left++;
      while (center(faces[right]) > pivot) right--;
      if (left <= right) {
        const face = faces[left]; faces[left] = faces[right]; faces[right] = face;
        left++; right--;
      }
    }
    if (mid <= right) high = right;
    else if (mid >= left) low = left;
    else return;
  }
}

// Balanced split sizes determine the node count without examining geometry.
// Allocate exactly once, rather than retaining spare capacity or node objects.
function countNodes(size) {
  if (size <= 10) return 1;
  const half = size >> 1;
  return 1 + countNodes(half) + countNodes(size - half);
}

export function makeTriangleTree(data, faces) {
  if (!faces.length) return null;
  const count = countNodes(faces.length), boxes = new Float64Array(count * 6);
  const links = new Uint32Array(count * 4), order = new Uint32Array(faces.length);
  let nextNode = 0;
  function build(items, start, end, root = false) {
    const node = nextNode++, box = node * 6, link = node * 4;
    boxes[box] = boxes[box + 1] = boxes[box + 2] = Infinity;
    boxes[box + 3] = boxes[box + 4] = boxes[box + 5] = -Infinity;
    for (let i = start; i < end; i++) {
      const face = items[i] * STRIDE;
      for (let k = 0; k < 3; k++) {
        if (data[face + k] < boxes[box + k]) boxes[box + k] = data[face + k];
        if (data[face + k + 3] > boxes[box + k + 3]) boxes[box + k + 3] = data[face + k + 3];
      }
    }
    if (end - start <= 10) {
      links[link + 2] = start; links[link + 3] = end - start;
      for (let i = start; i < end; i++) order[i] = items[i];
      return node;
    }
    let axis = 0;
    for (let k = 1; k < 3; k++) {
      if (boxes[box + k + 3] - boxes[box + k] > boxes[box + axis + 3] - boxes[box + axis]) axis = k;
    }
    const mid = (start + end) >> 1;
    if (root) {
      // Keep Array.sort and the original arithmetic order: floating-point ties
      // affect the representative piece plane and the shared-edge ray result.
      items.sort((a, b) => {
        const x = a * STRIDE + axis, y = b * STRIDE + axis;
        return data[x] + data[x + 3] - data[y] - data[y + 3];
      });
      items = items.slice();
    } else partitionFaces(data, items, start, end, mid, axis);
    links[link] = build(items, start, mid);
    links[link + 1] = build(items, mid, end);
    return node;
  }
  build(faces, 0, faces.length, true);
  return {box: Array.from(boxes.subarray(0, 6)), boxes, links, order};
}

export function buildTriangleIndex(triangles) {
  const data = new Float64Array(triangles.length * STRIDE), faces = [];
  for (let face = 0; face < triangles.length; face++) {
    const triangle = triangles[face], [a, b, c] = triangle;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz <= 1e-20) continue;
    const length = Math.hypot(nx, ny, nz), px = nx / length, py = ny / length, pz = nz / length;
    const offset = face * STRIDE;
    data[offset] = data[offset + 1] = data[offset + 2] = Infinity;
    data[offset + 3] = data[offset + 4] = data[offset + 5] = -Infinity;
    for (const point of triangle) for (let k = 0; k < 3; k++) {
      data[offset + k] = Math.min(data[offset + k], point[k]);
      data[offset + k + 3] = Math.max(data[offset + k + 3], point[k]);
    }
    data[offset + 6] = px; data[offset + 7] = py; data[offset + 8] = pz;
    data[offset + 9] = px * a[0] + py * a[1] + pz * a[2];
    faces.push(face);
  }
  const tree = makeTriangleTree(data, faces);
  return {triangles, data, faces: new Uint32Array(faces), tree};
}

export function nodeBox(tree, node) {
  return tree.boxes.subarray(node * 6, node * 6 + 6);
}

export function nodeFaces(tree, node) {
  const offset = node * 4, count = tree.links[offset + 3];
  return count ? tree.order.subarray(tree.links[offset + 2], tree.links[offset + 2] + count) : null;
}

// For narrow-phase operations that still take array vectors. Callers may keep a
// query-local cache by face ID; this module never retains decoded face objects.
export function readFace(index, face) {
  const data = index.data, offset = face * STRIDE;
  return {triangle: index.triangles[face], faceIndex: face,
    box: [data[offset], data[offset + 1], data[offset + 2], data[offset + 3], data[offset + 4], data[offset + 5]],
    plane: [data[offset + 6], data[offset + 7], data[offset + 8]], d: data[offset + 9]};
}
