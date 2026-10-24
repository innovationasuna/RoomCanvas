import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SettledRender} from '../settled-render.mjs';

function fixture(options = {}) {
  let now = 0, id = 0, renders = 0;
  const timers = new Map();
  const scheduler = new SettledRender({
    render: () => renders++,
    setTimer: (callback, delay) => {timers.set(++id, {at: now + delay, callback}); return id;},
    clearTimer: key => timers.delete(key), ...options,
  });
  const advance = ms => {
    const end = now + ms;
    while (true) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at; timers.delete(next[0]); next[1].callback();
    }
    now = end;
  };
  return {scheduler, advance, timers, get renders() {return renders;}};
}

test('continuous camera/object changes defer AO; one update runs after settling, then nothing while idle', () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) {f.scheduler.invalidate(); f.advance(16);}
  assert.equal(f.renders, 0);
  assert.equal(f.timers.size, 1);
  f.advance(350);
  assert.equal(f.renders, 1);
  f.advance(10000);
  assert.equal(f.renders, 1);
  assert.equal(f.timers.size, 0);
  f.scheduler.invalidate(); f.advance(350);
  assert.equal(f.renders, 2);
});

test('a held gesture or orbit does not trigger AO even if the object has stopped briefly', () => {
  let busy = true;
  const f = fixture({busy: () => busy});
  f.scheduler.invalidate(); f.advance(2100);
  assert.equal(f.renders, 0);
  busy = false; f.advance(350);
  assert.equal(f.renders, 1);
  assert.equal(f.timers.size, 0);
});

test('hidden tabs cancel pending work and resume with the latest dirty state', () => {
  const f = fixture();
  f.scheduler.invalidate(); f.advance(100); f.scheduler.pause();
  f.scheduler.invalidate(); f.advance(5000);
  assert.equal(f.timers.size, 0);
  assert.equal(f.renders, 0);
  f.scheduler.resume(); f.advance(350);
  assert.equal(f.renders, 1);
  f.scheduler.pause(); f.scheduler.resume(); f.advance(1000);
  assert.equal(f.renders, 1);
});

test('failed AO falls back once without retrying on every editor update', () => {
  const errors = [], failure = new Error('context unavailable');
  const f = fixture({render: () => {throw failure;}, onError: error => errors.push(error)});
  f.scheduler.invalidate(); f.advance(350);
  assert.deepEqual(errors, [failure]);
  assert.equal(f.scheduler.updates, 0);
  f.scheduler.invalidate(); f.advance(5000);
  assert.equal(errors.length, 1);
  assert.equal(f.timers.size, 0);
});

test('disposing with a pending update prevents later rendering', () => {
  const f = fixture();
  f.scheduler.invalidate(); f.scheduler.dispose(); f.scheduler.resume(); f.scheduler.invalidate();
  f.advance(5000);
  assert.equal(f.renders, 0);
  assert.equal(f.timers.size, 0);
});
