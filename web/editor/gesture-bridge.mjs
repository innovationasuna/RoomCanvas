// Receiver for the gesture page in gesture/ (protocol viewforge-gesture-v1). The gesture page
// embeds this editor in an iframe, recognises hands in the browser and posts pointer frames;
// this module turns them into grab / move / rotate / release and camera orbit / pan. It follows
// the receiver in object-reconstruction/viewer/src/layout-gesture*.ts message for message, so the
// gesture page needs no change. Scene work stays in scene-editor.js behind a port.
export const PROTOCOL = 'viewforge-gesture-v1';
export const MODES = ['move', 'rotate', 'view'];
// One sweep of the hand across the camera image turns the piece a full circle.
export const ROTATION_PER_SWEEP = 2 * Math.PI;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// Frames are applied in order even when this page was busy (a material compiling as a piece is
// picked up) and they arrive late; only frames this old mean the hand data is no longer current.
// The gesture page itself reports a lost hand with interrupted frames.
export const LATE_FRAME_MS = 2000;

const inUnit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const point = (p) => !!p && typeof p === 'object' && inUnit(p.u) && inUnit(p.v);

// A pinch on a piece works like a mouse button on it. Fingers closing shake the pointer, so the
// piece stays put until the hand has moved DRAG_START (a fraction of the camera image) from where
// the pinch began, and then follows from there without a jump. A pinch let go before that, within
// TAP_MS of being recognised, is a tap.
export const TAP_MS = 1000, DRAG_START = .03;
export class PinchDrag {
  constructor(hand, at) {this.start = {u: hand.u, v: hand.v}; this.at = at; this.dragging = false; this.offset = 0;}
  // 'still' inside the dead zone, 'start' on the frame the hand leaves it, then 'drag'.
  move(hand) {
    if (this.dragging) return 'drag';
    if (Math.hypot(hand.u - this.start.u, hand.v - this.start.v) < DRAG_START) return 'still';
    this.dragging = true;
    return 'start';
  }
  // The turn to apply for a turn of the hand since the pinch began: none inside the dead zone,
  // then counted from its edge.
  turn(angle) {
    if (!this.dragging && Math.abs(angle) / ROTATION_PER_SWEEP < DRAG_START) return null;
    if (!this.dragging) {this.dragging = true; this.offset = angle;}
    return angle - this.offset;
  }
  tap(now) {return !this.dragging && now - this.at < TAP_MS;}
}

export function parseMessage(value) {
  if (!value || typeof value !== 'object') return null;
  const d = value;
  if (d.protocol !== PROTOCOL || typeof d.session !== 'string' || !Number.isSafeInteger(d.sequence) || d.sequence < 1) return null;
  if (d.type === 'hello' || d.type === 'stop') return d;
  if (d.type === 'mode') return MODES.includes(d.mode) ? d : null;
  if (d.type !== 'frame' || typeof d.sampleTime !== 'number' || !Number.isFinite(d.sampleTime) || !d.frame || typeof d.frame !== 'object') return null;
  const f = d.frame;
  if (typeof f.interrupted !== 'boolean' || typeof f.ambiguous !== 'boolean') return null;
  if (f.helper !== undefined && !point(f.helper)) return null;
  if (f.operator !== undefined) {
    const h = f.operator;
    if (!point(h) || !['pinching', 'started', 'ended', 'releasing'].every((k) => typeof h[k] === 'boolean')) return null;
    if ((h.started && (!h.pinching || h.ended)) || (h.ended && h.pinching)) return null;
    if (h.observation !== undefined && h.observation !== 'orbit' && h.observation !== 'pan') return null;
  }
  return d;
}

