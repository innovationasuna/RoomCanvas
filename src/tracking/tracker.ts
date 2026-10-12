import type { TrackingFrame } from '../shared/types';
export class Tracker {
  private worker?: Worker;
  private busy = false;
  private generation = 0;
  private ready = false;
  private cancelInit?: (error: Error) => void;
  onFrame?: (frame: TrackingFrame) => void;
  onError?: (error: string) => void;
  async start() {
    this.stop(); const generation = this.generation;
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }); this.worker = worker;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('识别资源加载超时，请检查本地 vision 资源')), 30000);
      this.cancelInit = error => { clearTimeout(timeout); reject(error); };
      worker.onmessage = event => {
        if (generation !== this.generation) return;
        if (event.data.type === 'ready') { this.ready = true; clearTimeout(timeout); this.cancelInit = undefined; resolve(); }
        else if (event.data.type === 'result') { this.busy = false; this.onFrame?.(event.data.frame); }
        else { this.busy = false; clearTimeout(timeout); reject(new Error(event.data.error)); this.onError?.(event.data.error); }
      };
      worker.onerror = event => { this.busy = false; clearTimeout(timeout); reject(new Error(event.message)); this.onError?.(event.message); };
      worker.postMessage({ type: 'init', wasm: new URL('/vision/wasm', location.href).href, model: new URL('/vision/hand_landmarker.task', location.href).href });
    });
  }
  async detect(video: HTMLVideoElement, timestamp: number) {
    if (!this.ready || this.busy || video.readyState < 2) return;
    this.busy = true; const generation = this.generation;
    try {
      const bitmap = await createImageBitmap(video);
      if (generation !== this.generation || !this.worker) { bitmap.close(); return; }
      this.worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
    } catch (error) { this.busy = false; this.onError?.(String(error)); }
  }
  stop() { this.generation++; this.cancelInit?.(new Error('识别初始化已取消')); this.cancelInit = undefined; this.worker?.terminate(); this.worker = undefined; this.ready = false; this.busy = false; }
}
