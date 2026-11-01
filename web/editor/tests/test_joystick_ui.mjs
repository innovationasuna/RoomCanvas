import test from 'node:test';
import assert from 'node:assert/strict';
import {mountJoysticks} from '../joystick-ui.mjs';

// A small event/animation host exercises the controls without a WebGL scene.
class Control extends EventTarget {
  constructor(doc) {
    super(); this.ownerDocument = doc; this.dataset = {}; this.attributes = new Map();
    this.style = {setProperty() {}}; this.children = new Map(); this.captured = new Set();
    this.clientWidth = 100; this.clientHeight = 240; this.offsetWidth = 34; this.offsetHeight = 28;
  }
  set innerHTML(markup) {
    for (const [, classes] of markup.matchAll(/class="([^"]+)"/g)) {
      const node = new Control(this.ownerDocument);
      for (const name of classes.split(' ')) this.children.set('.'+name, node);
    }
  }
  querySelector(selector) { return this.children.get(selector) || null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  append(node) { this.child = node; }
  focus() {}
  getBoundingClientRect() { return {left: 0, top: 0, width: this.clientWidth, height: this.clientHeight}; }
  setPointerCapture(id) { this.captured.add(id); }
  hasPointerCapture(id) { return this.captured.has(id); }
  releasePointerCapture(id) { this.captured.delete(id); emit(this, 'lostpointercapture', {pointerId: id}); }
}
function emit(target, type, fields = {}) {
  const event = new Event(type, {cancelable: true});
  Object.assign(event, {button: 0, pointerId: 1, clientX: 50, clientY: 120}, fields);
  target.dispatchEvent(event);
  return event;
}
function setup(onStart) {
  const win = new EventTarget(), doc = new EventTarget(), frames = new Map();
  let serial = 0;
  win.requestAnimationFrame = callback => {frames.set(++serial, callback); return serial;};
  win.cancelAnimationFrame = id => frames.delete(id);
  doc.defaultView = win; doc.createElement = () => new Control(doc);
  const stage = new Control(doc), calls = {start: [], lift: [], move: [], rotate: [], end: []};
  let ui;
  ui = mountJoysticks(stage, {
    onStart: kind => {calls.start.push(kind); return onStart?.(ui, kind);},
    onLift: (speed, dt) => calls.lift.push({speed, dt}),
    onMove: (x, y, dt) => calls.move.push({x, y, dt}),
    onRotate: angle => calls.rotate.push(angle),
    onEnd: kind => calls.end.push(kind),
  });
  ui.setState({enabled: true, visible: true});
  const panel = stage.child;
  return {
    ui, panel, doc, win, calls, frames,
    lift: panel.querySelector('.rc-lift-lever'), move: panel.querySelector('.rc-move-stick'), dial: panel.querySelector('.rc-rotate-dial'),
    frame(time) {const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(time));},
  };
}

test('all controls are available before a preview; preparing one does not cancel its first drag', () => {
  const f = setup(ui => {
    // A preview initialization can synchronously refresh the inspector.
    ui.setState({enabled: false, visible: true});
    ui.setState({enabled: true, visible: true});
  });
  assert.equal(f.panel.hidden, false);
  for (const control of [f.move, f.dial, f.lift]) assert.equal(control.disabled, false);
  assert.deepEqual(f.calls.start, []);
  emit(f.lift, 'pointerdown');
  assert.deepEqual(f.calls.start, ['lift']);
  assert.equal(f.lift.hasPointerCapture(1), true);
  assert.deepEqual(f.calls.end, []);
  assert.equal(f.calls.lift.length, 0, 'grabbing the handle must not jump the furniture');
  emit(f.lift, 'pointermove', {clientY: 0}); f.frame(0); f.frame(20);
  assert.equal(f.calls.lift[0].speed, 1);
});

