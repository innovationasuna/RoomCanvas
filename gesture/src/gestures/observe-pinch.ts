import type { HandSignal, TrackingFrame } from '../shared/types';
import { CONFIG } from '../shared/config';
import { OneEuroFilter } from '../shared/filter';
import { PinchLatch } from './engine';
import { features } from './features';
import { validHand } from './number-mode';

export type ObservationAction = 'orbit' | 'pan';
export interface ObservationSignal extends HandSignal { action: ObservationAction }
export class ObservationRecognizer {
  private latch = new PinchLatch();
  private action: ObservationAction | null = null;
  private needsOpen = true;
  private filters = [new OneEuroFilter(), new OneEuroFilter()];
  private stable?: { x: number; y: number };
  private wrist?: { x: number; y: number };
  private missingSince: number | null = null;
  private lastTime: number | null = null;
  reset() {
    this.latch.interrupt(); this.action = null; this.needsOpen = true;
    this.filters.forEach(f => f.reset()); this.stable = undefined; this.wrist = undefined;
    this.missingSince = null; this.lastTime = null;
  }
  process(frame: TrackingFrame, aspect = 4 / 3): { operator?: ObservationSignal; interrupted: boolean } {
    const valid = frame.hands.filter(validHand);
    const candidates = frame.hands.filter(h => h.side === 'Right');
    let right = candidates.length === 1 && validHand(candidates[0]) ? candidates[0] : undefined;
    if (right && this.latch.active && this.wrist) {
      const ranked = valid.map(h => ({ hand: h, distance: Math.hypot(h.landmarks[0].x - this.wrist!.x, h.landmarks[0].y - this.wrist!.y) })).sort((a,b) => a.distance-b.distance);
      if (!ranked[0] || ranked[0].hand !== right || ranked[0].distance >= CONFIG.identityRadius ||
        (ranked[1] && Math.abs(ranked[1].distance-ranked[0].distance) < .045)) right = undefined;
    }
    const gap = this.lastTime !== null && frame.timestamp - this.lastTime >= CONFIG.lossMs;
    this.lastTime = frame.timestamp;
    if (!right) {
      this.missingSince ??= frame.timestamp;
      if (gap || frame.timestamp - this.missingSince >= CONFIG.lossMs) { this.reset(); return { interrupted: true }; }
      return { interrupted: false };
    }
    if (gap || (this.missingSince !== null && frame.timestamp-this.missingSince >= CONFIG.lossMs)) {
      this.reset(); return { interrupted: true };
    }
    this.missingSince = null; this.wrist = right.landmarks[0];
    const f = features(right, aspect);
    const points = right.landmarks.map(p => ({ x: p.x*aspect, y:p.y, z:p.z*aspect }));
    const dist = (a:number,b:number) => Math.hypot(points[a].x-points[b].x,points[a].y-points[b].y,points[a].z-points[b].z);
    const scale = (dist(0,5)+dist(0,9)+dist(0,17))/3;
    const triple = Math.max(dist(4,8),dist(4,12),dist(8,12))/Math.max(1e-6,scale);
    if (this.needsOpen) {
      if (f.pinchRatio >= CONFIG.pinchExit) { this.needsOpen=false; this.latch.update(f.pinchRatio,frame.timestamp); }
    } else if (!this.action && f.pinchRatio < CONFIG.pinchEnter) {
      this.action = triple < CONFIG.pinchEnter ? 'pan' : 'orbit';
    }
    const action = this.action ?? 'orbit';
    const ratio = this.needsOpen ? Math.max(f.pinchRatio,CONFIG.pinchExit) : action==='pan' ? triple : f.pinchRatio;
    const pinch = this.latch.update(ratio,frame.timestamp);
    const pointer = pinch.releasing && this.stable ? this.stable : {
      x:this.filters[0].update(f.pointer.x,frame.timestamp),y:this.filters[1].update(f.pointer.y,frame.timestamp),
    };
    this.stable = pointer;
    if (pinch.ended) { this.action=null; this.needsOpen=true; this.latch.interrupt(); }
    if (!pinch.pinching && !pinch.releasing && f.pinchRatio >= CONFIG.pinchExit) this.action=null;
    return { interrupted:false, operator:{ ...f, ...pinch, pointer, action } };
  }
}
