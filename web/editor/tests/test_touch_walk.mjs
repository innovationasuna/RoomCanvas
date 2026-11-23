import test from 'node:test';
import assert from 'node:assert/strict';
import {bindTouchWalk} from '../touch-walk.mjs';

test('movement releases on leaving button, cancellation, focus loss, or hidden page', t => {
  const previous = [globalThis.window, globalThis.document];
  globalThis.window = new EventTarget(); globalThis.document = new EventTarget();
  t.after(() => {[globalThis.window, globalThis.document] = previous;});
  const button = new EventTarget(); button.dataset = {walkKey: 'KeyW'};
  button.setPointerCapture = () => {}; button.getBoundingClientRect = () => ({left: 0, top: 0, right: 48, bottom: 48});
  const held = new Set();
  const cleanup = bindTouchWalk({querySelectorAll: () => [button]}, {hold: (key, on) => on ? held.add(key) : held.delete(key), stop: () => held.clear()});
  const pointer = (type, x = 20) => button.dispatchEvent(Object.assign(new Event(type), {pointerId: 1, clientX: x, clientY: 20}));
  pointer('pointerdown'); assert.ok(held.has('KeyW')); pointer('pointermove', 60); assert.equal(held.size, 0);
  pointer('pointerdown'); pointer('pointercancel'); assert.equal(held.size, 0);
  pointer('pointerdown'); pointer('lostpointercapture'); assert.equal(held.size, 0);
  pointer('pointerdown'); window.dispatchEvent(new Event('blur')); assert.equal(held.size, 0);
  pointer('pointerdown'); document.hidden = true; document.dispatchEvent(new Event('visibilitychange')); assert.equal(held.size, 0);
  pointer('pointerdown'); cleanup(); assert.equal(held.size, 0);
  pointer('pointerdown'); assert.equal(held.size, 0, 'disposed controls cannot start walking');
});
