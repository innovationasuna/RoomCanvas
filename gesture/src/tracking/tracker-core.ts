import type { TrackingFrame } from '../shared/types';
export type TrackerResources = { wasm: string; model: string };
export type TrackerOptions = { createWorker: () => Worker; resources: () => TrackerResources };
export class Tracker {
  constructor(private readonly options: TrackerOptions) {}
  private worker?: Worker;
  private busy = false;
  private generation = 0;
  private ready = false;
  private cancelInit?: (error: Error) => void;
  onFrame?: (frame: TrackingFrame) => void;
  onError?: (error: string) => void;
  async start() {
    this.stop(); const generation = this.generation;
    const worker = this.options.createWorker(); this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const fail = (message: string) => {
        if (generation !== this.generation) return;
        this.ready = false; this.busy = false;
        clearTimeout(timeout); this.cancelInit = undefined;
        worker.terminate(); this.worker = undefined;
        reject(new Error(message)); this.onError?.(message);
      };
      const timeout = globalThis.setTimeout(() => fail('识别资源加载超时，请检查 vision 资源'), 30000);
      this.cancelInit = error => { clearTimeout(timeout); reject(error); };
      worker.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data.type === 'ready') { this.ready = true; clearTimeout(timeout); this.cancelInit = undefined; resolve(); }
        else if (event.data.type === 'result') { this.busy = false; this.onFrame?.(event.data.frame); }
        else fail(event.data.error);
      };
      worker.onerror = event => fail(event.message);
      worker.postMessage({ type: 'init', ...this.options.resources() });
    });
  }
  async detect(video: HTMLVideoElement, timestamp: number) {
    if (!this.ready || this.busy || video.readyState < 2) return;
    this.busy = true; const generation = this.generation;
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(video);
      if (generation !== this.generation || !this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
      bitmap = undefined;
    } catch (error) {
      bitmap?.close();
      if (generation === this.generation) { this.busy = false; this.onError?.(String(error)); }
    }
  }
  stop() { this.generation++; this.cancelInit?.(new Error('识别初始化已取消')); this.cancelInit = undefined; this.worker?.terminate(); this.worker = undefined; this.ready = false; this.busy = false; }
}
