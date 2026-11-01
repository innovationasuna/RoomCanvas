// Receiver for the gesture page in gesture/ (protocol roomcanvas-gesture-v1). The gesture page
// embeds this editor in an iframe, recognises hands in the browser and posts pointer frames;
// this module turns them into move / height / rotate / release, independent left orbit, and
// two-hand scaling. dual-hand-v2 advertises the extended signals. Scene work stays behind a port.
export const PROTOCOL = 'roomcanvas-gesture-v1';
export const MODES = ['move', 'height', 'scale', 'rotate', 'view'];
// One sweep of the hand across the camera image turns the piece three full circles (1080 degrees).
export const ROTATION_PER_SWEEP = 6 * Math.PI;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
// Frames are applied in order even when this page was busy (a material compiling as a piece is
// picked up) and they arrive late; only frames this old mean the hand data is no longer current.
// The gesture page itself reports a lost hand with interrupted frames.
export const LATE_FRAME_MS = 2000;
export const CONFIRM_MAX_AGE_MS = 500;

const inUnit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const point = (p) => !!p && typeof p === 'object' && inUnit(p.u) && inUnit(p.v);

export function parseMessage(value) {
  if (!value || typeof value !== 'object') return null;
  const d = value;
  if (d.protocol !== PROTOCOL || typeof d.session !== 'string' || !Number.isSafeInteger(d.sequence) || d.sequence < 1) return null;
  if (d.type === 'hello' || d.type === 'stop') return d;
  if (d.type === 'mode') return MODES.includes(d.mode) ? d : null;
  if (d.type === 'confirm' || d.type === 'cancel') return typeof d.previewId === 'string' && d.previewId.length > 0 && d.previewId.length <= 128 &&
    typeof d.sampleTime === 'number' && Number.isFinite(d.sampleTime) ? d : null;
  if (d.type !== 'frame' || typeof d.sampleTime !== 'number' || !Number.isFinite(d.sampleTime) || !d.frame || typeof d.frame !== 'object') return null;
  const f = d.frame;
  if (typeof f.interrupted !== 'boolean' || typeof f.ambiguous !== 'boolean') return null;
  if (f.helperInterrupted !== undefined && typeof f.helperInterrupted !== 'boolean') return null;
  for (const role of ['operator', 'helper']) {
    const h = f[role];
    if (h === undefined) continue;
    if (!point(h)) return null;
    // Legacy helper frames carried only a pointer, never an action.
    if (role === 'helper' && h.pinching === undefined) {
      if (Object.keys(h).some(k => k !== 'u' && k !== 'v')) return null;
      continue;
    }
    if (!['pinching', 'started', 'ended', 'releasing'].every(k => typeof h[k] === 'boolean')) return null;
    if ((h.started && (!h.pinching || h.ended)) || (h.ended && h.pinching)) return null;
    if (h.observation !== undefined && !['orbit','pan'].includes(h.observation)) return null;
    if (h.fingertips !== undefined && (!point(h.fingertips?.thumb) || !point(h.fingertips?.index))) return null;
    if (h.palmScale !== undefined && (!Number.isFinite(h.palmScale) || h.palmScale < 0)) return null;
    if (h.pinchRatio !== undefined && (!Number.isFinite(h.pinchRatio) || h.pinchRatio < 0)) return null;
    if (h.frontFacing !== undefined && typeof h.frontFacing !== 'boolean') return null;
  }
  return d;
}

