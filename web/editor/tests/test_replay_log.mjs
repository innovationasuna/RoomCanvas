import test from 'node:test';
import assert from 'node:assert/strict';
import {cards, upTo, objects, objectNames, pictureUrls, lines, pictures, isStrip, CardImages, keepReading, appendedEvents, cardScroll, GROUP_MAX} from '../../replay/log.mjs';

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

test('object numbers survive reversed stage order, a seek and a live rebuild', () => {
  const a = made('A', '门', 1), b = made('B', '门', 2);
  const events = [{...a, work: 'image'}, {...b, work: 'image'}, b, a];
  const [images, models] = cards(events), names = objectNames(events);
  const labels = (members) => objects(events, members, names).map((o) => [o.id, o.label]);
  assert.deepEqual(labels(images.members), [['A', '门 1'], ['B', '门 2']]);
  assert.deepEqual(labels(models.members), [['B', '门 2'], ['A', '门 1']]);
  assert.deepEqual(labels(upTo(models, 2)), [['B', '门 2']]);
  assert.deepEqual(labels(upTo(images, 0)), [['A', '门 1']]);
  objectNames([b, a], names);
  assert.deepEqual(objects([b, a], [0], names).map((o) => o.label), ['门 2']);
});

test('known strip pictures give their places to other evidence', () => {
  assert.deepEqual([0, 39, 40, 400, 401].map((w) => isStrip(w, 100)), [false, true, false, false, true]);
  assert.equal(isStrip(100, 0), false);
  const events = [agent(1, 'a', {img: 'a.jpg'}), agent(2, 'b', {img: 'strip.jpg', media: [{src: 'b.jpg'}]})];
  assert.deepEqual(pictures(events, [0, 1], 2, (src) => src !== 'strip.jpg').map((p) => p.src), ['a.jpg', 'b.jpg']);
});

const img = (file, grid = false) => ({
  dataset: {file}, style: {}, closest: () => grid, remove() {this.detached = true;},
  addEventListener() {}, replaceWith(node) {this.reused = node;},
});
const card = (key, imgs) => ({dataset: {key}, querySelectorAll: () => imgs});

test('a new revision of the same reference gets its own URL, node and strip decision', () => {
  const cache = new CardImages(), path = 'small-objects/reference/key.png', files = (rel) => '/files/' + rel;
  const reference = (version) => pictureUrls({img: path, media: [{src: path, version}]}, files);
  const first = reference('1'), second = reference('2');
  assert.equal(first.img, '/files/' + path + '?v=1');
  assert.equal(second.img, second.media[0].src);
  assert.notEqual(first.img, second.img);
  assert.equal(reference(undefined).img, files(path));
  cache.strips.add(first.img);
  cache.collect(card('key', [img(first.img, true)]));
  cache.prune([{key: 'key', type: 'objects', members: [0, 1]}], [second, {}]);
  assert.equal(cache.take('key', first.img), undefined);
  assert.ok(!cache.strips.has(second.img));
  const fresh = img(second.img);
  cache.attach('key', fresh, () => {});
  assert.equal(fresh.src, second.img);
});

test('new evidence replaces the object thumbnail and its zoomed comparison', () => {
  const cache = new CardImages(), photo = 'evidence/key/view0.jpg', pair = 'evidence/key/pair_after.jpg';
  const evidence = (version) => pictureUrls({...made('key', '杯子', 1, photo), id: 'step',
    media: [{src: photo, role: 'photo', version}, {src: pair, role: 'comparison', version}]}, (src) => src);
  const first = evidence('a'), second = evidence('b');
  cache.collect(card('step', [img(first.img)]));
  cache.prune(cards([second]), [second]);
  const thumbnail = objects([second], [0])[0].img;
  assert.equal(thumbnail, photo + '?v=b');
  assert.equal(cache.take('step', thumbnail), undefined);
  assert.equal(cache.byCard.size, 0);
  assert.equal(second.media.find((m) => m.role === 'comparison').src, pair + '?v=b');
});

