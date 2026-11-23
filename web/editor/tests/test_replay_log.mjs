import test from 'node:test';
import assert from 'node:assert/strict';
import {cards, upTo, objects, lines, pictures, isStrip, CardImages, cardScroll, GROUP_MAX} from '../../replay/log.mjs';

const made = (id, name, minute, img) => ({stage: 'plan', minute, kind: 'tool', say: `做好${name}的模型`, object_id: id, object_name: name, work: 'model', img});
const agent = (minute, say, extra = {}) => ({stage: 'assemble', minute, kind: 'tool', say, session: 'a0', ...extra});

test('a run of the same work on objects is one card, ended by other work, a restart or a stage', () => {
  const events = [
    made('Sofa0', '沙发', 1, 'sofa.png'), made('Bed0', '床', 2, 'bed.png'),
    {stage: 'plan', minute: 3, kind: 'milestone', say: '重新开始重建，接着上次做好的部分继续'},
    made('Table0', '桌子', 4), {...made('Chair0', '椅子', 5), work: 'shape', say: '做好椅子，检查形状'},
    {...made('Lamp0', '台灯', 6), stage: 'assemble'},
  ];
  assert.deepEqual(cards(events).map((c) => [c.type, c.members]), [['objects', [0, 1]], ['same', [2]], ['objects', [3]], ['objects', [4]], ['objects', [5]]]);
});

test('dragged into a card, it holds only what had happened by then, each object counted once', () => {
  const events = [made('Sofa0', '沙发1', 1, 'a.png'), made('Sofa1', '沙发2', 2), made('Sofa0', '沙发1', 3, 'b.png'), made('Bed0', '床', 4, 'c.png')];
  const [card] = cards(events);
  assert.deepEqual(upTo(card, 1), [0, 1]);
  assert.deepEqual(objects(events, upTo(card, 1)).map((o) => [o.name, o.img]), [['沙发1', 'a.png'], ['沙发2', null]]);
  // made again: still one sofa, with its latest picture and event
  assert.deepEqual(objects(events, upTo(card, 3)).map((o) => [o.name, o.k, o.img]), [['沙发1', 2, 'b.png'], ['沙发2', 1, null], ['床', 3, 'c.png']]);
  assert.deepEqual(upTo(card, -1), []);
});

test("the agent's work folds by session, at most a few lines, and a pause ends a stretch", () => {
  const run = Array.from({length: GROUP_MAX + 2}, (_, k) => agent(k, `step ${k}`));
  assert.deepEqual(cards(run).map((c) => c.members.length), [GROUP_MAX, 2]);
  const paused = [agent(0, 'a'), agent(1, 'b'), agent(10, 'c'), agent(11, 'd', {session: 'a1'}), agent(11.5, 'e', {session: 'a1'})];
  assert.deepEqual(cards(paused).map((c) => c.members), [[0, 1], [2], [3, 4]]);
  // the check's verdict between two stretches stands on its own
  const verdict = [agent(0, 'a'), {stage: 'assemble', minute: 0.5, kind: 'review', say: '检查房间没通过'}, agent(1, 'b')];
  assert.deepEqual(cards(verdict).map((c) => [c.type, c.members]), [['work', [0]], ['same', [1]], ['work', [2]]]);
});

test('the same sentence said again in a row shows once with how many times', () => {
  const events = [agent(0, '继续自查'), agent(1, '继续自查'), agent(2, '继续自查'), agent(3, '调整灯光'), agent(4, '继续自查')];
  const [card] = cards(events);
  assert.deepEqual(lines(events, card.members), [{k: 2, n: 3}, {k: 3, n: 1}, {k: 4, n: 1}]);
  assert.deepEqual(lines(events, upTo(card, 1)), [{k: 1, n: 2}]);
  const pipeline = [{stage: 'plan', minute: 1, kind: 'result', say: '物理检查：16/16'}, {stage: 'plan', minute: 2, kind: 'result', say: '物理检查：16/16'}];
  assert.deepEqual(cards(pipeline).map((c) => c.members), [[0, 1]]);
  // lines with their own pictures are not merged away
  assert.equal(cards(pipeline.map((e) => ({...e, img: 'x.png'}))).length, 2);
});

