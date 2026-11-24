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
// The photo items shown (from their own records), as a list.
const shown = scene => scene.photoShow && [...scene.photoShow];

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
  assert.deepEqual([check.model, check.img, check.passed], ['round0', 'original.png', false]);
  assert.deepEqual(projected.hidden_nodes.final, ['Cup0']);
  assert.deepEqual(tl.build.reveal.map(r => r.node), ['Lamp0']);
  assert.equal(comparisonAt(photo, tl, photo.at), null);
  assert.equal(comparisonAt(photo, tl, placed.at)?.src, 'pair.jpg');
  // Without a revision the cached schedule belongs to the final room, which then stands for the build.
  assert.equal(sceneAt(tl, placed.at).model, 'final');
  assert.deepEqual(sceneAt(tl, placed.at).photoItems.ids, ['Cup0']);
  assert.deepEqual(shown(sceneAt(tl, placed.at)), ['Cup0']);
  assert.equal(sceneAt(tl, check.at).model, 'round0');
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
  assert.equal(sceneAt(tl, tl.events.find(e => e.id === 'check').at).model, 'round0');
  assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
  assert.deepEqual(sceneAt(tl, tl.duration).photoItems.ids, ['Cup0']);
});

test('offline passes on a revised room keep the original review model and follow the revision', () => {
  const revise = {id: 'revise', name: '修改', desc: ''};
  const before = oldRun.events.slice(0, 4);
  const data = readReplay({...oldRun, stages: [...oldStages, revise],
    events: [...before, {id: 'move', stage: 'revise', minute: 50}, ...oldPass]});
  const tl = buildTimeline(data);
  assert.deepEqual(tl.events.map(e => e.id), ['seed', 'author', 'photo', 'placed', 'check', 'final', 'move', 'joints']);
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

test('a #157 cache moves just the independent items and retains the follow target and evidence on rewind', () => {
  const cached = {...oldRun, presentation: 'by_stage', latest_event: 'placed',
    stages: [...stages, {id: 'revise'}], hidden_nodes: {seed: ['Cup0'], round0: ['Cup0'], final: ['Cup0']},
    events: [...oldRun.events.slice(0, 4), {id: 'move', stage: 'revise', minute: 50},
      ...oldPass.map(e => ({...e, stage: 'revise', recorded_stage: e.stage, display_minute: e.minute}))]};
  const data = readReplay(cached), tl = buildTimeline(data);
  const [seed, author, photo, placed, check, final, , joints] = tl.events;
  assert.equal(photo.stage, 'assemble');
  assert.equal(placed.overlay_model, 'small_objects');
  assert.equal(placed.model, undefined);
  assert.equal(tl.latestAt, placed.at);
  assert.equal(sceneAt(tl, joints.at).model, 'articulated');
  assert.equal(sceneAt(tl, final.at).model, 'final');
  assert.equal(sceneAt(tl, check.at).model, 'round0');
  // Its schedule came from the revised final room: the first review's room appears with the photo card.
  assert.equal(tl.build, null);
  assert.deepEqual([sceneAt(tl, author.at).model, shown(sceneAt(tl, author.at))], ['seed', []]);
  assert.deepEqual([sceneAt(tl, photo.at).model, shown(sceneAt(tl, photo.at))], ['round0', ['Cup0']]);
  assert.deepEqual(sceneAt(tl, author.at).photoItems.ids, ['Cup0']);
  assert.equal(shown(sceneAt(tl, seed.at)), null);
  assert.equal(comparisonAt(photo, tl, placed.at)?.src, 'pair.jpg');
  assert.equal(comparisonAt(photo, tl, photo.at), null);
  assert.deepEqual(readReplay(data), data);
});

test('an old cache pairs its schedule with its room: build, first review and revision at minutes 10/20/55', () => {
  const cached = {presentation: 'by_stage', latest_event: 'joints', stages: [...stages, {id: 'revise'}],
    models: {seed: 's', round0: 'r', final: 'f', small_objects: 'so', articulated: 'a'},
    hidden_nodes: {seed: ['Cup0'], round0: ['Cup0'], final: ['Cup0']},
    build: {base: 55, reveal: [{node: 'Poster0', minute: 55}]},  // from the revised final room
    events: [{id: 'seed', stage: 'plan', minute: 5, model: 'seed'}, {id: 'author', stage: 'assemble', minute: 10},
      {id: 'check', stage: 'review', minute: 20, model: 'round0', kind: 'review'}, {id: 'move', stage: 'revise', minute: 50},
      {id: 'final', stage: 'revise', minute: 55, model: 'final'},
      {id: 'photo', stage: 'revise', recorded_stage: 'small_objects', minute: 60, display_minute: 60, work: 'small', object_id: 'Cup0'},
      {id: 'placed', stage: 'revise', recorded_stage: 'small_objects', minute: 61, display_minute: 61, model: 'small_objects'},
      {id: 'joints', stage: 'revise', recorded_stage: 'articulate', minute: 70, display_minute: 70, model: 'articulated'}]};
  const tl = buildTimeline(readReplay(cached));
  const at = id => sceneAt(tl, tl.events.find(e => e.id === id).at);
  assert.deepEqual([tl.build, tl.buildModel], [null, 'round0']);
  assert.deepEqual(tl.events.map(e => e.id), ['seed', 'author', 'photo', 'placed', 'check', 'move', 'final', 'joints']);
  assert.deepEqual([at('author').model, at('author').added, shown(at('author'))], ['seed', null, []]);
  assert.deepEqual([at('photo').model, at('photo').added, shown(at('photo'))], ['round0', null, ['Cup0']]);
  assert.deepEqual(at('photo').hiddenNodes, ['Cup0']);
  assert.equal(at('check').model, 'round0');
  assert.deepEqual([at('final').model, at('final').added], ['final', null]);
  // The cache names no source for the openable parts: the photo items stay overlaid (see holdsPhotos).
  assert.deepEqual([at('joints').model, shown(at('joints'))], ['articulated', ['Cup0']]);
  assert.equal(at('author').model, 'seed');
});

test('a small-object step without a saved room or a photo item keeps the openable-parts room at the end', () => {
  const start = {id: 'start', stage: 'small_objects', minute: 100, kind: 'think'};
  const saved = {id: 'placed', stage: 'small_objects', minute: 109, model: 'small_objects'};
  for (const pass of [[start], [start, saved]]) {
    const data = readReplay({...oldRun, events: [...oldRun.events.slice(0, 4), ...pass, oldPass[2]]});
    const tl = buildTimeline(data);
    assert.equal(tl.photoItems, null);
    assert.ok(!tl.events.some(e => e.overlay_model));
    assert.equal(sceneAt(tl, tl.duration).model, 'articulated');
    assert.equal(shown(sceneAt(tl, tl.duration)), null);
  }
});

test('an openable-parts room cut from the photo room keeps its own photo meshes', () => {
  const current = joints => buildTimeline({stages, presentation: 'by_stage', latest_event: 'joints',
    models: {seed: 's', round0: 'r', final: 'f', small_objects: 'so', articulated: 'a'},
    hidden_nodes: {seed: ['Cup0'], round0: ['Cup0'], final: ['Cup0']},
    events: [{id: 'seed', stage: 'plan', minute: 0, model: 'seed'}, {id: 'author', stage: 'assemble', minute: 10},
      {id: 'photo', stage: 'assemble', recorded_stage: 'small_objects', minute: 100, display_minute: 20, work: 'small', object_id: 'Cup0'},
      {id: 'placed', stage: 'assemble', recorded_stage: 'small_objects', minute: 109, display_minute: 20,
        overlay_model: 'small_objects', artifact_digest: 'p'},
      {id: 'joints', stage: 'parts', recorded_stage: 'articulate', display_minute: 20, model: 'articulated', minute: 130, ...joints}]});
  // Only a source known to be the photo room holds them; a source without a digest, or none, keeps the overlay.
  for (const [joints, show] of [[{source_digest: 'p'}, null], [{source_digest: 'q'}, ['Cup0']], [{source_known: true}, ['Cup0']],
    [{}, ['Cup0']], [{minute: 50}, ['Cup0']]]) {
    const tl = current(joints);
    assert.deepEqual([sceneAt(tl, tl.duration).model, shown(sceneAt(tl, tl.duration))], ['articulated', show]);
  }
});

test('the published openable-parts room ends the replay, while each check shows the room it checked', () => {
  const pass = [
    {id: 'photo', stage: 'assemble', recorded_stage: 'small_objects', minute: 100, display_minute: 20, work: 'small', object_id: 'Cup0'},
    {id: 'placed', stage: 'assemble', recorded_stage: 'small_objects', minute: 109, display_minute: 20,
      overlay_model: 'small_objects', artifact_digest: 'p'},
    {id: 'joints', stage: 'parts', recorded_stage: 'articulate', minute: 130, display_minute: 20, model: 'articulated', source_digest: 'f'},
    {id: 'articulated_published', stage: 'parts', recorded_stage: 'articulate', minute: 131, display_minute: 20,
      model: 'articulated', source_digest: 'f', published: true}];
  const served = {stages, presentation: 'by_stage', latest_event: 'articulated_published', models: oldRun.models,
    events: [oldRun.events[0], {...oldRun.events[1]}, ...pass, ...oldRun.events.slice(2, 4)]};
  const published = {...oldPass[2], id: 'articulated_published', minute: 131, published: true};
  // The served one names the author's room as its source, the old answer none: both keep the overlay.
  const recheck = {id: 'r1', stage: 'review', minute: 21, model: 'round1', kind: 'review'};
  for (const [data, last] of [[served, 'final'], [readReplay({...oldRun, events: [...oldRun.events, published]}), 'final'],
    [{...served, models: {...served.models, round1: 'r1'}, events: [...served.events.slice(0, -1), recheck]}, 'r1']]) {
    const tl = buildTimeline(data), at = id => tl.events.find(e => e.id === id).at;
    assert.deepEqual([sceneAt(tl, at('check')).model, shown(sceneAt(tl, at('check')))], ['round0', ['Cup0']]);
    // Played through, dragged onto the last room shown (a re-check when there is no final), and to the end.
    const models = [];
    for (const t of [...Array(Math.floor(tl.duration / 0.05) + 1).keys()].map(k => k * 0.05).concat(tl.duration)) {
      if (models.at(-1) !== sceneAt(tl, t).model) models.push(sceneAt(tl, t).model);
    }
    const room = last === 'final' ? 'final' : 'round1';
    assert.deepEqual(models.slice(-3), ['round0', room, 'articulated']);
    assert.equal(sceneAt(tl, at(last)).model, room);
    assert.equal(sceneAt(tl, at(last) + 0.5).model, room);
    assert.equal(sceneAt(tl, tl.duration).modelEvent.id, 'articulated_published');
    assert.deepEqual([sceneAt(tl, tl.duration).model, shown(sceneAt(tl, tl.duration))], ['articulated', ['Cup0']]);
  }
  // A room saved after the passes' records (a later run) still ends the replay.
  const tl = buildTimeline({...served, events: served.events.map(e => e.id === 'final' ? {...e, minute: 140} : e)});
  assert.equal(sceneAt(tl, tl.duration).model, 'final');
});

test("an integrated small-object room built before the separate pass takes its photo items from their card", () => {
  const digest = 'a'.repeat(64);
  for (const [saved, show] of [[digest, [[], ['Cup0']]], ['p', [null, null]]]) {
    const data = {stages, presentation: 'by_stage', latest_event: 'placed',
      models: {seed: 's', round0: 'r', final: 'f', small_objects: 'so', [`small_${saved}`]: 'i'},
      hidden_nodes: {seed: ['Cup0'], round0: ['Cup0'], final: ['Cup0']},
      events: [{id: 'seed', stage: 'plan', minute: 0, model: 'seed'}, {id: 'author', stage: 'assemble', minute: 10},
        {id: 'lamp', stage: 'assemble', minute: 12, work: 'small', object_id: 'Lamp0'},
        {id: 'small3', stage: 'assemble', minute: 13, kind: 'milestone', model: `small_${saved}`},
        {id: 'photo', stage: 'assemble', recorded_stage: 'small_objects', minute: 100, display_minute: 20, work: 'small', object_id: 'Cup0'},
        {id: 'placed', stage: 'assemble', recorded_stage: 'small_objects', minute: 109, display_minute: 20,
          overlay_model: 'small_objects', artifact_digest: 'p'},
        {id: 'check', stage: 'review', minute: 20, model: 'round0', kind: 'review'}]};
    const tl = buildTimeline(data), at = id => sceneAt(tl, tl.events.find(e => e.id === id).at);
    assert.deepEqual([at('small3').model, shown(at('small3')), at('photo').model, shown(at('photo'))],
      [`small_${saved}`, show[0], `small_${saved}`, show[1]]);
    assert.deepEqual([at('check').model, shown(at('check'))], ['round0', ['Cup0']]);
  }
});

test('from the build the photo items show one by one at their own records, also when dragged back', () => {
  const ids = ['Cup0', 'Cup1', 'Cup2'];
  const tl = buildTimeline({stages, presentation: 'by_stage', latest_event: 'placed',
    models: {seed: 's', final: 'f', small_objects: 'so'}, hidden_nodes: {},
    events: [{id: 'seed', stage: 'plan', minute: 0, model: 'seed'}, {id: 'author', stage: 'assemble', minute: 10},
      ...ids.map((id, i) => ({id, stage: 'assemble', recorded_stage: 'small_objects', minute: 100 + i, display_minute: 20,
        work: 'small', object_id: id})),
      {id: 'again', stage: 'assemble', recorded_stage: 'small_objects', minute: 104, display_minute: 20, work: 'small', object_id: 'Cup0'},
      {id: 'placed', stage: 'assemble', recorded_stage: 'small_objects', minute: 109, display_minute: 20, overlay_model: 'small_objects'}]});
  const at = id => tl.events.find(e => e.id === id).at;
  assert.deepEqual(shown(sceneAt(tl, at('author'))), []);
  for (const [k, id] of ids.entries()) {
    assert.deepEqual(shown(sceneAt(tl, at(id))), ids.slice(0, k + 1));
    assert.deepEqual(shown(sceneAt(tl, at(id) - 0.01)), ids.slice(0, k));
    if (k) assert.ok(at(id) - at(ids[k - 1]) >= 4.5);  // time for the camera to move in on each
  }
  // An item made again appears at its first record and takes no extra time.
  assert.ok(at('placed') - at('again') < 1);
  assert.deepEqual(shown(sceneAt(tl, at('author'))), []);
});
