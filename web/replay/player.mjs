// Playback clock: play, pause, seek. The page subscribes to t (seconds).
export class Player {
  constructor(duration) {
    this.duration = duration;
    this.t = 0;
    this.playing = false;
    this.subs = [];
    let last = performance.now();
    const loop = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      if (this.playing) {
        this.t = Math.min(this.t + dt, this.duration);
        if (this.t >= this.duration) this.playing = false;
        this.emit();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  on(fn) {this.subs.push(fn); fn(this.t, this);}
  emit() {this.subs.forEach((fn) => fn(this.t, this));}
  play() {if (this.t >= this.duration) this.t = 0; this.playing = true; this.emit();}
  pause() {this.playing = false; this.emit();}
  toggle() {this.playing ? this.pause() : this.play();}
  seek(t) {this.t = Math.min(Math.max(t, 0), this.duration); this.emit();}
}

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