test('lift has a neutral zone, proportional speed, both directions and stops on release', () => {
  const f = setup(); emit(f.lift, 'pointerdown');
  emit(f.lift, 'pointermove', {clientY: 118}); f.frame(0); f.frame(20);
  assert.equal(f.calls.lift.length, 0);
  emit(f.lift, 'pointermove', {clientY: 82}); f.frame(40);
  const slow = f.calls.lift.at(-1).speed;
  assert.ok(slow > .4 && slow < .5);
  emit(f.lift, 'pointermove', {clientY: -500}); f.frame(60);
  assert.equal(f.calls.lift.at(-1).speed, 1);
  assert.equal(f.lift.getAttribute('aria-valuenow'), '100');
  emit(f.lift, 'pointermove', {clientY: 500}); f.frame(80);
  assert.equal(f.calls.lift.at(-1).speed, -1);
  emit(f.lift, 'pointerup');
  const count = f.calls.lift.length; f.frame(100);
  assert.equal(f.calls.lift.length, count);
  assert.equal(f.lift.getAttribute('aria-valuenow'), '0');
  assert.equal(f.lift.getAttribute('aria-valuetext'), '已停止');
  assert.equal(f.lift.hasPointerCapture(1), false);
  assert.deepEqual(f.calls.end, ['lift']);
});

test('pointer interruption, window blur, hidden document and disabled controls stop lift', () => {
  for (const interrupt of [
    f => emit(f.lift, 'pointercancel'),
    f => emit(f.lift, 'lostpointercapture'),
    f => emit(f.win, 'blur'),
    f => {f.doc.hidden = true; emit(f.doc, 'visibilitychange');},
    f => f.ui.setState({enabled: false, visible: true}),
  ]) {
    const f = setup(); emit(f.lift, 'pointerdown');
    emit(f.lift, 'pointermove', {clientY: 0}); f.frame(0); f.frame(20);
    interrupt(f); f.frame(40);
    assert.equal(f.calls.lift.length, 1);
    assert.equal(f.lift.getAttribute('aria-valuenow'), '0');
    assert.deepEqual(f.calls.end, ['lift']);
    assert.equal(f.frames.size, 0);
  }
});

test('lift keyboard controls handle opposing keys, key release and focus loss', () => {
  const f = setup();
  assert.equal(emit(f.lift, 'keydown', {key: 'ArrowUp'}).defaultPrevented, true);
  f.frame(0); f.frame(20); assert.equal(f.calls.lift.at(-1).speed, 1);
  emit(f.lift, 'keydown', {key: 'ArrowDown'}); f.frame(40);
  assert.equal(f.calls.lift.length, 1, 'opposing directions must stop lift');
  emit(f.lift, 'keyup', {key: 'ArrowUp'}); f.frame(60);
  assert.equal(f.calls.lift.at(-1).speed, -1);
  emit(f.lift, 'keyup', {key: 'ArrowDown'}); f.frame(80);
  assert.equal(f.lift.getAttribute('aria-valuenow'), '0');
  emit(f.lift, 'keydown', {key: 'ArrowUp'}); f.frame(100); f.frame(120);
  emit(f.lift, 'blur'); f.frame(140);
  assert.equal(f.calls.lift.length, 3);
  assert.equal(f.frames.size, 0);
});

test('wall-mounted furniture keeps the controls visible but only permits the wall joystick', () => {
  const f = setup(); f.ui.setState({enabled: true, visible: true, wall: true});
  assert.equal(f.panel.hidden, false);
  assert.equal(f.move.disabled, false);
  assert.equal(f.dial.disabled, true);
  assert.equal(f.lift.disabled, true);
  emit(f.lift, 'pointerdown'); emit(f.dial, 'pointerdown');
  assert.deepEqual(f.calls.start, []);
  emit(f.move, 'pointerdown', {clientX: 95}); f.frame(0); f.frame(20);
  assert.deepEqual(f.calls.start, ['move']);
  assert.ok(f.calls.move.at(-1).x > 0);
});

test('a rejected preview does not capture the pointer or animate', () => {
  const f = setup(() => false); emit(f.lift, 'pointerdown');
  assert.equal(f.lift.hasPointerCapture(1), false);
  assert.equal(f.frames.size, 0);
  assert.deepEqual(f.calls.end, []);
});

test('rotation uses the same direct-start path without changing the movement control', () => {
  const f = setup();
  emit(f.dial, 'pointerdown', {clientX: 50, clientY: 70});
  emit(f.dial, 'pointermove', {clientX: 100, clientY: 120});
  assert.deepEqual(f.calls.start, ['rotate']);
  assert.ok(Math.abs(f.calls.rotate[0] + Math.PI / 2) < 1e-9);
  assert.equal(f.move.disabled, false);
  emit(f.dial, 'pointerup');
  assert.deepEqual(f.calls.end, ['rotate']);
});