// The gesture page's recogniser owns pinch timing; this owns one scene operation at a time.
// port: blocked(), mode(), begin(point, mode) → bool, move(point), rotate(angle), commit(),
// cancel(), pointer(point|null), observe: {begin(point, action) → bool, update(point), finish(cancel)}.
export class GestureInput {
  constructor(port) {
    this.port = port;
    this.active = false; this.needsRelease = true; this.kind = 'move'; this.startU = 0; this.missingSince = null;
  }
  reset() {
    if (this.active && this.kind === 'view') this.port.observe.finish(true);
    this.active = false; this.needsRelease = true; this.missingSince = null;
    this.port.pointer(null);
    this.port.cancel();
  }
  interrupt() {
    // A release already submitted is not undone by losing the hand afterwards.
    const wasActive = this.active;
    this.active = false; this.needsRelease = true; this.missingSince = null;
    this.port.pointer(null);
    if (!wasActive) return;
    if (this.kind === 'view') this.port.observe.finish(false); else this.port.cancel();
  }
  input(frame, now) {
    const hand = frame.operator;
    this.port.pointer(hand && !frame.ambiguous ? hand : null);
    if (frame.interrupted) {this.interrupt(); return;}
    if (!hand || frame.ambiguous) {
      this.missingSince ??= now;
      if (now - this.missingSince >= 200) this.interrupt();
      return;
    }
    if (this.missingSince !== null && now - this.missingSince >= 200) {this.interrupt(); return;}
    this.missingSince = null;
    if (!this.active && this.port.blocked()) {this.needsRelease = true; return;}
    // After a mode switch, a release or a lost hand, start only from an open hand.
    if (this.needsRelease) {
      if (!hand.pinching && !hand.started && !hand.ended && !hand.releasing) this.needsRelease = false;
      return;
    }
    if (this.active) {
      if (hand.ended) {
        this.active = false; this.needsRelease = true;
        if (this.kind === 'view') this.port.observe.finish(false); else this.port.commit();
      } else if (hand.pinching && !hand.releasing) {
        if (this.kind === 'view') this.port.observe.update(hand);
        else if (this.kind === 'move') this.port.move(hand);
        else this.port.rotate((hand.u - this.startU) * ROTATION_PER_SWEEP);
      }
      return;
    }
    if (!hand.started) return;
    const mode = this.port.mode();
    if (mode === 'view' && hand.observation) {
      this.kind = 'view';
      this.active = this.port.observe.begin(hand, hand.observation);
    } else if (mode === 'move' || mode === 'rotate') {
      this.kind = mode; this.startU = hand.u;
      this.active = this.port.begin(hand, mode);
    } else return;
    if (!this.active) this.needsRelease = true;
  }
}

// Orbit and pan of an orbiting camera, as offsets from where the pinch began. A sweep across
// the image orbits a full turn, or pans the visible width; up/down tilts half a turn.
export function observationPose(base, start, now, action) {
  const du = now.u - start.u, dv = now.v - start.v;
  if (action === 'orbit') return {...base, target: [...base.target], theta: base.theta - du * 2 * Math.PI,
    phi: Math.max(base.minPhi, Math.min(base.maxPhi, base.phi - dv * Math.PI))};
  const shift = base.right.map((r, i) => -r * du * base.width + base.up[i] * dv * base.height);
  return {...base, target: base.target.map((v, i) => v + shift[i])};
}

export function sceneURLSession(search) {
  const query = new URLSearchParams(search);
  const origin = query.get('gesture_origin'), session = query.get('gesture_session');
  if (!origin || !session) return null;
  let url;
  try {url = new URL(origin);} catch {return null;}
  // Only a gesture page on this computer may drive the editor.
  if (!LOCAL_HOSTS.includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return null;
  return {origin, session};
}

// Wires an embedded editor to its parent gesture page. state() returns the fields of the
// protocol's 'state' message; setMode(mode) switches between move, rotate and view; stop(), if
// given, runs when the gesture page cancels the current operation.
export function connectGestureBridge(port, {win = window, doc = document, clock = performance} = {}) {
  const target = win.parent !== win && sceneURLSession(win.location.search);
  if (!target) return null;
  const {origin, session} = target;
  let sequence = 0, lastFrame = 0, lastTick = clock.now(), connected = false;
  const respond = () => win.parent.postMessage({protocol: PROTOCOL, session, type: 'state', sequence, ...port.state()}, origin);
  win.addEventListener('message', (event) => {
    if (event.origin !== origin || event.source !== win.parent) return;
    const d = parseMessage(event.data);
    if (!d || d.session !== session || d.sequence <= sequence) return;
    sequence = d.sequence;
    if (d.type === 'hello') {connected = true; port.input.reset(); respond(); return;}
    if (!connected) return;
    if (d.type === 'stop') {lastFrame = 0; port.input.reset(); port.stop?.();}
    if (d.type === 'mode' && !port.state().busy) {port.input.reset(); port.setMode(d.mode);}
    if (d.type === 'frame') {
      const age = clock.timeOrigin + clock.now() - d.sampleTime;
      if (age > LATE_FRAME_MS || age < -50 || doc.hidden) {port.input.interrupt(); lastFrame = 0; respond(); return;}
      lastFrame = clock.now();
      port.input.input(d.frame, lastFrame);
    }
    respond();
  });
  const timer = win.setInterval(() => {
    // A tick that comes late means this page was busy and frames are still queued: wait for them.
    const now = clock.now(), late = now - lastTick > 200;
    lastTick = now;
    if (!late && lastFrame && now - lastFrame > 250) {lastFrame = 0; port.input.interrupt();}
    if (connected) respond();
  }, 100);
  doc.addEventListener('visibilitychange', () => {if (doc.hidden) port.input.interrupt();});
  win.addEventListener('pagehide', () => {win.clearInterval(timer); port.input.reset();});
  return {session};
}
