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
  assert.equal(tl.stages.at(-1).replay[1], tl.duration);
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
  assert.equal(tl.realAt(tl.duration), 120);
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
  assert.equal(sceneAt(tl, tl.duration).model, 'round0');
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
  assert.equal(tl.duration, DURATION);
  assert.equal(tl.indexAt(10), -1);
  assert.equal(tl.realAt(10), 0);
});

// Playback time at which the clock reaches a real minute.
const reach = (tl, minute) => {
  let lo = 0, hi = tl.duration;
  for (let i = 0; i < 50; i++) {const m = (lo + hi) / 2; if (tl.realAt(m) < minute) lo = m; else hi = m;}
  return hi;
};

test('while the agent works, the final model shows with only the parts named so far', () => {
  const data = {stages, events, models: {seed: 's', final: 'f', round0: 'r'},
    build: {base: 50, reveal: [{node: 'Curtain', minute: 50}, {node: 'Lamp', minute: 58}]}};
  const tl = buildTimeline(data);
  assert.equal(sceneAt(tl, reach(tl, 45)).model, 'seed');
  const early = sceneAt(tl, reach(tl, 52));
  assert.equal(early.model, 'final');
  assert.deepEqual([...early.added], ['Curtain']);
  assert.deepEqual([...sceneAt(tl, reach(tl, 59)).added], ['Curtain', 'Lamp']);
  const review = sceneAt(tl, tl.events.find((e) => e.model === 'round0').at);
  assert.equal(review.model, 'round0');
  assert.equal(review.added, null);
  // without the final model (a live job) nothing changes until the next saved model
  const live = buildTimeline({...data, models: {seed: 's'}});
  assert.equal(sceneAt(live, reach(live, 52)).model, 'seed');
});

const gapsOf = (tl, stage) => {
  const at = tl.events.filter((e) => e.stage === stage).map((e) => e.at);
  return at.slice(1).map((t, k) => t - at[k]);
};
// Seconds the playback stays on each event before the next one (the last: to the end).
const stay = (tl) => tl.events.map((e, k) => (tl.events[k + 1]?.at ?? tl.duration) - e.at);

test('a long run of events with nothing taking shape passes in a few seconds, however long it really took', () => {
  const checks = Array.from({length: 48}, (_, k) => ({stage: 'review', minute: 100 + k * 5.5, kind: 'result'}));
  const tl = buildTimeline({stages, events: [{stage: 'scan', minute: 0}, ...checks]});
  const run = tl.events.filter((e) => e.stage === 'review');
  const took = run.at(-1).at - run[0].at;
  assert.ok(took >= 3 && took <= 8, `48 checks over 4 hours took ${took} s`);
  // each one is still there to step or scrub to, in order (the page seeks 0.01 s past an event)
  tl.events.forEach((e, k) => assert.equal(tl.indexAt(e.at + 0.01), k));
  // a long wait takes no longer than a quick step
  const ev = [{stage: 'scan', minute: 0}, ...[10, 11, 12, 230].map((minute) => ({stage: 'assemble', minute, kind: 'think'}))];
  const [, b, c] = gapsOf(buildTimeline({stages, events: ev}), 'assemble');
  assert.ok(Math.abs(c - b) < 1e-9 && c < 0.5);
});

test('each object taking shape keeps time to watch it, once', () => {
  const objects = Array.from({length: 30}, (_, k) => ({stage: 'plan', minute: 10 + k * 0.01, show: [`Chair${k}`]}));
  const tl = buildTimeline({stages, events: [{stage: 'scan', minute: 0}, ...objects, {stage: 'review', minute: 200, kind: 'review'}]});
  assert.ok(gapsOf(tl, 'plan').every((g) => g >= 4.5 - 1e-6));
  assert.equal(tl.stages.at(-1).replay[1], tl.duration);
  // made again, the object is already in the room: nothing to watch. Events at the same minute keep their
  // order and each its own time.
  const again = buildTimeline({stages, events: [{stage: 'scan', minute: 0},
    ...['Bed0', 'Sofa0', 'Bed0', 'Lamp0'].map((id) => ({stage: 'plan', minute: 10, show: [id]})),
    {stage: 'plan', minute: 11, kind: 'result'}, {stage: 'review', minute: 200, kind: 'review'}]});
  const [bed, sofa, remade, lamp, check] = stay(again).slice(1);
  assert.ok(bed >= 4.5 && sofa >= 4.5 && lamp >= 4.5);
  assert.ok(remade < 0.5 && check < 0.5);
  // the page moves the camera in only for the ones that take shape
  assert.deepEqual(again.events.slice(1, 6).map((e) => e.forms), [1, 1, 0, 1, 0]);
  // the layout stage's boxes are no object taking shape
  assert.ok(stay(buildTimeline({stages, events}))[1] < 4.5);
});

