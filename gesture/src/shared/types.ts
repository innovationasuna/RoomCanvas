export type Side = 'Left' | 'Right';
export interface Point { x: number; y: number; z: number }
export interface Pointer { x: number; y: number }
export interface Hand { side: Side; score: number; landmarks: Point[]; world: Point[] }
export interface TrackingFrame { timestamp: number; hands: Hand[]; inferenceMs: number }
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
