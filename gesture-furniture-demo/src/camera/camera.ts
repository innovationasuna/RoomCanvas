export class CameraSource {
  private stream?: MediaStream;
  private generation = 0;
  onDisconnect?: () => void;
  constructor(readonly video: HTMLVideoElement) {}
  async devices() { return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); }
  async start(deviceId?: string) {
    this.stop(); const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    } });
    if (generation !== this.generation) { stream.getTracks().forEach(t => t.stop()); return false; }
    this.stream = stream;
    for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => this.onDisconnect?.(), { once: true });
    this.video.srcObject = stream;
    try { await this.video.play(); } catch (error) { this.stop(); throw error; }
    return generation === this.generation;
  }
  stop() { this.generation++; this.stream?.getTracks().forEach(t => t.stop()); this.stream = undefined; this.video.srcObject = null; }
}
