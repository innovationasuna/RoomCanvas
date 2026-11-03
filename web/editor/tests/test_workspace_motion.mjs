import test from 'node:test';
import assert from 'node:assert/strict';
import {createContentMotion} from '../workspace-motion.mjs';

function fixture(reduced = false) {
  let listener;
  const preference = {matches:reduced, addEventListener(_, callback) {listener = callback;}, removeEventListener() {listener = null;}};
  const animations = [];
  const element = {animate() {
    let resolve, reject;
    const animation = {cancelled:false, finished:new Promise((yes, no) => {resolve = yes; reject = no;}),
      finish() {resolve();}, cancel() {this.cancelled = true; reject(new Error('cancelled'));}};
    animations.push(animation); return animation;
  }};
  return {element, animations, motion:createContentMotion(preference),
    reduce(value) {preference.matches = value; listener?.();}, get listening() {return !!listener;}};
}

test('rapid furniture changes replace the animation without delaying content updates', async () => {
  const f = fixture();
  f.motion.refresh([f.element]);
  f.motion.refresh([f.element]);
  assert.equal(f.animations[0].cancelled, true);
  assert.equal(f.animations[1].cancelled, false);
  await Promise.resolve(); // A stale cancellation must not remove the replacement.
  f.motion.refresh([f.element]);
  assert.equal(f.animations[1].cancelled, true);
  assert.equal(f.animations[2].cancelled, false);
  f.motion.dispose();
});

test('reduced motion skips animations and changing the preference stops active motion immediately', () => {
  const f = fixture(true);
  f.motion.refresh([f.element]); assert.equal(f.animations.length, 0);
  f.reduce(false); f.motion.refresh([f.element]); assert.equal(f.animations.length, 1);
  f.reduce(true); assert.equal(f.animations[0].cancelled, true);
  f.motion.refresh([f.element]); assert.equal(f.animations.length, 1);
  f.motion.dispose(); assert.equal(f.listening, false);
});

test('completed motion is released and unsupported animation APIs keep content usable', async () => {
  const f = fixture();
  assert.doesNotThrow(() => f.motion.refresh([{}]));
  f.motion.refresh([f.element]); f.animations[0].finish();
  await Promise.resolve();
  f.motion.dispose();
  assert.equal(f.animations[0].cancelled, false);
});
