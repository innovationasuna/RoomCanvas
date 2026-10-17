import type { TrackingFrame } from '../shared/types';

// 仅由明确选择远程模式后的开启按钮启动，不保存令牌或画面。
export class RemoteTracker {
  onFrame?: (frame: TrackingFrame) => void;
  onError?: (error: string) => void;
  private generation = 0;
  private ready = false;
  private busy = false;
  private request?: AbortController;
  private canvas = document.createElement('canvas');
  constructor(private token: string) {}
  async start() {
    this.stop();
    if (!this.token) throw new Error('远程识别需要 Mac mini 启动时显示的带令牌链接。');
    const generation = this.generation;
    const request = new AbortController(); this.request = request;
    const timeout = window.setTimeout(() => request.abort(), 10000);
    try {
      const response = await fetch('/api/health', { headers: { Authorization: `Bearer ${this.token}` }, signal: request.signal });
      if (!response.ok) throw new Error('Mac mini 后端未就绪或访问令牌不正确。');
      const result = await response.json();
      if (result.engine !== 'mediapipe-python') throw new Error('当前网页没有连接到 Mac mini 识别后端。');
      if (generation === this.generation) this.ready = true;
    } finally { clearTimeout(timeout); }
  }
  async detect(video: HTMLVideoElement, timestamp: number) {
    if (!this.ready || this.busy || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    this.busy = true;
    const generation = this.generation;
    const request = new AbortController(); this.request = request;
    const timeout = window.setTimeout(() => request.abort(), 2000);
    try {
      const ratio = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
      this.canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
      this.canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
      this.canvas.getContext('2d')!.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => this.canvas.toBlob(b => b ? resolve(b) : reject(new Error('画面编码失败')), 'image/jpeg', 0.8));
      if (generation !== this.generation) return;
      const response = await fetch('/api/detect', { method: 'POST', body: blob, signal: request.signal,
        headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${this.token}` } });
      if (response.status === 503) return; // 后端繁忙时丢帧，下一轮再试，绝不排队应用旧画面。
      if (!response.ok) throw new Error(`Mac mini 识别失败（${response.status}）`);
      const result = await response.json();
      if (generation !== this.generation) return;
      this.onFrame?.({ timestamp, hands: result.hands, inferenceMs: result.inferenceMs, roundTripMs: performance.now() - timestamp });
    } catch (error) {
      if (generation === this.generation) this.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) this.busy = false;
      // 停止后不保留最后一帧像素。
      if (generation === this.generation) { this.canvas.width = 0; this.canvas.height = 0; }
    }
  }
  stop() {
    this.generation++; this.ready = false; this.busy = false; this.request?.abort();
    this.canvas.width = 0; this.canvas.height = 0;
  }
}