test('a normal picture in a new session can replace a strip at the same path', () => {
  const cache = new CardImages(), src = 'traces/img/step.jpg';
  const event = (id, version) => pictureUrls({...agent(2, '查看画面'), id, session: id, img: src,
    media: [{src, version}]}, (rel) => rel);
  const first = event('a0', 'old'), second = event('a1', 'new');
  const shots = (e) => pictures([e], [0], 2, (url) => !cache.strips.has(url));
  const decoded = (e, width, height) => {if (isStrip(width, height)) cache.strips.add(e.img);};
  decoded(first, 20, 200);
  assert.deepEqual(shots(first), []);
  cache.prune(cards([second]), [second]);
  assert.deepEqual(shots(second), [{src: src + '?v=new', k: 0}]);
  decoded(second, 200, 150);
  assert.deepEqual(shots(second), [{src: src + '?v=new', k: 0}]);
  assert.equal(pictureUrls({img: src, img_version: 'new'}, (rel) => rel).img, second.img);
});

test('redrawing keeps a pending image and retries one that failed while detached', () => {
  const cache = new CardImages(), first = img('a.jpg');
  cache.attach('work', first, () => {});
  assert.equal(first.src, 'a.jpg');
  first.complete = false;
  cache.collect(card('work', [first]));
  const pending = img('a.jpg');
  cache.attach('work', pending, () => {});
  assert.equal(pending.reused, first);
  cache.collect(card('work', [first]));
  Object.assign(first, {complete: true, naturalWidth: 0});
  const retry = img('a.jpg');
  cache.attach('work', retry, () => {});
  assert.equal(retry.src, 'a.jpg');
  Object.assign(retry, {complete: true, naturalWidth: 64});
  cache.collect(card('work', [retry]));
  const again = img('a.jpg');
  cache.attach('work', again, () => {});
  assert.equal(again.reused, retry);
});

test('filtering evicts cached strips on redraw and live rebuild, preserving grid thumbnails', () => {
  const cache = new CardImages(), events = [{img: 'strip'}, {}];
  const deck = ['work', 'same', 'objects'].map((type) => ({key: type, type, members: [0, 1]}));
  const grid = img('strip', true);
  cache.collect(card('work', [img('strip')]));
  cache.collect(card('objects', [grid]));
  cache.strips.add('strip');
  cache.prune(deck, events);
  cache.collect(card('work', [img('strip')]));
  cache.collect(card('same', [img('strip')]));
  assert.deepEqual([...cache.byCard.keys()], ['objects']);
  cache.prune(deck, events);
  assert.equal(cache.take('objects', 'strip'), grid);
  assert.equal(cache.byCard.size, 0);
});

