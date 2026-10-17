import type { Point, Transform } from '../shared/types';
import { CONFIG, clamp } from '../shared/config';
export const copyTransform = (t: Transform): Transform => ({ position: { ...t.position }, rotation: t.rotation, scale: t.scale });
export function constrainFurniture(t: Transform, size: Point): Transform {
  const result = copyTransform(t);
  const c = Math.abs(Math.cos(t.rotation)), s = Math.abs(Math.sin(t.rotation));
  const hx = (c * size.x + s * size.z) * t.scale / 2;
  const hz = (s * size.x + c * size.z) * t.scale / 2;
  result.position.x = clamp(t.position.x, -CONFIG.room.width / 2 + hx, CONFIG.room.width / 2 - hx);
  result.position.z = clamp(t.position.z, -CONFIG.room.depth / 2 + hz, CONFIG.room.depth / 2 - hz);
  result.position.y = clamp(t.position.y, 0, Math.max(0, CONFIG.room.height - size.y * t.scale));
  return result;
}
export function mapXYZ(base: Point, dx: number, dy: number, scaleRatio: number, axes: {right:Point; up:Point; forward:Point}): Point {
  const depth = CONFIG.depthGain * Math.log(clamp(scaleRatio, 1 / CONFIG.maxDepthRatio, CONFIG.maxDepthRatio));
  const result = { ...base };
  for (const axis of ['x', 'y', 'z'] as const) result[axis] += CONFIG.xyGain * dx * axes.right[axis] - CONFIG.xyGain * dy * axes.up[axis] - depth * axes.forward[axis];
  return { x: clamp(result.x, -2.5, 2.5), y: clamp(result.y, 0.15, 2.8), z: clamp(result.z, -2, 2) };
}
