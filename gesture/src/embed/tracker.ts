import { Tracker as TrackerCore } from '../tracking/tracker-core';

let visionBase = new URL('/vision/', location.href).href;
export function setVisionBase(url: string | URL) { visionBase = new URL(url, location.href).href.replace(/\/?$/, '/'); }

export class Tracker extends TrackerCore {
  constructor() {
    super({
      createWorker: () => new Worker(new URL('../tracking/worker.ts', import.meta.url), { type: 'module' }),
      resources: () => ({
        wasm: new URL('wasm', visionBase).href,
        model: new URL('hand_landmarker.task', visionBase).href,
      }),
    });
  }
}
