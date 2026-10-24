import { CameraSource } from '../camera/camera';
import { Tracker } from '../tracking/tracker';
import { GestureEngine } from '../gestures/engine';
import { CONFIG } from '../shared/config';
import type { GestureFrame, TrackingFrame } from '../shared/types';
import { NumberModeSelector, classifyLeftNumber, validHand } from '../gestures/number-mode';
import type { NumberMode, NumberFeedback } from '../gestures/number-mode';
import { ObservationRecognizer } from '../gestures/observe-pinch';
import type { ObservationSignal } from '../gestures/observe-pinch';
import { features } from '../gestures/features';
import { ThumbConfirmSelector } from '../gestures/thumb-confirm';
import type { ThumbFeedback } from '../gestures/thumb-confirm';
export interface IntegrationFrame extends GestureFrame {
  observation: { operator?: ObservationSignal; interrupted: boolean };
  modeSelection: NumberMode | null;
  leftDetection: NumberFeedback;
  rightHeld: boolean;
  placementConfirmation: string | null;
  rightConfirmation: ThumbFeedback;
}

// Recognition only: this entry never creates a renderer or the original demo's Controller.
export class GestureRuntime {
  private camera: CameraSource;
  private tracker = new Tracker();
  private gestures = new GestureEngine();
  private numbers = new NumberModeSelector();
  private thumb = new ThumbConfirmSelector();
  private observation = new ObservationRecognizer();
  private generation = 0;
  private running = false;
  private animation = 0;
  private lastInference = 0;
  private lastVideoTime = -1;
  private lastResult = 0;
  private stale = false;
  constructor(private video: HTMLVideoElement, private callbacks: {
    frame(frame: IntegrationFrame, sampleTime: number, tracking: TrackingFrame): void;
    canSwitch(): boolean;
    confirmationTarget(): { previewId: string | null; allowed: boolean };
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
        const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight);
        const gesture = this.gestures.process(frame, aspect);
        const observation = this.observation.process(frame, aspect);
        const rightHeld = frame.hands.some(h => h.side === 'Right' && validHand(h) && features(h,aspect).pinchRatio < CONFIG.pinchExit);
        const leftHeld = frame.hands.some(h => h.side === 'Left' && validHand(h) && features(h,aspect).pinchRatio < CONFIG.pinchExit);
        const left = frame.hands.filter(h => h.side === 'Left');
        // 空闲时先识别成圈的数字 3，不能让这次捏合抢先变成左手环绕。
        // 右手已在操作时继续沿用双手控制；切换完成后仍须松手再抓取。
        const selectingThree = this.callbacks.canSwitch() && !rightHeld && !gesture.operator?.pinching &&
          !gesture.operator?.releasing && left.length === 1 && leftHeld && classifyLeftNumber(left[0],aspect) === 3;
        if (selectingThree) {gesture.helper = undefined; gesture.helperInterrupted = true;}
        const target = this.callbacks.confirmationTarget();
        const safeRight = !!gesture.operator && !gesture.interrupted && !gesture.ambiguous;
        if (!safeRight) this.thumb.reset();
        const placementConfirmation = this.thumb.process(frame, aspect, target.previewId,
          target.allowed && safeRight && !rightHeld && !gesture.operator?.pinching && !gesture.operator?.releasing);
        const rightConfirmation = this.thumb.state;
        const modeSelection = this.numbers.process(frame,aspect,this.callbacks.canSwitch() && !rightHeld && (!leftHeld || selectingThree) &&
          rightConfirmation.phase !== 'confirming' && !placementConfirmation);
        this.callbacks.frame({ ...gesture, observation, modeSelection, leftDetection:this.numbers.state, rightHeld,
          placementConfirmation, rightConfirmation }, performance.timeOrigin + frame.timestamp, frame);
      };
      await this.tracker.start();
      if (generation !== this.generation) return false;
      if (!await this.camera.start(device) || generation !== this.generation) return false;
      this.gestures.reset(); this.observation.reset(); this.numbers.reset(false); this.thumb.reset(false); this.running = true; this.stale = false;
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
  interrupt(cancelPending = false, preserveNumbers = false) { this.gestures.reset(); this.observation.reset(); this.thumb.reset(); if (!preserveNumbers) this.numbers.reset(); this.callbacks.interrupted(cancelPending); }
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
