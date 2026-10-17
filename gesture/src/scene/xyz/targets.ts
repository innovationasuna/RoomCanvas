import type { Point } from '../../shared/types';
export const TARGETS: Point[] = [
  {x:-1,y:1.2,z:-0.9},{x:1,y:1.6,z:0.8},{x:-0.6,y:0.6,z:1.4},{x:0.6,y:2.1,z:-1.2},
  {x:1.6,y:0.8,z:-0.3},{x:-1.7,y:1.8,z:0.5},{x:0.3,y:1.3,z:1.6},{x:-0.3,y:2.3,z:-1.4},
  {x:1.3,y:1.1,z:-1.5},{x:-1.1,y:0.7,z:0.4},{x:0.8,y:2.2,z:0.9},{x:-1.5,y:1.5,z:-0.7},
  {x:0.2,y:0.5,z:-1.2},{x:1.7,y:1.9,z:0.2},{x:-0.7,y:1.2,z:1.7},{x:1,y:0.7,z:1.2},
  {x:-1.6,y:2.1,z:-1.2},{x:0.5,y:1.7,z:-0.6},{x:-0.4,y:0.9,z:0.9},{x:1.5,y:1.5,z:1.4},
];
export class TargetTask {
  index = 0;
  progress = 0;
  distance = 0;
  times: number[] = [];
  private insideSince?: number;
  private began?: number;
  get complete() { return this.index >= TARGETS.length; }
  update(position: Point, now: number, running: boolean) {
    if (this.complete) return;
    const target = TARGETS[this.index];
    this.distance = Math.hypot(position.x-target.x, position.y-target.y, position.z-target.z);
    if (!running) { this.insideSince = undefined; this.progress = 0; return; }
    this.began ??= now;
    if (this.distance <= 0.1) {
      this.insideSince ??= now; this.progress = Math.min(1, (now-this.insideSince)/1000);
      if (this.progress >= 1) { this.times.push((now-this.began)/1000); this.index++; this.began = now; this.insideSince = undefined; this.progress = 0; }
    } else { this.insideSince = undefined; this.progress = 0; }
  }
  reset() { this.index=0; this.progress=0; this.times=[]; this.began=undefined; this.insideSince=undefined; }
}
