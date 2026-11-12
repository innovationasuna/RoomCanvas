import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTimeline, sceneAt, outcome, withoutScores, withoutErrors, clock, DURATION} from '../../replay/timeline.mjs';

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

test('the closing line says whether the check passed or the room was repaired, with no score', () => {
  assert.deepEqual(outcome(events), {passed: false, repaired: false, text: '没通过检查'});
  assert.deepEqual(outcome([{kind: 'review', passed: true}]), {passed: true, repaired: false, text: '检查通过'});
  const fixed = outcome([{kind: 'review', passed: false}, {id: 'fix0', kind: 'result'}]);
  assert.equal(fixed.repaired, true);
  assert.equal(fixed.passed, true);
  assert.equal(outcome([{kind: 'review', passed: false}, {id: 'fix0', kind: 'error'}]).passed, false);
  // A retried job: the repair belongs to the earlier run, the last check failed after it.
  assert.equal(outcome([{kind: 'review', passed: false}, {id: 'fix0', kind: 'result'}, {kind: 'review', passed: false}]).passed, false);
  assert.equal(outcome([{kind: 'tool'}]), null);
});

test('text shown to people has no scores', () => {
  assert.equal(withoutScores('第 1 轮验收 4.5 分，没通过：床面太亮'), '第 1 次检查，没通过：床面太亮');
  assert.equal(withoutScores('自评 6.5 分，继续调整窗帘'), '继续调整窗帘');
  assert.equal(withoutScores('自评 6.5 分'), '完成一次自查');
  assert.equal(withoutScores('把椅子分成 2 类'), '把椅子分成 2 类');
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

const gapsOf = (tl, stage) => {
  const at = tl.events.filter((e) => e.stage === stage).map((e) => e.at);
  return at.slice(1).map((t, k) => t - at[k]);
};

test('playback follows real time in proportion', () => {
  // steps of 1-2 minutes in a 100-minute job: short of a long wait, so kept as they are
  const ev = [{stage: 'scan', minute: 0}, ...[10, 11, 12, 14].map((minute) => ({stage: 'assemble', minute, kind: 'think'})),
    {stage: 'review', minute: 100, kind: 'review'}];
  const [a, b, c] = gapsOf(buildTimeline({stages, events: ev}), 'assemble');
  assert.ok(Math.abs(a - b) < 1e-6);
  assert.ok(Math.abs(c - 2 * a) < 1e-6);
});

test('a long wait with nothing new is squeezed', () => {
  const ev = [{stage: 'scan', minute: 0}, ...[10, 20, 30, 230].map((minute) => ({stage: 'assemble', minute, kind: 'think'}))];
  const [a, , c] = gapsOf(buildTimeline({stages, events: ev}), 'assemble');
  assert.ok(c < 20 * a / 2, `200 minutes of waiting took ${c / a}× a 10-minute step`);
  assert.ok(c > a);
});

test('each object taking shape keeps time to watch it, and many objects lengthen the playback', () => {
  const objects = Array.from({length: 30}, (_, k) => ({stage: 'plan', minute: 10 + k * 0.01, show: [`Chair${k}`]}));
  const tl = buildTimeline({stages, events: [{stage: 'scan', minute: 0}, ...objects, {stage: 'review', minute: 200, kind: 'review'}]});
  assert.ok(gapsOf(tl, 'plan').every((g) => g >= 4.5 - 1e-6));
  assert.ok(tl.duration > DURATION);
  assert.equal(tl.stages.at(-1).replay[1], tl.duration);
  // a short job keeps the usual length
  assert.equal(buildTimeline({stages, events}).duration, DURATION);
});

test('quick stages still show for a moment and events keep their order', () => {
  const tl = buildTimeline({stages, events});
  const layout = tl.stages.find((s) => s.id === 'layout');
  assert.ok(layout.replay[1] - layout.replay[0] >= 2 - 1e-6);
  tl.events.forEach((e, k) => k && assert.ok(e.at >= tl.events[k - 1].at));
});

test('parts the agent names at the same minute take shape as one batch', () => {
  const reveal = Array.from({length: 40}, (_, k) => ({node: `Part${k}`, minute: 50 + (k % 2)}));
  const tl = buildTimeline({stages, events, models: {final: 'f'}, build: {base: 50, reveal}});
  assert.equal(tl.duration, DURATION);  // two batches, not forty objects
});

test('failed attempts and errors are left off the page; the check verdict stays', () => {
  const events = [{kind: 'tool', say: '做好柜子的模型'}, {kind: 'error', say: '门的模型这次没做成'},
                  {kind: 'review', passed: false, say: '检查房间没通过'}, {kind: 'result', say: '按检查出的问题修好了房间'}];
  assert.deepEqual(withoutErrors(events).map((e) => e.say), ['做好柜子的模型', '检查房间没通过', '按检查出的问题修好了房间']);
});
