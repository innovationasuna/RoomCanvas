import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTimeline, comparisonAt, readReplay, sceneAt, outcome} from '../../replay/timeline.mjs';

const stages = ['plan', 'assemble', 'parts', 'review'].map(id => ({id, name: id, desc: ''}));
const events = [
  {stage: 'plan', minute: 0, kind: 'milestone', say: 'seed', model: 'seed'},
  {stage: 'assemble', minute: 1, kind: 'tool', say: 'author'},
  {stage: 'assemble', minute: 2, kind: 'tool', say: 'photo', work: 'small', object_id: 'Cup0'},
  {stage: 'assemble', minute: 3, kind: 'milestone', say: 'placed', model: 'small_objects'},
  {stage: 'parts', minute: 4, kind: 'milestone', say: 'joints', model: 'articulated'},
  {stage: 'review', minute: 5, kind: 'review', say: 'check', passed: true},
];
const data = {stages, events, models: {seed: 's', final: 'f', small_objects: 'so', articulated: 'a'},
  build: {base: 1, reveal: [{node: 'Table0', minute: 1}]},
  hidden_nodes: {seed: ['Cup0'], assembly: ['Cup0'], final: ['PowerLead0']}};
const at = (tl, say) => sceneAt(tl, tl.events.find(e => e.say === say).at);

test('assembly switches to the placed small items before the parts and check, including on rewind', () => {
  const tl = buildTimeline(data);
  assert.deepEqual(tl.stages.map(s => s.id), ['plan', 'assemble', 'parts', 'review']);
  assert.deepEqual(at(tl, 'seed').hiddenNodes, ['Cup0']);
  const early = at(tl, 'photo');
  assert.equal(early.model, 'final');
  assert.deepEqual(new Set(early.hiddenNodes), new Set(['Cup0', 'PowerLead0']));
  const placed = at(tl, 'placed');
  assert.equal(placed.model, 'small_objects');
  assert.equal(placed.added, null);
  assert.equal(placed.hiddenNodes, undefined);
  assert.equal(at(tl, 'check').model, 'articulated');
  assert.equal(at(tl, 'author').model, 'final');
  assert.deepEqual(at(tl, 'author').hiddenNodes, early.hiddenNodes);
  assert.deepEqual(outcome(tl.events), {passed: true, repaired: false, text: '检查通过'});
});

test('a photo event without a saved placement keeps the current room and its mask', () => {
  const tl = buildTimeline({...data, events: events.slice(0, 3), models: {final: 'f', seed: 's'}});
  assert.equal(at(tl, 'photo').model, 'final');
  assert.ok(at(tl, 'photo').hiddenNodes.includes('Cup0'));
});

const oldStages = ['plan', 'assemble', 'review', 'small_objects', 'articulate'].map(id => ({id, name: id, desc: ''}));
const oldPass = [
  {id: 'photo', stage: 'small_objects', minute: 100, object_id: 'Cup0', work: 'small',
    say: '杯子换成了按照片重建的模型', img: 'cup.jpg', media: [{role: 'comparison', minute: 110, src: 'pair.jpg'}]},
  {id: 'placed', stage: 'small_objects', minute: 109, model: 'small_objects'},
  {id: 'joints', stage: 'articulate', minute: 130, model: 'articulated'},
];
const oldRun = {stages: oldStages, models: {seed: 's', round0: 'r', final: 'f', small_objects: 'so', articulated: 'a'},
  events: [{id: 'seed', stage: 'plan', minute: 0, model: 'seed'},
    {id: 'author', stage: 'assemble', minute: 10},
    {id: 'check', stage: 'review', minute: 20, model: 'round0', kind: 'review', img: 'original.png', passed: false},
    {id: 'final', stage: 'review', minute: 21, model: 'final'}, ...oldPass],
  build: {base: 9, reveal: [{node: 'Cup0', minute: 9}, {node: 'Lamp0', minute: 10}]}};

test('offline pass pictures, models and verdict use stage order and retain their recorded times', () => {
  const projected = readReplay(oldRun), tl = buildTimeline(projected);
  assert.equal(projected.presentation, 'by_stage');
  assert.deepEqual(tl.stages.map(s => s.id), ['plan', 'assemble', 'parts', 'review']);
  assert.deepEqual(tl.events.map(e => e.id), ['seed', 'author', 'photo', 'placed', 'joints', 'check', 'final']);
  const [, , photo, placed, , check] = tl.events;
  assert.equal(photo.say, '杯子的照片模型已就绪');
  assert.deepEqual([photo.stage, photo.minute, photo.display_minute, tl.realAt(photo.at)], ['assemble', 100, 20, 20]);
  assert.deepEqual([check.recorded_model, check.img, check.passed], ['round0', 'original.png', false]);
  assert.deepEqual(projected.hidden_nodes.final, ['Cup0']);
  assert.deepEqual(tl.build.reveal.map(r => r.node), ['Lamp0']);
  assert.equal(comparisonAt(photo, tl, photo.at), null);
  assert.equal(comparisonAt(photo, tl, placed.at)?.src, 'pair.jpg');
  assert.equal(sceneAt(tl, placed.at).model, 'small_objects');
  assert.equal(sceneAt(tl, check.at).model, 'articulated');
  for (const [k, e] of tl.events.entries()) {
    assert.equal(tl.stageAt(e.at).id, e.stage);
    assert.equal(tl.indexAt(e.at), k);
  }
  assert.deepEqual(readReplay(projected), projected);
  assert.equal(oldRun.events[2].model, 'round0');
});