// Pinch timing belongs to the recogniser. Right manipulation and left orbit have independent
// lifetimes; a two-hand scale owns the camera until either hand releases.
export class GestureInput {
  constructor(port) {
    this.port = port;
    this.active = false; this.leftActive = false; this.dual = false;
    this.needsRelease = true; this.leftNeedsRelease = true;
    this.kind = 'move'; this.startU = 0;
    this.missingSince = null; this.leftMissingSince = null;
  }
  reset() {
    if (this.leftActive || (this.active && this.kind === 'view')) this.port.observe.finish(true);
    if (this.dual) this.port.scale?.finish(true);
    this.active = this.leftActive = this.dual = false;
    this.needsRelease = this.leftNeedsRelease = true;
    this.missingSince = this.leftMissingSince = null;
    this.port.pointer(null, null); this.port.cancel();
  }
  interruptRight() {
    if (this.active) {
      if (this.kind === 'view') this.port.observe.finish(false); else this.port.cancel();
    }
    this.active = false; this.needsRelease = true; this.missingSince = null;
  }
  interruptLeft() {
    if (this.leftActive) this.port.observe.finish(false);
    this.leftActive = false; this.leftNeedsRelease = true; this.leftMissingSince = null;
  }
  interrupt() {
    if (this.dual) this.port.scale?.finish(true);
    this.dual = false; this.interruptRight(); this.interruptLeft(); this.port.pointer(null, null);
  }
  input(frame, now) {
    let hand = frame.ambiguous ? undefined : frame.operator, helper = frame.helper;
    this.port.pointer(hand ?? null, helper ?? null);
    const lost = (h, key) => {
      if (!h) this[key] ??= now;
      const expired = this[key] !== null && now - this[key] >= 200;
      if (h) this[key] = null;
      return expired;
    };
    const rightLost = lost(hand, 'missingSince') || frame.interrupted;
    const leftLost = lost(helper, 'leftMissingSince') || frame.helperInterrupted;
    if (this.dual && (rightLost || leftLost)) {
      this.port.scale?.finish(true); this.dual = false;
      this.interruptRight(); this.interruptLeft(); return;
    }
    if (rightLost) {this.interruptRight(); hand = undefined;}
    if (leftLost) {this.interruptLeft(); helper = undefined;}
    const open = h => h && !h.pinching && !h.started && !h.ended && !h.releasing;
    if (open(hand)) this.needsRelease = false;
    if (open(helper)) this.leftNeedsRelease = false;
    const blocked = this.port.blocked();
    if (this.dual) {
      if (!hand || !helper) return; // short tracking gap freezes both
      if (hand.ended || helper.ended) {
        this.port.scale.finish(false); this.dual = false;
        if (hand.ended) this.needsRelease = true;
        if (helper.ended) this.leftNeedsRelease = true;
        // The remaining left pinch resumes from a fresh camera baseline, without a jump.
        if (helper.pinching && !helper.releasing) this.leftActive = this.port.observe.begin(helper, 'orbit', 'helper');
        return;
      }
      if (!hand.releasing && !helper.releasing) this.port.scale.update(hand, helper);
      return;
    }
    const mode = this.port.mode();
    if (!blocked && (mode === 'scale' || mode === 'view') && !this.needsRelease && !this.leftNeedsRelease && hand?.pinching && helper?.pinching && !hand.releasing && !helper.releasing) {
      if (this.leftActive || (this.active && this.kind === 'view')) this.port.observe.finish(false);
      this.active = this.leftActive = false;
      this.dual = this.port.scale?.begin(hand, helper) ?? false;
      return;
    }
    if (!this.leftNeedsRelease && helper) {
      if (helper.started && !this.leftActive) this.leftActive = this.port.observe.begin(helper, 'orbit', 'helper');
      if (this.leftActive) {
        if (helper.ended) {this.port.observe.finish(false); this.leftActive = false; this.leftNeedsRelease = true;}
        else if (helper.pinching && !helper.releasing) this.port.observe.update(helper);
      }
    }
    // Camera orbit may continue while a released piece is checked or falling. In particular,
    // consume the left release during validation so it cannot leave an observing session stuck.
    if (blocked) {
      if (this.active) this.interruptRight();
      if (hand?.pinching) this.needsRelease = true;
      return;
    }
    if (!hand || this.needsRelease) return;
    if (this.active) {
      if (hand.ended) {
        this.active = false; this.needsRelease = true;
        if (this.kind === 'view') this.port.observe.finish(false); else this.port.release();
      } else if (hand.pinching && !hand.releasing) {
        if (this.kind === 'view') this.port.observe.update(hand);
        else if (this.kind === 'move') this.port.move(hand);
        else if (this.kind === 'height') this.port.height(hand);
        else this.port.rotate((hand.u - this.startU) * ROTATION_PER_SWEEP);
      }
      return;
    }
    if (!hand.started) return;
    if (mode === 'view' && hand.observation && !this.leftActive) {
      this.kind = 'view'; this.active = this.port.observe.begin(hand, hand.observation);
    } else if (['move','height','rotate'].includes(mode)) {
      this.kind = mode; this.startU = hand.u; this.active = this.port.begin(hand, mode);
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
// protocol's 'state' message; setMode(mode) switches among MODES; stop(), if
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
    if (d.type === 'confirm' || d.type === 'cancel') {
      const state = port.state(), age = clock.timeOrigin + clock.now() - d.sampleTime;
      // 确认只作用于同一个仍待放置的预览；拖动、缩放或过期请求不得排队补发。
      if (!doc.hidden && age >= -50 && age <= CONFIRM_MAX_AGE_MS && state.layoutReady && !state.busy &&
          state.canConfirm === true && state.previewId === d.previewId && !port.input.active && !port.input.dual) {
        if (d.type === 'cancel') port.cancel?.(); else port.confirm?.();
      }
    }
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
