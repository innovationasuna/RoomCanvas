// Parts that open: doors, cabinet doors, window sashes, a desk top that lifts. They come from the
// room's room_objects.json `joints` (web/scripts/room_objects.py, from the reconstruction's URDFs).
// A part's own origin sits on its joint; what rests on it moves with it (ridersOf). Its parent (a carcass, a door frame) may be rotated and
// stretched to the scanned size, so a hinge swings the part rigidly in the world; turning it inside
// that stretched frame would shear it.
export const OPEN_MS = 450;

// The joint value of the open part: the far end of its range.
export const openValue = ({lower, upper}) => Math.abs(upper) >= Math.abs(lower) ? upper : lower;

export const ease = (t) => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

// The part's local matrix at `value` (radians for a hinge, metres in the parent's frame for a slide).
// rest: its local matrix when closed; parentWorld: its parent's world matrix now.
export function jointMatrix(THREE, joint, rest, parentWorld, value) {
  const axis = new THREE.Vector3().fromArray(joint.axis);
  if (joint.type === 'prismatic') return rest.clone().premultiply(new THREE.Matrix4().makeTranslation(axis.multiplyScalar(value)));
  const hinge = new THREE.Vector3().setFromMatrixPosition(rest).applyMatrix4(parentWorld);
  axis.transformDirection(parentWorld);
  const swing = new THREE.Matrix4().makeTranslation(hinge)
    .multiply(new THREE.Matrix4().makeRotationAxis(axis, value))
    .multiply(new THREE.Matrix4().makeTranslation(hinge.clone().negate()));
  return parentWorld.clone().invert().multiply(swing).multiply(parentWorld.clone().multiply(rest));
}

// What rides on a part: pieces whose underside rests on it (a monitor on a desk top that lifts,
// scores on a piano lid). The reconstruction only records that they rest on the desk or the piano,
// not on which part, so it is found from the shapes, once, with everything closed: a ray straight
// down from just above the bottom of each piece's box meets the part within `reach`.
// candidates: the other pieces of the part's group; ones above or inside the part are skipped.
export function ridersOf(THREE, node, candidates, reach = .06) {
  node.updateWorldMatrix(true, true);
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), lift = .02;
  const related = (a, b) => {for (let n = b; n; n = n.parent) if (n === a) return true; return false;};
  const resting = candidates.filter((piece) => {
    if (related(piece, node) || related(node, piece)) return false;
    const box = new THREE.Box3().setFromObject(piece);
    if (box.isEmpty()) return false;
    const center = box.getCenter(new THREE.Vector3());
    ray.set(new THREE.Vector3(center.x, box.min.y + lift, center.z), down);
    ray.far = reach + lift;
    return ray.intersectObject(node, true).length > 0;
  });
  // A book lying on a sheet that also rests there already moves with the sheet.
  return resting.filter((piece) => !resting.some((other) => other !== piece && related(other, piece)));
}

// Animates parts between closed and open. parts: {joint, node, rest, value, riders?}; render()
// redraws. A part carries its riders ([{node, rest}]): they move rigidly with it in the world.
export class Openings {
  constructor(THREE, parts, {render, settled = () => {}, clock = performance, frame = (step) => requestAnimationFrame(step)} = {}) {
    Object.assign(this, {THREE, parts, render, settled, clock, frame});
    this.moving = new Map();
    for (const part of parts) {
      part.node.userData.openable = part;
      part.value = 0;
      part.riders ||= [];
    }
  }
  isOpen(part) {return (this.moving.get(part)?.to ?? part.value) !== 0;}
  toggle(part) {this.move(part, this.isOpen(part) ? 0 : openValue(part.joint));}
  move(part, to) {
    this.moving.set(part, {from: part.value, to, start: this.clock.now()});
    if (this.moving.size === 1) this.frame(this.step);
  }
  step = () => {
    const now = this.clock.now();
    for (const [part, {from, to, start}] of this.moving) {
      const t = Math.min(1, (now - start) / OPEN_MS);
      this.set(part, from + (to - from) * ease(t));
      if (t === 1) this.moving.delete(part);
    }
    this.render();
    if (this.moving.size) this.frame(this.step); else this.settled();
  };
  set(part, value) {
    const {node} = part;
    part.value = value;
    if (value === 0) {
      node.matrix.copy(part.rest); node.matrix.decompose(node.position, node.quaternion, node.scale);
      node.matrixAutoUpdate = true;
    } else {
      node.parent.updateWorldMatrix(true, false);
      node.matrixAutoUpdate = false;
      node.matrix.copy(jointMatrix(this.THREE, part.joint, part.rest, node.parent.matrixWorld, value));
    }
    node.matrixWorldNeedsUpdate = true;
    // The part's move in the world, applied to what rides on it.
    const parent = node.parent.matrixWorld;
    const move = parent.clone().multiply(node.matrix).multiply(parent.clone().multiply(part.rest).invert());
    for (const rider of part.riders) {
      const piece = rider.node;
      if (value === 0) {
        piece.matrix.copy(rider.rest); piece.matrix.decompose(piece.position, piece.quaternion, piece.scale);
        piece.matrixAutoUpdate = true;
      } else {
        piece.parent.updateWorldMatrix(true, false);
        const world = piece.parent.matrixWorld;
        piece.matrixAutoUpdate = false;
        piece.matrix.copy(world.clone().invert().multiply(move).multiply(world.clone().multiply(rider.rest)));
      }
      piece.matrixWorldNeedsUpdate = true;
    }
  }
  // Everything shut at once, before furniture is moved (collision uses the closed shapes).
  closeAll() {
    const open = this.parts.filter((part) => part.value !== 0 || this.moving.has(part));
    this.moving.clear();
    for (const part of open) this.set(part, 0);
    if (open.length) {this.render(); this.settled();}
  }
}

// The part a ray hit belongs to, if it opens.
export function openableOf(object) {
  for (let node = object; node; node = node.parent) if (node.userData?.openable) return node.userData.openable;
  return null;
}