test('a stretch of work shows only pictures its own lines name, latest first, one per line before the rest', () => {
  const events = [agent(0, 'a', {img: 'p1.jpg', media: [{src: 'p1.jpg'}, {src: 'p2.jpg'}]}), agent(1, 'b'), agent(2, 'c', {img: 'p3.jpg', media: [{src: 'p3.jpg'}, {src: 'p4.jpg'}]})];
  const [card] = cards(events);
  assert.deepEqual(pictures(events, card.members).map((p) => p.src), ['p3.jpg', 'p1.jpg']);
  assert.deepEqual(pictures(events, upTo(card, 1)).map((p) => p.src), ['p1.jpg', 'p2.jpg']);
  assert.deepEqual(pictures(events, [1]), []);
});

test("an object's picture keeps the part that shows it, and only for that picture", () => {
  const shelf = {...made('ShelfC0R0B', '架上物品1', 1, 'view0.jpg'), work: 'small',
                 media: [{src: 'view0.jpg', role: 'photo', crop: [0.4, 0.4, 0.5, 0.5]}, {src: 'pair_after.jpg', role: 'comparison'}]};
  assert.deepEqual(objects([shelf], [0]).map((o) => o.crop), [[0.4, 0.4, 0.5, 0.5]]);
  assert.deepEqual(objects([{...shelf, media: [{src: 'other.jpg', crop: [0, 0, 1, 1]}]}], [0]).map((o) => o.crop), [null]);
});

test('same-name objects have distinct thumbnail labels and keep the names used for folded counts', () => {
  const events = [made('Wall4_Door_0', '门', 1, 'a.png'), made('Wall7_Door_1', '门', 2, 'b.png'),
    made('Table0', '桌子', 3), made('Wall4_Door_0', '门', 4, 'c.png')];
  assert.deepEqual(objects(events, [0, 1, 2, 3]).map((o) => [o.name, o.label, o.img]),
    [['门', '门 1', 'c.png'], ['门', '门 2', 'b.png'], ['桌子', '桌子', null]]);
});

test('known strip pictures give their places to other evidence', () => {
  assert.deepEqual([0, 39, 40, 400, 401].map((w) => isStrip(w, 100)), [false, true, false, false, true]);
  assert.equal(isStrip(100, 0), false);
  const events = [agent(1, 'a', {img: 'a.jpg'}), agent(2, 'b', {img: 'strip.jpg', media: [{src: 'b.jpg'}]})];
  assert.deepEqual(pictures(events, [0, 1], 2, (src) => src !== 'strip.jpg').map((p) => p.src), ['a.jpg', 'b.jpg']);
});

test('detached thumbnails survive a seek or rebuild and are reused once per card and source', () => {
  const cache = new CardImages();
  const img = (file) => ({dataset: {file}, remove() {this.detached = true;}});
  const a = img('same'), b = img('same'), c = img('same'), d = img('other');
  const card = (key, imgs) => ({dataset: {key}, querySelectorAll: () => imgs});
  cache.collect(card('doors', [a, b, d]));
  cache.collect(card('checks', [c]));
  cache.collect(card('obsolete', [img('same')]));
  cache.collect(card('doors', [img('replaced')]));
  cache.prune([{key: 'doors', members: [0]}, {key: 'checks', members: [1]}],
    [{img: 'same', media: [{src: 'other'}]}, {img: 'same'}]);
  assert.equal(cache.take('obsolete', 'same'), undefined);
  assert.equal(cache.take('doors', 'replaced'), undefined);
  assert.ok([a, b, c, d].every((i) => i.detached));
  assert.equal(cache.take('checks', 'same'), c);
  assert.equal(cache.take('doors', 'same'), a);
  cache.collect(card('doors', [a]));  // redraw with the second occurrence still folded
  assert.equal(cache.take('doors', 'other'), d);
  assert.equal(cache.take('doors', 'same'), a);
  assert.equal(cache.take('doors', 'same'), b);
  assert.equal(cache.take('doors', 'same'), undefined);
});

test('seek fits the whole card with margins, then its heading and current row for taller cards', () => {
  const row = {top: 140, bottom: 160};
  assert.equal(cardScroll(0, 180, row, 200), -12); // tall enough to need the heading aligned
  assert.equal(cardScroll(20, 180, row, 200), 0);
  assert.equal(cardScroll(80, 220, row, 200), 32);
  assert.equal(cardScroll(50, 450, row, 200), 38);
  assert.equal(cardScroll(-300, 270, {top: 180, bottom: 230}, 200), 42);
  assert.equal(cardScroll(-300, 270, {top: -50, bottom: 230}, 200), -62);
});
