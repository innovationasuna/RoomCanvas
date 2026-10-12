import type { Hand, Point } from '../shared/types';
import { CONFIG } from '../shared/config';
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export function features(hand: Hand, aspect = 4 / 3) {
  const p = hand.landmarks;
  const normalized = p.map(v => ({ x: v.x * aspect, y: v.y, z: v.z * aspect }));
  const n = normalized;
  const scale = (distance(n[0], n[5]) + distance(n[0], n[9]) + distance(n[0], n[17])) / 3;
  // Projected palm scale deliberately excludes inferred local Z.
  const projected = (i: number) => Math.hypot(n[i].x - n[0].x, n[i].y - n[0].y);
  const palmScale = (projected(5) + projected(9) + projected(17)) / 3;
  const w = hand.world.length === 21 ? hand.world : n;
  const a = { x: w[5].x - w[0].x, y: w[5].y - w[0].y, z: w[5].z - w[0].z };
  const b = { x: w[17].x - w[0].x, y: w[17].y - w[0].y, z: w[17].z - w[0].z };
  const cross = { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
  const facing = Math.abs(cross.z) / Math.max(1e-6, Math.hypot(cross.x, cross.y, cross.z));
  const extended = [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => distance(n[tip], n[0]) > distance(n[pip], n[0]) * 1.15);
  return {
    pointer: { x: 1 - (p[4].x + p[8].x) / 2, y: (p[4].y + p[8].y) / 2 },
    fingertips: { thumb: { x: 1 - p[4].x, y: p[4].y }, index: { x: 1 - p[8].x, y: p[8].y } },
    wrist: { x: p[0].x, y: p[0].y }, palmScale,
    pinchRatio: distance(n[4], n[8]) / Math.max(1e-6, scale),
    openPalm: extended && distance(n[4], n[8]) / Math.max(1e-6, scale) > 0.5,
    // 四指都向掌心收拢才算握拳，普通两指捏合不算。
    closedFist: [[8, 6], [12, 10], [16, 14], [20, 18]].every(([tip, pip]) => distance(n[tip], n[0]) < distance(n[pip], n[0]) * 0.95),
    frontFacing: facing >= CONFIG.minFacing,
  };
}
