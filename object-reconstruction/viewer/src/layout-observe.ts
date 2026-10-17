import type { GesturePointer } from './layout-gesture';

export type ObservationAction = 'orbit' | 'pan';
export type XYZ = [number, number, number];
export interface CameraSnapshot {
  alpha: number; beta: number; radius: number; target: XYZ;
  right: XYZ; up: XYZ; fov: number; aspect: number; lowerBeta: number; upperBeta: number;
}
export function observationPose(base: CameraSnapshot, start: GesturePointer, point: GesturePointer, action: ObservationAction): CameraSnapshot {
  const dx = point.u-start.u, dy = point.v-start.v;
  if (action === 'orbit') return { ...base, target: [...base.target], alpha: base.alpha+dx*Math.PI*2,
    beta: Math.max(base.lowerBeta,Math.min(base.upperBeta,base.beta-dy*Math.PI)) };
  const height = 2*base.radius*Math.tan(base.fov/2);
  return { ...base, target: base.target.map((v,i) => v-dx*height*base.aspect*base.right[i]+dy*height*base.up[i]) as XYZ };
}
export class CameraObservation {
  private session: { base: CameraSnapshot; start: GesturePointer; action: ObservationAction } | null = null;
  constructor(private port: { read(): CameraSnapshot; apply(pose: CameraSnapshot): void; begin(): void; end(): void }) {}
  get active() { return this.session !== null; }
  get action() { return this.session?.action ?? null; }
  begin(point: GesturePointer, action: ObservationAction) {
    if (this.active) return false;
    this.session = { base: structuredClone(this.port.read()), start: { ...point }, action };
    this.port.begin(); return true;
  }
  update(point: GesturePointer) {
    if (!this.session) return;
    this.port.apply(observationPose(this.session.base,this.session.start,point,this.session.action));
  }
  finish(cancel = false) {
    if (!this.session) return;
    const base = this.session.base;
    this.session = null;
    if (cancel) this.port.apply(base);
    this.port.end();
  }
}
