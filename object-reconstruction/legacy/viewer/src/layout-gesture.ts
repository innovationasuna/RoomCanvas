import type { OperationMode } from './layout-manipulation';

export interface GesturePointer { u: number; v: number }
export interface GestureHand extends GesturePointer {
  pinching: boolean; started: boolean; ended: boolean; releasing: boolean;
  observation?: 'orbit' | 'pan';
}
export interface GestureInputFrame {
  operator?: GestureHand; interrupted: boolean; ambiguous: boolean;
  helper?: GesturePointer;
}
export interface GesturePort {
  blocked(): boolean;
  mode(): string;
  begin(point: GesturePointer, mode: OperationMode): boolean;
  move(point: GesturePointer): void;
  rotate(delta: number): void;
  commit(): Promise<void>;
  cancel(): void;
  pointer(point: GesturePointer | null): void;
  helperPointer?(point: GesturePointer | null): void;
  observe?: {
    begin(point: GesturePointer, action: 'orbit' | 'pan'): boolean;
    update(point: GesturePointer): void;
    finish(cancel: boolean): void;
  };
}
// The recognition engine owns pinch timing. This adapter owns the scene input session.
export class GestureInput {
  private active = false;
  private needsRelease = true;
  private startU = 0;
  private operationMode: OperationMode | 'view' = 'move';
  private missingSince: number | null = null;
  constructor(private port: GesturePort) {}
  reset() {
    if (this.active && this.operationMode === 'view') this.port.observe?.finish(true);
    this.active = false;
    this.needsRelease = true;
    this.missingSince = null;
    this.port.pointer(null);
    this.port.helperPointer?.(null);
    this.port.cancel();
  }
  interrupt(helper?: GesturePointer) {
    // Once release has submitted a pose, losing the hand must not cancel that submission.
    const wasActive = this.active;
    this.active = false;
    this.needsRelease = true;
    this.missingSince = null;
    this.port.pointer(null);
    this.port.helperPointer?.(helper ?? null);
    if (wasActive) {
      if (this.operationMode === 'view') this.port.observe?.finish(false);
      else this.port.cancel();
    }
  }
  input(frame: GestureInputFrame, now: number) {
    const hand = frame.operator;
    this.port.pointer(hand && !frame.ambiguous ? hand : null);
    this.port.helperPointer?.(frame.helper ?? null);
    if (frame.interrupted) { this.interrupt(frame.helper); return; }
    if (!hand || frame.ambiguous) {
      this.missingSince ??= now;
      if (now - this.missingSince >= 200) this.interrupt(frame.helper);
      return;
    }
    // A long gap may arrive without intermediate empty frames.
    if (this.missingSince !== null && now - this.missingSince >= 200) {
      this.interrupt(frame.helper); return;
    }
    this.missingSince = null;
    if (!this.active && this.port.blocked()) { this.needsRelease = true; return; }
    if (this.needsRelease) {
      if (!hand.pinching && !hand.started && !hand.ended && !hand.releasing) this.needsRelease = false;
      return;
    }
    if (this.active) {
      if (hand.ended) {
        this.active = false;
        this.needsRelease = true;
        if (this.operationMode === 'view') this.port.observe?.finish(false);
        else void this.port.commit();
      } else if (hand.pinching && !hand.releasing) {
        if (this.operationMode === 'view') this.port.observe?.update(hand);
        else if (this.operationMode === 'move') this.port.move(hand);
        else this.port.rotate((hand.u - this.startU) * Math.PI);
      }
      return;
    }
    const mode = this.port.mode();
    if (hand.started && mode === 'view' && hand.observation && this.port.observe) {
      this.operationMode = 'view';
      this.active = this.port.observe.begin(hand,hand.observation);
      if (!this.active) this.needsRelease = true;
      return;
    }
    if (hand.started && (mode === 'move' || mode === 'rotate')) {
      this.operationMode = mode;
      this.startU = hand.u;
      this.active = this.port.begin(hand, mode);
      if (!this.active) this.needsRelease = true;
    }
  }
}

export const GESTURE_PROTOCOL = 'viewforge-gesture-v1';
export type GestureMessage = {
  protocol: typeof GESTURE_PROTOCOL; session: string; sequence: number;
} & (
  { type: 'hello' | 'stop' } |
  { type: 'mode'; mode: 'view' | OperationMode } |
  { type: 'frame'; sampleTime: number; frame: GestureInputFrame }
);
export function parseGestureMessage(value: unknown): GestureMessage | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (d.protocol !== GESTURE_PROTOCOL || typeof d.session !== 'string' ||
      !Number.isSafeInteger(d.sequence) || (d.sequence as number) < 1) return null;
  if (d.type === 'hello' || d.type === 'stop') return d as GestureMessage;
  if (d.type === 'mode' && ['move', 'rotate', 'view'].includes(d.mode as string)) return d as GestureMessage;
  if (d.type !== 'frame' || typeof d.sampleTime !== 'number' || !Number.isFinite(d.sampleTime) ||
      !d.frame || typeof d.frame !== 'object') return null;
  const frame = d.frame as Record<string, unknown>;
  if (typeof frame.interrupted !== 'boolean' || typeof frame.ambiguous !== 'boolean') return null;
  if (frame.helper !== undefined) {
    if (!frame.helper || typeof frame.helper !== 'object') return null;
    const h=frame.helper as Record<string,unknown>;
    if (typeof h.u !== 'number' || typeof h.v !== 'number' || !Number.isFinite(h.u+h.v) || h.u<0 || h.u>1 || h.v<0 || h.v>1) return null;
  }
  if (frame.operator !== undefined) {
    if (!frame.operator || typeof frame.operator !== 'object') return null;
    const h = frame.operator as Record<string, unknown>;
    if (typeof h.u !== 'number' || typeof h.v !== 'number' || !Number.isFinite(h.u + h.v) ||
        h.u < 0 || h.u > 1 || h.v < 0 || h.v > 1 ||
        !['pinching', 'started', 'ended', 'releasing'].every(k => typeof h[k] === 'boolean') ||
        (h.started && (!h.pinching || h.ended)) || (h.ended && h.pinching)) return null;
    if (h.observation !== undefined && h.observation !== 'orbit' && h.observation !== 'pan') return null;
  }
  return d as GestureMessage;
}
