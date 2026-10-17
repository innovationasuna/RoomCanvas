// Speed-adaptive low-pass filter following Casiez et al., CHI 2012.
export class OneEuroFilter {
  private value?: number;
  private derivative = 0;
  private raw?: number;
  private time?: number;
  constructor(private minCutoff = 1.8, private beta = 0.03, private derivativeCutoff = 1) {}
  update(value: number, timeMs: number) {
    if (this.value === undefined || this.time === undefined) {
      this.value = value; this.raw = value; this.time = timeMs; return value;
    }
    const dt = Math.max(0.001, (timeMs - this.time) / 1000);
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    this.derivative += alpha(this.derivativeCutoff) * ((value - this.raw!) / dt - this.derivative);
    this.value += alpha(this.minCutoff + this.beta * Math.abs(this.derivative)) * (value - this.value);
    this.time = timeMs; this.raw = value;
    return this.value;
  }
  reset() { this.value = undefined; this.raw = undefined; this.time = undefined; this.derivative = 0; }
}