test('offline missing pass saves keep the recorded review and do not offer an after-picture', () => {
  const events = oldRun.events.filter(e => !['placed', 'joints'].includes(e.id));
  const tl = buildTimeline(readReplay({...oldRun, events}));
  const check = tl.events.find(e => e.id === 'check'), photo = tl.events.find(e => e.id === 'photo');
  assert.equal(sceneAt(tl, check.at).model, 'round0');
  assert.deepEqual(sceneAt(tl, check.at).hiddenNodes, ['Cup0']);
  assert.equal(comparisonAt(photo, tl, tl.duration), null);
});

test('an old room with only an openable-parts pass has no small-object events', () => {
  const events = oldRun.events.filter(e => e.stage !== 'small_objects');
  const tl = buildTimeline(readReplay({...oldRun, stages: oldStages.filter(s => s.id !== 'small_objects'), events}));
  assert.deepEqual(tl.events.map(e => e.id), ['seed', 'author', 'joints', 'check', 'final']);
  assert.deepEqual(tl.hiddenNodes, {});
  assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
});

test('offline cached saves close their pass even when the GLB predates the photos and review', () => {
  const events = oldRun.events.map(e => e.id === 'placed' || e.id === 'joints' ? {...e, minute: 1} : e);
  events.push({id: 'open', stage: 'articulate', kind: 'think', minute: 120});
  const data = readReplay({...oldRun, events: events.sort((a, b) => a.minute - b.minute)});
  const tl = buildTimeline(data), photo = tl.events.find(e => e.id === 'photo');
  assert.deepEqual(tl.events.map(e => e.id), ['seed', 'author', 'photo', 'placed', 'open', 'joints', 'check', 'final']);
  assert.equal(comparisonAt(photo, tl, tl.duration)?.src, 'pair.jpg');
  assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
});

test('offline passes on a revised room keep the original review model and follow the revision', () => {
  const revise = {id: 'revise', name: '修改', desc: ''};
  const before = oldRun.events.slice(0, 4);
  const data = readReplay({...oldRun, stages: [...oldStages, revise],
    events: [...before, {id: 'move', stage: 'revise', minute: 50}, ...oldPass]});
  const tl = buildTimeline(data);
  assert.deepEqual(tl.events.map(e => e.id), ['seed', 'author', 'check', 'final', 'move', 'photo', 'placed', 'joints']);
  assert.equal(sceneAt(tl, tl.events.find(e => e.id === 'check').at).model, 'round0');
  assert.equal(tl.stageAt(tl.duration).id, 'revise');
  assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
  const cached = {...oldRun, presentation: 'by_stage', stages: data.stages, events: [
    ...oldPass.map(e => ({...e, recorded_stage: e.stage, stage: e.stage === 'articulate' ? 'parts' : 'assemble', display_minute: 20})),
    ...before.map(e => e.stage === 'review' ? {...e, recorded_model: e.model, model: undefined} : e),
    {id: 'move', stage: 'revise', minute: 50}]};
  assert.deepEqual(readReplay(cached).events, data.events);
});

test('an empty old pass and mixed item sources keep integrated objects in review models', () => {
  const integrated = {stage: 'assemble', minute: 12, work: 'small', object_id: 'Lamp0'};
  for (const pass of [[], oldPass]) {
    const data = readReplay({...oldRun, events: [
      ...oldRun.events.slice(0, 2), integrated, ...oldRun.events.slice(2, 4), ...pass]});
    assert.ok(data.hidden_nodes.seed.includes('Lamp0'));
    if (!pass.length) {
      assert.equal(data.presentation, undefined);
      assert.equal(data.hidden_nodes.final, undefined);
      assert.equal(sceneAt(buildTimeline(data), buildTimeline(data).duration).model, 'final');
    } else {
      assert.deepEqual(data.hidden_nodes.round0, ['Cup0']);
      assert.deepEqual(data.hidden_nodes.final, ['Cup0']);
    }
  }
});