test('a replay with many objects and long idle stretches is mostly objects taking shape', () => {
  const quiet = (stage, n, from, step) => Array.from({length: n}, (_, k) => ({stage, minute: from + k * step, kind: 'tool'}));
  // 20 objects, each checked and made once more; hours of adjusting and checking afterwards
  const made = Array.from({length: 20}, (_, k) => [
    {stage: 'plan', minute: 10 + k * 4, show: [`Thing${k}`]},
    {stage: 'plan', minute: 11 + k * 4, kind: 'result'},
    {stage: 'plan', minute: 12 + k * 4, show: [`Thing${k >> 1}`]}]).flat();
  const tl = buildTimeline({stages, events: [{stage: 'scan', minute: 0}, {stage: 'scan', minute: 0.5}, {stage: 'layout', minute: 2},
    ...quiet('photos', 14, 3, 0.3), ...made, {stage: 'plan', minute: 100, kind: 'milestone', model: 'seed'},
    ...quiet('assemble', 24, 110, 4), ...quiet('review', 48, 280, 5), {stage: 'review', minute: 520, kind: 'review', model: 'round0'}]});
  const shown = new Set(), time = stay(tl);
  let watched = 0;
  tl.events.forEach((e, k) => e.show?.forEach((id) => {if (!shown.has(id)) watched += time[k]; shown.add(id);}));
  assert.ok(Math.abs(watched - 20 * 4.5) < 1e-6);
  assert.ok(watched / tl.duration >= 0.7, `objects taking shape fill ${Math.round(watched / tl.duration * 100)}% of ${tl.duration} s`);
});

test('quick stages still show for a moment and events keep their order', () => {
  const tl = buildTimeline({stages, events}), time = stay(tl);
  for (const s of tl.stages) assert.ok(s.replay[1] - s.replay[0] >= 1 - 1e-6);
  // the scan keeps its time to unfold, a new room model its time to fade in
  assert.ok(tl.stages[0].replay[1] >= 6 - 1e-6);
  tl.events.forEach((e, k) => e.model && assert.ok(time[k] >= 2 - 1e-6));
  tl.events.forEach((e, k) => k && assert.ok(e.at >= tl.events[k - 1].at));
});

test('parts the agent names at the same minute take shape as one batch', () => {
  const reveal = Array.from({length: 40}, (_, k) => ({node: `Part${k}`, minute: 50 + (k % 2)}));
  const data = {stages, events, models: {final: 'f'}, build: {base: 50, reveal}};
  const tl = buildTimeline(data);
  // two batches, not forty objects; each keeps time for its objects to start one after another (4 s)
  const first = reach(tl, 51) - reach(tl, 50), second = reach(tl, 60) - reach(tl, 51);
  assert.ok(first >= 4.5 + 4 - 1e-6 && second >= 4.5 + 4 - 1e-6);
  assert.ok(Math.abs(tl.duration - buildTimeline({stages, events}).duration - first - second) < 1e-6);
  // parts named once the check's room model shows come in with the next model: nothing takes shape
  const late = buildTimeline({...data, build: {base: 50, reveal: [...reveal, {node: 'Late', minute: 100}]}});
  assert.ok(Math.abs(late.duration - tl.duration) < 1e-6);
});

test('failed attempts and errors are left off the page; the check verdict stays', () => {
  const events = [{kind: 'tool', say: '做好柜子的模型'}, {kind: 'error', say: '门的模型这次没做成'},
                  {kind: 'review', passed: false, say: '检查房间没通过'}, {kind: 'result', say: '按检查出的问题修好了房间'}];
  assert.deepEqual(withoutErrors(events).map((e) => e.say), ['做好柜子的模型', '检查房间没通过', '按检查出的问题修好了房间']);
});
