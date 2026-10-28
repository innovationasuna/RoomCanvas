export const FORMAT = 'roomcanvas-layout';
export const VERSION = 3;

export function initialLayout(ids) {
  return Object.fromEntries(ids.map((id) => [id, {x: 0, y: 0, z: 0, yaw: 0}]));
}

export function copyLayout(layout) {
  return Object.fromEntries(Object.entries(layout).map(([id, value]) =>
    [id, {...value, y: value.y === undefined ? 0 : value.y}]));
}

export function sameLayout(a, b) {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((id) =>
    b[id] && (a[id].visible !== false) === (b[id].visible !== false) && ['x', 'y', 'z', 'yaw'].every((key) => {
      const left = key === 'y' && a[id][key] === undefined ? 0 : a[id][key];
      const right = key === 'y' && b[id][key] === undefined ? 0 : b[id][key];
      return Math.abs(left - right) < 1e-9;
    }));
}

export function encodeLayout(layout, scene) {
  return {format: FORMAT, version: VERSION, scene,
    objects: Object.entries(layout).map(([id, {x, y = 0, z, yaw, visible}]) =>
      ({id, x, y, z, yaw, ...(visible === false ? {visible: false} : {})}))};
}

// Validate the whole document before applying anything. This prevents partial imports.
export function decodeLayout(data, scene, ids) {
  if (!data || data.format !== FORMAT || ![1, 2, VERSION].includes(data.version) || data.scene !== scene) {
    throw new Error('这份布局不属于当前房间或版本不兼容');
  }
  if (!Array.isArray(data.objects) || data.objects.length !== ids.length) throw new Error('布局物品数量不匹配');
  const allowed = new Set(ids);
  const output = {};
  for (const item of data.objects) {
    if (!item || !allowed.has(item.id) || Object.hasOwn(output, item.id)) throw new Error('布局包含重复或未知物品');
    const coordinates = data.version === 1 ? ['x', 'z', 'yaw'] : ['x', 'y', 'z', 'yaw'];
    if (!coordinates.every((key) => typeof item[key] === 'number' && Number.isFinite(item[key]))) {
      throw new Error('布局中存在无效坐标');
    }
    const y = data.version === 1 ? 0 : item.y;
    if (Math.abs(item.x) > 1000 || Math.abs(y) > 1000 || Math.abs(item.z) > 1000 || Math.abs(item.yaw) > Math.PI + 1e-8) {
      throw new Error('布局坐标超出可用范围');
    }
    if (data.version === VERSION && item.visible !== undefined && typeof item.visible !== 'boolean') {
      throw new Error('布局中存在无效可见性');
    }
    output[item.id] = {x: item.x, y, z: item.z, yaw: item.yaw,
      ...(data.version === VERSION && item.visible === false ? {visible: false} : {})};
  }
  return output;
}

// Screen-right projected onto the floor is stable even in an exactly top-down view.
export function groundBasis(screenRight) {
  const length = Math.hypot(screenRight.x, screenRight.z);
  if (length < 1e-8) return {right: {x: 1, z: 0}, forward: {x: 0, z: -1}};
  const right = {x: screenRight.x / length, z: screenRight.z / length};
  return {right, forward: {x: right.z, z: -right.x}};
}

// On a wall, left/right are full-length tangential steps, with their sign chosen
// by the camera. Projecting a floor step onto the wall would shrink it near end-on views.
export function wallBasis(tangent, cameraBasis) {
  const length = Math.hypot(tangent[0], tangent[2]);
  if (length < 1e-8) return cameraBasis;
  const sign = tangent[0] * cameraBasis.right.x + tangent[2] * cameraBasis.right.z < 0 ? -1 : 1;
  return {...cameraBasis, right: {x: sign * tangent[0] / length, z: sign * tangent[2] / length}};
}

export function move(layout, id, direction, amount, basis) {
  if (!layout[id] || !Number.isFinite(amount) || amount <= 0) return;
  const item = layout[id];
  // Three.js uses Y as its vertical axis; X/Z remain the camera-relative floor plane.
  if (['up', 'down'].includes(direction)) {
    const y = item.y === undefined ? 0 : item.y;
    item.y = Math.max(-1000, Math.min(1000, y + (direction === 'up' ? amount : -amount)));
    return;
  }
  if (!['forward', 'back', 'left', 'right'].includes(direction)) return;
  const axis = ['forward', 'back'].includes(direction) ? basis.forward : basis.right;
  const sign = ['back', 'left'].includes(direction) ? -1 : 1;
  item.x = Math.max(-1000, Math.min(1000, item.x + sign * amount * axis.x));
  item.z = Math.max(-1000, Math.min(1000, item.z + sign * amount * axis.z));
}

export function rotate(layout, id, angle) {
  if (!layout[id]) return;
  const yaw = layout[id].yaw + angle;
  layout[id].yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

export class History {
  constructor(limit = 100) { this.past = []; this.future = []; this.limit = limit; }
  commit(before, after) {
    if (sameLayout(before, after)) return false;
    this.past.push(copyLayout(before));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    return true;
  }
  undo(current) {
    if (!this.past.length) return null;
    this.future.push(copyLayout(current));
    return this.past.pop();
  }
  redo(current) {
    if (!this.future.length) return null;
    this.past.push(copyLayout(current));
    return this.future.pop();
  }
}
