import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTimeline, sceneAt, outcome, clock, DURATION} from '../../replay/timeline.mjs';

const stages = ['scan', 'layout', 'photos', 'plan', 'assemble', 'review'].map((id) => ({id, name: id, desc: ''}));
const events = [
  {stage: 'scan', minute: 0, kind: 'milestone', say: 'start'},
  {stage: 'layout', minute: 0.02, kind: 'tool', say: 'layout', show: ['@boxes']},
  {stage: 'plan', minute: 10, kind: 'tool', say: 'bed', show: ['Bed0']},
  {stage: 'plan', minute: 40, kind: 'milestone', say: 'seed', model: 'seed'},
  {stage: 'assemble', minute: 60, kind: 'think', say: 'look'},
  {stage: 'review', minute: 95, kind: 'review', say: 'r1', score: 4, passed: false, model: 'round0'},
  {stage: 'review', minute: 120, kind: 'review', say: 'r2', score: 5, passed: false},
];

test('only reached stages are laid out, back to back over the whole duration', () => {
  const tl = buildTimeline({stages, events});
  assert.deepEqual(tl.stages.map((s) => s.id), ['scan', 'layout', 'plan', 'assemble', 'review']);
  assert.equal(tl.stages[0].replay[0], 0);
  assert.equal(tl.stages.at(-1).replay[1], DURATION);
  for (let k = 1; k < tl.stages.length; k++) assert.equal(tl.stages[k].replay[0], tl.stages[k - 1].replay[1]);
  // real intervals are continuous and end at each stage's last event
  assert.deepEqual(tl.stages.map((s) => s.real), [[0, 0], [0, 0.02], [0.02, 40], [40, 60], [60, 120]]);
});

test('events sit inside their stage and the clock reads real time', () => {
  const tl = buildTimeline({stages, events});
  for (const e of tl.events) {
    const s = tl.stages.find((x) => x.id === e.stage);
    assert.ok(e.at >= s.replay[0] && e.at <= s.replay[1]);
  }
  assert.equal(tl.events[0].at, 0);
  const seed = tl.events.find((e) => e.model === 'seed');
  assert.ok(Math.abs(tl.realAt(seed.at) - 40) < 1e-9);
  assert.equal(tl.realAt(DURATION), 120);
  assert.equal(clock(122.5), '2:02:30');
});

test('the scene shows the latest model reached and the objects built so far', () => {
  const tl = buildTimeline({stages, events});
  const bed = tl.events.find((e) => e.say === 'bed');
  const before = sceneAt(tl, bed.at - 0.01), after = sceneAt(tl, bed.at);
  assert.equal(before.built.has('Bed0'), false);
  assert.equal(after.built.has('Bed0'), true);
  assert.equal(after.model, null);
  assert.equal(sceneAt(tl, tl.events.find((e) => e.model === 'seed').at).model, 'seed');
  assert.equal(sceneAt(tl, DURATION).model, 'round0');
  assert.equal(sceneAt(tl, 0).points >= 0, true);
});

test('the closing line counts rounds and says whether it passed', () => {
  assert.deepEqual(outcome(events), {passed: false, text: '验收查了 2 轮，最高 5.0 分，没达到发布标准'});
  assert.equal(outcome([{kind: 'review', score: 8, passed: true}]).text, '验收通过（8.0 分）');
  assert.equal(outcome([{kind: 'tool'}]), null);
});

test('an empty job still builds a usable timeline', () => {
  const tl = buildTimeline({stages, events: []});
  assert.equal(tl.stages.length, 0);
  assert.equal(tl.indexAt(10), -1);
  assert.equal(tl.realAt(10), 0);
});

test('while the agent works, the final model shows with only the parts named so far', () => {
  const data = {stages, events, models: {seed: 's', final: 'f', round0: 'r'},
    build: {base: 50, reveal: [{node: 'Curtain', minute: 50}, {node: 'Lamp', minute: 58}]}};
  const tl = buildTimeline(data);
  const at = (minute) => {let lo = 0, hi = DURATION; for (let i = 0; i < 50; i++) {const m = (lo + hi) / 2; if (tl.realAt(m) < minute) lo = m; else hi = m;} return hi;};
  assert.equal(sceneAt(tl, at(45)).model, 'seed');
  const early = sceneAt(tl, at(52));
  assert.equal(early.model, 'final');
  assert.deepEqual([...early.added], ['Curtain']);
  assert.deepEqual([...sceneAt(tl, at(59)).added], ['Curtain', 'Lamp']);
  const review = sceneAt(tl, tl.events.find((e) => e.model === 'round0').at);
  assert.equal(review.model, 'round0');
  assert.equal(review.added, null);
  // without the final model (a live job) nothing changes until the next saved model
  assert.equal(sceneAt(buildTimeline({...data, models: {seed: 's'}}), at(52)).model, 'seed');
});
