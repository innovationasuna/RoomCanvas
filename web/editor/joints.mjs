// Parts that open: doors, cabinet doors, window sashes, a desk top that lifts. They come from the
// room's room_objects.json `joints` (web/scripts/room_objects.py, from the reconstruction's URDFs).
// A part's own origin sits on its joint. Its parent (a carcass, a door frame) may be rotated and
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

// Animates parts between closed and open. parts: {joint, node, rest, value}; render() redraws.
export class Openings {
  constructor(THREE, parts, {render, settled = () => {}, clock = performance, frame = (step) => requestAnimationFrame(step)} = {}) {
    Object.assign(this, {THREE, parts, render, settled, clock, frame});
    this.moving = new Map();
    for (const part of parts) {
      part.node.userData.openable = part;
      part.value = 0;
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
