import { CameraSource } from '../camera/camera';
import { Tracker } from '../tracking/tracker';
import { GestureEngine } from '../gestures/engine';
import { CONFIG } from '../shared/config';
import type { GestureFrame } from '../shared/types';

// Recognition only: this entry never creates a renderer or the original demo's Controller.
export class GestureRuntime {
  private camera: CameraSource;
  private tracker = new Tracker();
  private gestures = new GestureEngine();
  private generation = 0;
  private running = false;
  private animation = 0;
  private lastInference = 0;
  private lastVideoTime = -1;
  private lastResult = 0;
  private stale = false;
  constructor(private video: HTMLVideoElement, private callbacks: {
    frame(frame: GestureFrame, sampleTime: number, inferenceMs: number): void;
    interrupted(cancelPending: boolean): void; error(message: string): void;
  }) {
    this.camera = new CameraSource(video);
    this.camera.onDisconnect = () => { this.stop(); this.callbacks.error('摄像头已断开，请重新开启。'); };
  }
  async start(device?: string) {
    this.stop(); const generation = this.generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('请使用 localhost 页面并允许摄像头权限。');
      this.tracker.onError = error => { this.stop(); this.callbacks.error(error); };
      this.tracker.onFrame = frame => {
        if (!this.running || generation !== this.generation) return;
        const now = performance.now();
        if (now - frame.timestamp > 250 || document.hidden) {
          this.interrupt(); return;
        }
        this.lastResult = now; this.stale = false;
        this.callbacks.frame(this.gestures.process(frame, this.video.videoWidth / Math.max(1, this.video.videoHeight)),
          performance.timeOrigin + frame.timestamp, frame.inferenceMs);
      };
      await this.tracker.start();
      if (generation !== this.generation) return false;
      if (!await this.camera.start(device) || generation !== this.generation) return false;
      this.gestures.reset(); this.running = true; this.stale = false;
      this.lastResult = performance.now(); this.lastInference = 0; this.lastVideoTime = -1;
      this.animation = requestAnimationFrame(this.loop);
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      this.stop();
      this.callbacks.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }
  interrupt(cancelPending = false) { this.gestures.reset(); this.callbacks.interrupted(cancelPending); }
  private loop = (now: number) => {
    if (!this.running) return;
    if (!document.hidden && now - this.lastInference >= CONFIG.inferenceInterval && this.video.currentTime !== this.lastVideoTime) {
      this.lastInference = now; this.lastVideoTime = this.video.currentTime;
      void this.tracker.detect(this.video, now);
    }
    if (now - this.lastResult > CONFIG.lossMs && !this.stale) { this.stale = true; this.interrupt(); }
    this.animation = requestAnimationFrame(this.loop);
  };
  stop() {
    this.generation++; this.running = false; cancelAnimationFrame(this.animation);
    this.tracker.stop(); this.camera.stop(); this.interrupt(true);
  }
}
