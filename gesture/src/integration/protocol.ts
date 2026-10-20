import type { GestureFrame, HandSignal } from '../shared/types';
import type { ObservationSignal } from '../gestures/observe-pinch';
import { showFingerGuide } from '../shared/hand-guide';

export const PROTOCOL = 'roomcanvas-gesture-v1';
export type SceneMode = 'view' | 'move' | 'height' | 'scale' | 'rotate';
export interface SceneState {
  protocol: typeof PROTOCOL; session: string; type: 'state'; sequence: number;
  busy: boolean; mode: SceneMode; selectedId: string | null;
  capabilities?: string[];
  previewId?: string | null;
  canConfirm?: boolean;
  selectedName?: string; selectedDescription?: string; pendingValid?: boolean; selectedWall?: boolean; wallEditing?: boolean;
  editorMode?: 'edit' | 'preview'; screen?: 'studio' | 'library';
  layoutReady: boolean; phase: 'idle' | 'preview' | 'validating' | 'observing'; message: string;
}
export function handPointer(signal?: Pick<HandSignal,'pointer'>) {
  const p=signal?.pointer;
  return p && Number.isFinite(p.x+p.y) && p.x>=0 && p.x<=1 && p.y>=0 && p.y<=1 ? {u:p.x,v:p.y}:undefined;
}
export function gesturePayload(frame: GestureFrame) {
  // Only control signals cross this local bridge. Frames and full landmarks stay in the tracker.
  const signal = (h?: HandSignal) => {
    const p = handPointer(h);
    if (!h || !p) return undefined;
    const tip = (p: {x:number;y:number}) => ({u:Math.max(0,Math.min(1,p.x)),v:Math.max(0,Math.min(1,p.y))});
    return {...p, pinching:h.pinching, started:h.started, ended:h.ended, releasing:h.releasing ?? false,
      palmScale:h.palmScale, frontFacing:h.frontFacing,
      ...(typeof h.pinchRatio === 'number' && Number.isFinite(h.pinchRatio) && h.pinchRatio >= 0 ? {pinchRatio:h.pinchRatio} : {}),
      ...(showFingerGuide(h) && h.fingertips ? {fingertips:{thumb:tip(h.fingertips.thumb),index:tip(h.fingertips.index)}} : {})};
  };
  return {operator:signal(frame.operator), helper:signal(frame.helper), interrupted:frame.interrupted,
    helperInterrupted:frame.helperInterrupted ?? false, ambiguous:frame.ambiguous};
}
export function observationPayload(frame: { operator?: ObservationSignal; interrupted: boolean; helper?: HandSignal }) {
  const h=frame.operator, p=handPointer(h);
  return {operator:h && p ? {...p,pinching:h.pinching,started:h.started,ended:h.ended,releasing:h.releasing ?? false,observation:h.action} : undefined,
    helper:handPointer(frame.helper),interrupted:frame.interrupted,ambiguous:false};
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
      (d.previewId !== undefined && d.previewId !== null && (typeof d.previewId !== 'string' || !d.previewId || d.previewId.length > 128)) ||
      (d.canConfirm !== undefined && typeof d.canConfirm !== 'boolean') ||
      ['pendingValid','selectedWall','wallEditing'].some(key => d[key] !== undefined && typeof d[key] !== 'boolean') ||
      (d.editorMode !== undefined && !['edit','preview'].includes(d.editorMode as string)) ||
      (d.screen !== undefined && !['studio','library'].includes(d.screen as string)) ||
      ['selectedName','selectedDescription'].some(key => d[key] !== undefined && (typeof d[key] !== 'string' || (d[key] as string).length > 500)) ||
      (d.canConfirm === true && (typeof d.previewId !== 'string' || !d.previewId || d.busy || !d.layoutReady)) ||
      (d.capabilities !== undefined && (!Array.isArray(d.capabilities) || !d.capabilities.every(c => typeof c === 'string'))) ||
      !['move', 'height', 'scale', 'rotate', 'view'].includes(d.mode as string) ||
      !['idle', 'preview', 'validating', 'observing'].includes(d.phase as string) ||
      (d.selectedId !== null && typeof d.selectedId !== 'string') || typeof d.message !== 'string') return null;
  return d as unknown as SceneState;
}
