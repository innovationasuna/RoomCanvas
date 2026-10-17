import type { Hand, HandSignal, GestureFrame, TrackingFrame, Pointer, Side } from '../shared/types';
import { CONFIG } from '../shared/config';
import { OneEuroFilter } from '../shared/filter';
import { features } from './features';

export class PinchLatch {
  active = false;
  private pending?: number;
  private desired = false;
  blocked = false;
  update(ratio: number, time: number) {
    let started = false, ended = false;
    if (this.blocked) {
      if (ratio >= CONFIG.pinchExit) { this.blocked = false; this.active = false; this.pending = undefined; }
      return { pinching: false, started, ended, releasing: false };
    }
    const desired = this.active ? ratio < CONFIG.pinchExit : ratio < CONFIG.pinchEnter;
    const releasing = this.active && !desired;
    if (desired === this.active) this.pending = undefined;
    else if (this.pending === undefined || desired !== this.desired) { this.pending = time; this.desired = desired; }
    else if (time - this.pending >= (desired ? CONFIG.confirmMs : CONFIG.releaseConfirmMs)) {
      this.active = desired; this.pending = undefined; started = desired; ended = !desired;
    }
    return { pinching: this.active, started, ended, releasing };
  }
  interrupt() { this.active = false; this.pending = undefined; this.blocked = true; }
}

class SignalTracker {
  latch = new PinchLatch();
  filters = [new OneEuroFilter(), new OneEuroFilter(), new OneEuroFilter(1, 0.01)];
  wrist?: Pointer;
  private stable?: { pointer: Pointer; palmScale: number };
  update(hand: Hand, time: number, aspect: number): HandSignal {
    const f = features(hand, aspect);
    this.wrist = f.wrist;
    const pinch = this.latch.update(f.pinchRatio, time);
    // 松开的第一帧就冻结，张开动作也不能进入滤波器形成后续漂移。
    const motion = pinch.releasing && this.stable ? this.stable : {
      pointer: { x: this.filters[0].update(f.pointer.x, time), y: this.filters[1].update(f.pointer.y, time) },
      palmScale: this.filters[2].update(f.palmScale, time),
    };
    this.stable = motion;
    const pointer = motion.pointer;
    // Translate the pair with the filtered midpoint so the guide matches the actual control cursor.
    const offset = { x: pointer.x - f.pointer.x, y: pointer.y - f.pointer.y };
    const tip = (p: Pointer) => ({ x: p.x + offset.x, y: p.y + offset.y });
    return { ...f, pointer, fingertips: { thumb: tip(f.fingertips.thumb), index: tip(f.fingertips.index) },
      palmScale: motion.palmScale, ...pinch };
  }
  reset() { this.wrist = undefined; this.stable = undefined; this.filters.forEach(f => f.reset()); this.latch.interrupt(); }
}

function selectHand(valid:Hand[],side:Side,tracker:SignalTracker):{hand?:Hand;ambiguous:boolean}{
  const candidates=valid.filter(h=>h.side===side);
  if(candidates.length>1)return {ambiguous:true};
  if(tracker.latch.active&&tracker.wrist){
    const wrist=tracker.wrist;
    const ranked=valid.map(h=>({h,d:Math.hypot(h.landmarks[0].x-wrist.x,h.landmarks[0].y-wrist.y)})).sort((a,b)=>a.d-b.d);
    const ambiguous=ranked.length>1&&Math.abs(ranked[0].d-ranked[1].d)<0.045;
    const nearest=ranked[0];
    return {ambiguous,hand:!ambiguous&&nearest?.d<CONFIG.identityRadius&&nearest.h.side===side&&nearest.h.score>=CONFIG.operatorScore?nearest.h:undefined};
  }
  return {ambiguous:false,hand:candidates.find(h=>h.score>=CONFIG.operatorScore)};
}

export class GestureEngine {
  private operator = new SignalTracker();
  private helper = new SignalTracker();
  private missingSince?: number;
  private helperMissingSince?: number;
  private interrupted = false;
  private palmSince?: number;
  private fistSince?: number;
  private closeArmed = true;
  private menuArmed = true;
  reset() { this.operator.reset(); this.helper.reset(); this.palmSince = undefined; this.fistSince = undefined; this.closeArmed = true; this.missingSince = undefined; this.helperMissingSince = undefined; this.interrupted = false; }
  process(frame: TrackingFrame, aspect = 4 / 3): GestureFrame {
    const valid = frame.hands.filter(h => h.score >= CONFIG.minimumScore && h.landmarks.length === 21 && h.landmarks.every(p => Number.isFinite(p.x + p.y + p.z)));
    // Identity proximity can reject a candidate, but must never override the right-hand requirement.
    const {hand:op,ambiguous}=selectHand(valid,'Right',this.operator);
    const {hand:help}=selectHand(valid,'Left',this.helper);
    let interrupted = false, helperInterrupted = false;
    if (!op) {
      this.missingSince ??= frame.timestamp;
      if (frame.timestamp - this.missingSince >= CONFIG.lossMs && !this.interrupted) {
        this.operator.reset(); this.interrupted = true; interrupted = true;
      }
    } else {
      // A long gap can arrive without intermediate empty frames (background tab / stalled inference).
      if (this.missingSince !== undefined && frame.timestamp - this.missingSince >= CONFIG.lossMs && !this.interrupted) {
        this.operator.reset(); interrupted = true;
      }
      this.missingSince = undefined; this.interrupted = false;
    }
    if (!help) this.helperMissingSince ??= frame.timestamp;
    if (this.helperMissingSince !== undefined && frame.timestamp - this.helperMissingSince >= CONFIG.lossMs) {
      if (this.helper.latch.active) helperInterrupted = true;
      this.helper.reset();
    }
    if (help) this.helperMissingSince = undefined;
    const operator = op ? this.operator.update(op, frame.timestamp, aspect) : undefined;
    const helper = help ? this.helper.update(help, frame.timestamp, aspect) : undefined;
    let menuRequested = false;
    if (helper?.openPalm && !helper.pinching && !operator?.pinching) {
      this.palmSince ??= frame.timestamp;
      if (this.menuArmed && frame.timestamp - this.palmSince >= CONFIG.menuHoldMs) { menuRequested = true; this.menuArmed = false; }
    } else { this.palmSince = undefined; this.menuArmed = true; }
    let menuCloseRequested = false;
    if (helper?.closedFist) {
      this.fistSince ??= frame.timestamp;
      if (this.closeArmed && frame.timestamp - this.fistSince >= CONFIG.menuCloseHoldMs) { menuCloseRequested = true; this.closeArmed = false; }
    } else { this.fistSince = undefined; this.closeArmed = true; }
    return { timestamp: frame.timestamp, operator, helper, menuRequested, menuCloseRequested, interrupted, helperInterrupted, ambiguous };
  }
}
