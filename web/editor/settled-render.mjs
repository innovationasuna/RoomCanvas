// Schedule one expensive update after interaction settles. No animation loop while idle.
export class SettledRender {
  constructor({render, busy = () => false, onError = () => {}, delay = 350,
    setTimer = (callback, ms) => setTimeout(callback, ms), clearTimer = id => clearTimeout(id)}) {
    Object.assign(this, {render, busy, onError, delay, setTimer, clearTimer});
    this.timer = null;
    this.paused = false;
    this.disposed = false;
    this.dirty = false;
    this.updates = 0;
  }
  invalidate() {
    if (this.disposed) return;
    this.dirty = true;
    this.cancel();
    if (!this.paused) this.timer = this.setTimer(() => this.flush(), this.delay);
  }
  flush() {
    this.timer = null;
    if (this.disposed || this.paused || !this.dirty) return;
    if (this.busy()) {this.invalidate(); return;}
    this.dirty = false;
    try {this.render(); this.updates++;}
    catch (error) {this.dispose(); this.onError(error);}
  }
  cancel() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  pause() {this.paused = true; this.cancel();}
  resume() {this.paused = false; if (this.dirty) this.invalidate();}
  dispose() {this.cancel(); this.disposed = true;}
}
