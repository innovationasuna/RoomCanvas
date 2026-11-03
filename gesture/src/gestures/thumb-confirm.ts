import type { Hand, TrackingFrame } from '../shared/types';
import { CONFIG } from '../shared/config';
import { validHand } from './number-mode';

export const THUMB_CONFIRM = { holdMs: 500, neutralMs: 150, lossMs: 200 } as const;
export interface ThumbFeedback {
  phase: 'missing' | 'uncertain' | 'ambiguous' | 'waiting' | 'blocked' | 'neutral' | 'pose' | 'confirming' | 'sent';
  progress: number;
  action?: 'cancel';
}
const length = (v: number[]) => Math.hypot(...v);
const subtract = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
const distance = (a: number[], b: number[]) => length(subtract(a, b));
const cosine = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i], 0) / Math.max(1e-10, length(a) * length(b));

// 右手拇指朝画面上方、其余四指收拢。允许侧掌，不要求掌面正对镜头。
export function isRightThumbsUp(hand: Hand, aspect = 4 / 3) {
  if (hand.side !== 'Right' || !validHand(hand) || !Number.isFinite(aspect) || aspect <= 0) return false;
  const p = hand.landmarks.map(v => [v.x * aspect, v.y, v.z * aspect]);
  const palm = (distance(p[0], p[5]) + distance(p[0], p[9]) + distance(p[0], p[17])) / 3;
  if (palm < 1e-5) return false;
  const folded = [5, 9, 13, 17].every(mcp => {
    const proximal = subtract(p[mcp + 1], p[mcp]);
    const middle = subtract(p[mcp + 2], p[mcp + 1]);
    const distal = subtract(p[mcp + 3], p[mcp + 2]);
    if ([proximal, middle, distal].some(v => length(v) < palm * .04)) return false;
    const reach = distance(p[mcp + 3], p[0]) / Math.max(1e-5, distance(p[mcp + 1], p[0]));
    return reach < .98 || ((cosine(proximal, middle) < .45 || cosine(middle, distal) < .35) && reach < 1.08);
  });
  const proximal = subtract(p[3], p[2]), distal = subtract(p[4], p[3]), thumb = subtract(p[4], p[2]);
  return folded && length(proximal) > palm * .12 && length(distal) > palm * .12 &&
    cosine(proximal, distal) > .65 && -thumb[1] > palm * .45 &&
    -thumb[1] / length(thumb) > .72 && -distal[1] > palm * .08 &&
    p[4][1] < Math.min(...[5, 9, 13, 17].map(i => p[i][1])) - palm * .12 &&
    distance(p[4], p[8]) > palm * .5;
}

// 朝下手型沿画面纵轴翻转后复用同一几何约束，左右手身份不变。
export function isRightThumbsDown(hand: Hand, aspect = 4 / 3) {
  return isRightThumbsUp({...hand, landmarks: hand.landmarks.map(p => ({...p, y: 1 - p.y}))}, aspect);
}

// 一次连续手型只发一次确认，并绑定当前预览；失踪、换手或换预览后不可续用计时。
export class ThumbConfirmSelector {
  private feedback: ThumbFeedback = { phase: 'missing', progress: 0 };
  constructor(private direction: 'up' | 'down' = 'up') {}
  get state(): ThumbFeedback { return { ...this.feedback, ...(this.direction === 'down' ? {action: 'cancel' as const} : {}) }; }
  private since: number | null = null;
  private neutralSince: number | null = null;
  private lastSeen: number | null = null;
  private wrist: { x: number; y: number } | null = null;
  private previewId: string | null = null;
  private armed = true;
  private sent = false;

  reset(requireNeutral = true) {
    this.since = this.neutralSince = this.lastSeen = null;
    this.wrist = null; this.previewId = null; this.armed = !requireNeutral; this.sent = false;
    this.feedback = { phase: 'missing', progress: 0 };
  }
  process(frame: TrackingFrame, aspect: number, previewId: string | null, allowed = true): string | null {
    const candidates = frame.hands.filter(h => h.side === 'Right');
    const right = candidates.length === 1 && validHand(candidates[0]) ? candidates[0] : undefined;
    if (!right || !Number.isFinite(frame.timestamp)) {
      this.reset();
      this.feedback.phase = candidates.length > 1 ? 'ambiguous' : candidates.length ? 'uncertain' : 'missing';
      return null;
    }
    const wrist = right.landmarks[0], time = frame.timestamp;
    if ((this.lastSeen !== null && (time <= this.lastSeen || time - this.lastSeen >= THUMB_CONFIRM.lossMs)) ||
        (this.wrist && Math.hypot(wrist.x - this.wrist.x, wrist.y - this.wrist.y) > CONFIG.identityRadius)) this.reset();
    this.wrist = wrist; this.lastSeen = time;
    const thumb = this.direction === 'down' ? isRightThumbsDown(right, aspect) : isRightThumbsUp(right, aspect);
    if (this.previewId !== previewId) {
      this.since = null;
      if (this.previewId && previewId && thumb) this.armed = false;
      this.previewId = previewId;
    }
    if (!thumb) {
      this.since = null; this.neutralSince ??= time;
      if (time - this.neutralSince >= THUMB_CONFIRM.neutralMs) { this.armed = true; this.sent = false; }
      this.feedback = { phase: previewId ? 'pose' : 'waiting', progress: 0 };
      return null;
    }
    this.neutralSince = null;
    if (!previewId || !allowed) {
      this.since = null;
      if (!previewId) this.armed = false;
      this.feedback = { phase: this.sent ? 'sent' : previewId ? 'blocked' : 'waiting', progress: this.sent ? 1 : 0 };
      return null;
    }
    if (!this.armed) {
      this.feedback = { phase: this.sent ? 'sent' : 'neutral', progress: this.sent ? 1 : 0 };
      return null;
    }
    this.since ??= time;
    const progress = Math.min(1, (time - this.since) / THUMB_CONFIRM.holdMs);
    this.feedback = { phase: 'confirming', progress };
    if (progress < 1) return null;
    this.armed = false; this.sent = true; this.since = null;
    this.feedback = { phase: 'sent', progress: 1 };
    return previewId;
  }
}
