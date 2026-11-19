import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTimeline, sceneAt, outcome} from '../../replay/timeline.mjs';

// A run with the small-object pass between the checks and the openable parts, as the room service sends it.
const stages = ['scan', 'plan', 'assemble', 'review', 'small_objects', 'articulate'].map((id) => ({id, name: id, desc: ''}));
const events = [
  {stage: 'scan', minute: 0, kind: 'milestone', say: 'start'},
  {stage: 'plan', minute: 10, kind: 'tool', say: 'bed', show: ['Bed0']},
  {stage: 'plan', minute: 40, kind: 'milestone', say: 'seed', model: 'seed'},
  {stage: 'assemble', minute: 60, kind: 'think', say: 'look'},
  {stage: 'review', minute: 90, kind: 'review', say: 'check', passed: true, model: 'round0'},
  {stage: 'review', minute: 95, kind: 'milestone', say: 'final', model: 'final'},
  {stage: 'small_objects', minute: 200, kind: 'think', say: 'small'},
  {stage: 'small_objects', minute: 230, kind: 'tool', say: 'tissue box'},
  {stage: 'small_objects', minute: 260, kind: 'milestone', say: 'small done', model: 'small_objects'},
  {stage: 'articulate', minute: 300, kind: 'think', say: 'parts'},
  {stage: 'articulate', minute: 330, kind: 'milestone', say: 'published', model: 'articulated'},
];
const models = {seed: 's', round0: 'r', final: 'f', small_objects: 'so', articulated: 'a'};
const build = {base: 50, reveal: [{node: 'Curtain', minute: 50}]};
const at = (tl, say) => tl.events.find((e) => e.say === say).at;

test('the room with the small objects shows between the final room and the openable-parts room', () => {
  const tl = buildTimeline({stages, events, models, build});
  assert.deepEqual(tl.stages.map((s) => s.id), ['scan', 'plan', 'assemble', 'review', 'small_objects', 'articulate']);
  assert.equal(sceneAt(tl, at(tl, 'small')).model, 'final');
  assert.equal(sceneAt(tl, at(tl, 'tissue box')).model, 'final');
  const small = sceneAt(tl, at(tl, 'small done'));
  assert.equal(small.model, 'small_objects');
  assert.equal(small.added, null);  // the agent's parts are only picked out of the final model
  assert.equal(sceneAt(tl, at(tl, 'parts')).model, 'small_objects');
  assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
  assert.deepEqual(outcome(tl.events), {passed: true, repaired: false, text: '检查通过'});
});

test('without the pass the openable-parts room follows the final room', () => {
  const plain = events.filter((e) => e.stage !== 'small_objects');
  const tl = buildTimeline({stages: stages.filter((s) => s.id !== 'small_objects'), events: plain,
    models: {...models, small_objects: undefined}, build});
  assert.deepEqual(tl.stages.map((s) => s.id), ['scan', 'plan', 'assemble', 'review', 'articulate']);
  assert.equal(sceneAt(tl, at(tl, 'parts')).model, 'final');
  assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
});