test('detached thumbnails survive a seek or rebuild and are reused once per card and source', () => {
  const cache = new CardImages();
  const a = img('same'), b = img('same'), c = img('same'), d = img('other');
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

test('rebuilding anchors a normal row or its card even when the heading starts below the viewport edge', (t) => {
  globalThis.CSS = {escape: String};
  globalThis.getComputedStyle = (el) => el.style;
  t.after(() => {delete globalThis.CSS; delete globalThis.getComputedStyle;});
  const log = {scrollTop: 300, scrollHeight: 1000, clientHeight: 200, getBoundingClientRect: () => ({top: 0, bottom: 200})};
  const rect = (y) => ({top: y - log.scrollTop, bottom: y - log.scrollTop + 40});
  const row = (i, position, bounds) => ({dataset: {i}, style: {position}, tagName: 'P',
    classList: {contains: () => false}, getBoundingClientRect: bounds});
  const heading = row(0, 'sticky', () => rect(Math.min(600, Math.max(325, log.scrollTop))));
  const body = row(1, 'static', () => rect(bodyY));
  let bodyY = 380, rows = [heading, body];
  const holder = {dataset: {key: 'work'}, getBoundingClientRect: () => ({top: 280 - log.scrollTop, bottom: 640 - log.scrollTop}),
    querySelectorAll: () => rows};
  log.querySelectorAll = () => [holder];
  log.querySelector = (sel) => sel.includes('data-key') ? holder : sel.includes('data-i="1"') ? body : heading;
  const events = [{id: 'first'}, {id: 'second'}];
  const before = body.getBoundingClientRect().top;
  const restore = keepReading(log, events, true);
  bodyY += 20;
  log.scrollTop = 800;
  restore(events);
  assert.equal(body.getBoundingClientRect().top, before);
  rows = [heading];
  log.scrollTop = 300;
  const restoreCard = keepReading(log, events, true);
  log.scrollTop = 800;
  restoreCard(events);
  assert.equal(log.scrollTop, 300);
});

test('rewrapping a row hidden by the sticky heading keeps the visible row in place', (t) => {
  globalThis.CSS = {escape: String};
  globalThis.getComputedStyle = (el) => el.style;
  t.after(() => {delete globalThis.CSS; delete globalThis.getComputedStyle;});
  const log = {scrollTop: 300, scrollHeight: 1000, clientHeight: 200, getBoundingClientRect: () => ({top: 0, bottom: 200})};
  let extra = 0;
  const row = (i, position, rect) => ({dataset: {i}, tagName: 'P', style: {position},
    classList: {contains: () => false}, getBoundingClientRect: rect});
  const heading = row(0, 'sticky', () => ({top: 0, bottom: 42}));
  const hidden = row(1, 'static', () => ({top: 280 - log.scrollTop, bottom: 319 + extra - log.scrollTop}));
  const visible = row(2, 'static', () => ({top: 367 + extra - log.scrollTop, bottom: 407 + extra - log.scrollTop}));
  const holder = {dataset: {key: 'work'}, getBoundingClientRect: () => ({top: -110, bottom: 300}),
    querySelectorAll: () => [heading, hidden, visible]};
  log.querySelectorAll = () => [holder];
  log.querySelector = (sel) => sel.includes('data-key') ? holder : sel.includes('data-i="2"') ? visible : hidden;
  const events = [0, 1, 2].map((id) => ({id}));
  const restore = keepReading(log, events);
  extra = 78;
  restore(events);
  assert.equal(visible.getBoundingClientRect().top, 67);
});

test('following the live tail depends on what came after it when history is rewritten', () => {
  const old = [{id: 'a0', t: 10}, {id: 'a3', t: 20}, {id: 'tail', t: 30}];
  const log = {scrollTop: 761, scrollHeight: 1000, clientHeight: 200,
    getBoundingClientRect: () => ({top: 0, bottom: 200}), querySelectorAll: () => []};
  const split = [old[0], {id: 'a1', t: 15}, ...old.slice(1)];
  keepReading(log, old, appendedEvents(old, split))();
  assert.equal(log.scrollTop, 761);
  const mergedAndAppended = [old[1], old[2], {id: 'new', t: 30}];
  keepReading(log, old, appendedEvents(old, mergedAndAppended))();
  assert.equal(log.scrollTop, log.scrollHeight);
  assert.ok(appendedEvents(old, [{id: 'summary', t: 30}, {id: 'new', t: 31}]));
  assert.equal(appendedEvents(old, [{id: 'summary', t: 30}]), false);
});

test('a reflow keeps the 39px below the reader, while an append or a pinned reader follows the end', () => {
  let scroll = 761;
  const log = {scrollHeight: 1000, clientHeight: 200,
    get scrollTop() {return scroll;}, set scrollTop(y) {scroll = Math.min(y, this.scrollHeight - this.clientHeight);},
    getBoundingClientRect: () => ({top: 0, bottom: 200}), querySelectorAll: () => []};
  keepReading(log, [])();
  assert.equal(log.scrollTop, 761);
  const append = keepReading(log, [], true);
  log.scrollHeight += 30;
  append();
  assert.equal(log.scrollTop, log.scrollHeight - log.clientHeight);
  log.scrollTop = log.scrollHeight - log.clientHeight;
  const reflow = keepReading(log, []);
  log.scrollHeight += 10;
  reflow();
  assert.equal(log.scrollTop, log.scrollHeight - log.clientHeight);
});

test('seeking an oversized row clears the sticky heading and still fits shorter rows', () => {
  const height = 200, heading = 42;
  const scroll = cardScroll(-300, 270, {top: -50, bottom: 230}, height, heading);
  assert.equal(-50 - scroll, heading + 12);
  assert.equal(cardScroll(-300, 270, {top: 180, bottom: 230}, height, heading), 42);
});
