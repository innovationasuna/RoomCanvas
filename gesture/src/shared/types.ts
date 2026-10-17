export type Side = 'Left' | 'Right';
export type Mode = 'move' | 'rotate' | 'height' | 'observe' | 'scale';
export type SceneId = 'furniture' | 'xyz';
export interface Point { x: number; y: number; z: number }
export interface Pointer { x: number; y: number }
export interface Hand { side: Side; score: number; landmarks: Point[]; world: Point[] }
export interface TrackingFrame { timestamp: number; hands: Hand[]; inferenceMs: number; roundTripMs?: number }
export interface HandSignal {
  pointer: Pointer; wrist: Pointer; palmScale: number; frontFacing: boolean;
  fingertips?: { thumb: Pointer; index: Pointer };
  pinchRatio?: number;
  closedFist?: boolean;
  releasing?: boolean; // 已开始张开：冻结控制，等待释放确认。
  pinching: boolean; started: boolean; ended: boolean; openPalm: boolean;
}
export interface GestureFrame {
  timestamp: number; operator?: HandSignal; helper?: HandSignal;
  menuRequested: boolean; menuCloseRequested?: boolean; interrupted: boolean; helperInterrupted?: boolean; ambiguous: boolean;
}
export interface Transform { position: Point; rotation: number; scale: number }
export interface ObjectInfo { id: string; label: string; transform: Transform; size: Point }
export interface CameraPose { theta: number; phi: number; radius: number }
export interface ScenePort {
  active: SceneId;
  pick(pointer: Pointer): string | undefined;
  floorPoint(pointer: Pointer): Point | undefined;
  info(id: string): ObjectInfo | undefined;
  apply(id: string, transform: Transform): void;
  highlight(id?: string): void;
  getCamera(): CameraPose;
  setCamera(pose: CameraPose): void;
  cameraAxes(): { right: Point; up: Point; forward: Point };
  switchScene(scene: SceneId): void;
  snapshot(): Record<string, Transform>;
  restore(snapshot: Record<string, Transform>): void;
  reset(): void;
}
export type Action = Mode | 'undo' | 'reset' | 'confirm-reset' | 'cancel-reset' | 'pause' | 'resume' | SceneId | 'close';
