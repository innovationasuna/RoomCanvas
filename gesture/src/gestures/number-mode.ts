import type { Hand, TrackingFrame } from '../shared/types';
import { CONFIG } from '../shared/config';

export const NUMBER_CONFIG = { holdMs: 400, neutralMs: 150, lossMs: 200 } as const;
export type NumberMode = 1 | 2 | 3 | 4;
export const NUMBER_MODES = {1:'move', 2:'height', 3:'scale', 4:'rotate'} as const;
export const NUMBER_LABELS = {1:'平面移动', 2:'上下移动', 3:'双手缩放', 4:'连续旋转'} as const;
export interface NumberFeedback {
  detected: boolean; digit: NumberMode | null; progress: number;
  phase: 'missing' | 'uncertain' | 'ambiguous' | 'pose' | 'neutral' | 'blocked' | 'confirming' | 'selected';
}
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
export function validHand(hand: Hand) {
  return hand.score >= CONFIG.operatorScore && hand.landmarks.length === 21 &&
    hand.landmarks.every(p => Number.isFinite(p.x + p.y + p.z));
}
export function classifyLeftNumber(hand: Hand, aspect = 4 / 3): NumberMode | null {
  if (hand.side !== 'Left' || !validHand(hand)) return null;
  const p = hand.landmarks.map(v => [v.x * aspect, v.y, v.z * aspect]);
  const palm = distance(p[0], p[9]);
  if (palm < 1e-5) return null;
  const states = [5, 9, 13, 17].map(mcp => {
    const pip = mcp + 1, dip = mcp + 2, tip = mcp + 3;
    const cosine = (a: number[], b: number[]) => {
      const lengths = Math.hypot(...a)*Math.hypot(...b);
      return lengths < palm*palm*.001 ? null : a.reduce((sum,n,i)=>sum+n*b[i],0)/lengths;
    };
    const proximal = p[pip].map((n,i)=>n-p[mcp][i]);
    const middle = p[dip].map((n,i)=>n-p[pip][i]);
    const distal = p[tip].map((n,i)=>n-p[dip][i]);
    const pipAngle = cosine(proximal,middle), dipAngle = cosine(middle,distal);
    if (pipAngle === null || dipAngle === null) return null;
    const reach = distance(p[tip], p[0]) / Math.max(1e-5, distance(p[pip], p[0]));
    if (pipAngle > .55 && dipAngle > .55 && reach > 1.10) return true;
    // A finger can fold at PIP while its last two segments remain straight.
    // Do not require a sharply bent fingertip to recognize a naturally closed finger.
    if (reach < .98 || ((pipAngle < .45 || dipAngle < .35) && reach < 1.08)) return false;
    return null;
  });
  // 用户使用的「3」：中、无名、小指伸直，拇指与弯曲食指成圈。
  // 成圈时食指可能处在弯曲阈值间，不能先以“不确定手指”丢弃。
  const circleThree = states[0] !== true && states.slice(1).every(v => v === true) &&
    distance(p[4], p[8]) / palm < CONFIG.pinchEnter;
  if (circleThree) return 3;
  if (states.some(v => v === null)) return null;
  const pattern = states.map(v => v ? '1' : '0').join('');
  // 四指伸直时，拇指收进掌心才是数字 4；普通张掌仍用于解除中断保护。
  const thumbFolded = distance(p[4], p[9]) / palm < .8;
  return pattern === '1000' ? 1 : pattern === '1100' ? 2 : pattern === '1110' ? 3 :
    pattern === '1111' && thumbFolded ? 4 : null;
}

// One event per stable pose. Busy/lost tracking requires a neutral pose before rearming.
export class NumberModeSelector {
  private feedback: NumberFeedback = { detected:false,digit:null,progress:0,phase:'missing' };
  get state(): NumberFeedback { return { ...this.feedback }; }
  private pending: NumberMode | null = null;
  private lastDigit: NumberMode | null = null;
  private since = 0;
  private neutralSince: number | null = null;
  private armed = true;
  private lastSeen: number | null = null;
  private wrist: { x: number; y: number } | null = null;
  reset(requireNeutral = true) {
    this.pending = null; this.lastDigit = null; this.neutralSince = null; this.armed = !requireNeutral;
    this.lastSeen = null; this.wrist = null;
    this.feedback = { detected:false,digit:null,progress:0,phase:'missing' };
  }
  process(frame: TrackingFrame, aspect: number, allowed: boolean): NumberMode | null {
    const candidates = frame.hands.filter(h => h.side === 'Left');
    const left = candidates.length === 1 && validHand(candidates[0]) ? candidates[0] : undefined;
    if (!allowed) { this.pending = null; this.neutralSince = null; this.armed = false; }
    if (!left) {
      this.feedback = { detected:false,digit:null,progress:0,phase:candidates.length>1?'ambiguous':candidates.length?'uncertain':'missing' };
      this.pending = null; this.neutralSince = null;
      if (this.lastSeen !== null && frame.timestamp - this.lastSeen >= NUMBER_CONFIG.lossMs) this.armed = false;
      return null;
    }
    if (this.lastSeen !== null && frame.timestamp - this.lastSeen >= NUMBER_CONFIG.lossMs) this.armed = false;
    const wrist = left.landmarks[0];
    if (this.wrist && Math.hypot(wrist.x - this.wrist.x, wrist.y - this.wrist.y) > CONFIG.identityRadius) {
      this.armed = false; this.pending = null;
    }
    this.wrist = wrist; this.lastSeen = frame.timestamp;
    const digit = classifyLeftNumber(left, aspect);
    if (!allowed) { this.feedback={detected:true,digit,progress:0,phase:'blocked'}; return null; }
    if (digit === null) {
      this.feedback={detected:true,digit:null,progress:0,phase:'pose'};
      this.pending = null; this.neutralSince ??= frame.timestamp;
      if (frame.timestamp - this.neutralSince >= NUMBER_CONFIG.neutralMs) { this.armed = true; this.lastDigit = null; }
      return null;
    }
    this.neutralSince = null;
    if (!this.armed) { this.pending=null;this.feedback={detected:true,digit,progress:0,phase:'neutral'};return null; }
    if (digit === this.lastDigit) { this.pending=null;this.feedback={detected:true,digit,progress:1,phase:'selected'};return null; }
    if (digit !== this.pending) { this.pending = digit; this.since = frame.timestamp; this.feedback={detected:true,digit,progress:0,phase:'confirming'}; return null; }
    this.feedback={detected:true,digit,progress:Math.min(1,(frame.timestamp-this.since)/NUMBER_CONFIG.holdMs),phase:'confirming'};
    if (frame.timestamp - this.since < NUMBER_CONFIG.holdMs) return null;
    this.lastDigit = digit; this.pending = null;this.feedback={detected:true,digit,progress:1,phase:'selected'};
    return digit;
  }
}
