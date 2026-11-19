import { Tracker as TrackerCore } from './tracker-core';

export class Tracker extends TrackerCore {
  constructor() {
    super({
      createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
      resources: () => ({
        wasm: new URL('/vision/wasm', location.href).href,
        model: new URL('/vision/hand_landmarker.task', location.href).href,
      }),
    });
  }
}
