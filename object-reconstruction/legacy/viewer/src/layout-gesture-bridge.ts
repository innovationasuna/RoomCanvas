import { GESTURE_PROTOCOL, parseGestureMessage } from './layout-gesture';
import type { GestureInput } from './layout-gesture';

export interface GestureBridgePort {
  input: GestureInput;
  setMode(mode: string): boolean;
  state(): { busy: boolean; mode: string; selectedId: string | null; layoutReady: boolean; phase: string; message: string; capabilities: string[] };
}
export function connectGestureBridge(port: GestureBridgePort) {
  const query = new URLSearchParams(location.search);
  const origin = query.get('gesture_origin');
  const session = query.get('gesture_session');
  if (!origin || !session || window.parent === window) return;
  // Integration is opt-in. Restrict the first version to the explicitly configured local host.
  let url: URL;
  try { url = new URL(origin); } catch { return; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return;
  let sequence = 0, lastFrame = 0, connected = false;
  const respond = () => window.parent.postMessage({ protocol: GESTURE_PROTOCOL, session,
    type: 'state', sequence, ...port.state() }, origin);
  window.addEventListener('message', event => {
    if (event.origin !== origin || event.source !== window.parent) return;
    const d = parseGestureMessage(event.data);
    if (!d || d.session !== session || d.sequence <= sequence) return;
    sequence = d.sequence;
    if (d.type === 'hello') { connected = true; port.input.reset(); respond(); return; }
    if (!connected) return;
    if (d.type === 'stop') { lastFrame = 0; port.input.reset(); }
    if (d.type === 'mode') {
      if (!port.state().busy) { port.input.reset(); port.setMode(d.mode); }
    }
    if (d.type === 'frame') {
      const age = performance.timeOrigin + performance.now() - d.sampleTime;
      if (age > 250 || age < -50 || document.hidden) { port.input.interrupt(); lastFrame = 0; respond(); return; }
      lastFrame = performance.now();
      port.input.input(d.frame, lastFrame);
    }
    respond();
  });
  const timer = window.setInterval(() => {
    if (lastFrame && performance.now() - lastFrame > 250) { lastFrame = 0; port.input.interrupt(); }
    if (connected) respond();
  }, 100);
  document.addEventListener('visibilitychange', () => { if (document.hidden) port.input.interrupt(); });
  window.addEventListener('pagehide', () => { clearInterval(timer); port.input.reset(); });
}
