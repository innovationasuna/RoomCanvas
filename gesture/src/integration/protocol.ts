import type { GestureFrame, HandSignal } from '../shared/types';
import type { ObservationSignal } from '../gestures/observe-pinch';

export const PROTOCOL = 'viewforge-gesture-v1';
export interface SceneState {
  protocol: typeof PROTOCOL; session: string; type: 'state'; sequence: number;
  busy: boolean; mode: 'view' | 'move' | 'rotate'; selectedId: string | null;
  capabilities?: string[];
  layoutReady: boolean; phase: 'idle' | 'preview' | 'validating' | 'observing'; message: string;
}
export function handPointer(signal?: Pick<HandSignal,'pointer'>) {
  const p=signal?.pointer;
  return p && Number.isFinite(p.x+p.y) && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1 ? {u:p.x,v:p.y}:undefined;
}
export function gesturePayload(frame: GestureFrame) {
  const h = frame.operator;
  // features.ts already mirrors the pointer. No landmarks or camera images cross this bridge.
  const operator = h && Number.isFinite(h.pointer.x + h.pointer.y) &&
    h.pointer.x >= 0 && h.pointer.x <= 1 && h.pointer.y >= 0 && h.pointer.y <= 1 ? {
      u: h.pointer.x, v: h.pointer.y, pinching: h.pinching, started: h.started,
      ended: h.ended, releasing: h.releasing ?? false,
    } : undefined;
  const helper=handPointer(frame.helper);
  return { operator, ...(helper?{helper}:{}), interrupted: frame.interrupted, ambiguous: frame.ambiguous };
}
export function observationPayload(frame: { operator?: ObservationSignal; interrupted: boolean; helper?: HandSignal }) {
  const payload = gesturePayload({ ...frame, timestamp: 0, menuRequested: false, ambiguous: false });
  return { ...payload, operator: payload.operator ? { ...payload.operator, observation: frame.operator!.action } : undefined };
}
export function integrationURL(value: string, origin: string, session: string) {
  const url = new URL(value);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('当前接入入口请使用本机 localhost 或 127.0.0.1 场景地址。');
  }
  url.searchParams.set('gesture_origin', origin);
  url.searchParams.set('gesture_session', session);
  return url;
}
export function parseSceneState(value: unknown, session: string): SceneState | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (d.protocol !== PROTOCOL || d.session !== session || d.type !== 'state' ||
      !Number.isSafeInteger(d.sequence) || (d.sequence as number) < 1 ||
      typeof d.busy !== 'boolean' || typeof d.layoutReady !== 'boolean' ||
      (d.capabilities !== undefined && (!Array.isArray(d.capabilities) || !d.capabilities.every(c => typeof c === 'string'))) ||
      !['move', 'rotate', 'view'].includes(d.mode as string) ||
      !['idle', 'preview', 'validating', 'observing'].includes(d.phase as string) ||
      (d.selectedId !== null && typeof d.selectedId !== 'string') || typeof d.message !== 'string') return null;
  return d as unknown as SceneState;
}
