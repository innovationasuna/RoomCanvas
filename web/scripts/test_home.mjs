import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('bedroom note counts the rebuilt objects separately from the two piano lids', async () => {
  const manifest = JSON.parse(await readFile(new URL('../rooms.json', import.meta.url), 'utf8'));
  const bedroom = manifest.rooms.find(room => room.id === 'room3');
  const metadata = JSON.parse(await readFile(new URL(`../${bedroom.dir}/room_objects.json`, import.meta.url), 'utf8'));
  const rebuilt = metadata.objects.filter(object => object.rebuilt);
  const piano = metadata.groups.find(group => group.name === '钢琴');
  assert.ok(!rebuilt.some(object => object.id === piano.id));
  assert.equal(metadata.joints.filter(joint => joint.object === piano.id).length, 2);
  const sentences = bedroom.note.split('。');
  assert.ok(sentences.some(line => line.includes(`${rebuilt.length} 件`) && !line.includes('钢琴')));
  assert.ok(sentences.some(line => line.includes('钢琴顶盖和琴键盖可以打开')));
});

// Exercise the home module and reconstruction polling together with an in-memory DOM/API.
test('room cards follow reconstruction state and persist confirmed removal', async () => {
  class Element {
    constructor() {this.children = []; this.classList = {add() {}, remove() {}}; this.value = '';}
    append(...items) {for (const item of items) item.parent = this; this.children.push(...items);}
    querySelectorAll(selector) {return this.children.filter(item => `.${item.className}` === selector);}
    remove() {this.parent.children = this.parent.children.filter(item => item !== this);}
    replaceChildren(...items) {this.children = items;}
    setAttribute(name, value) {this[name] = value;}
    addEventListener() {}
  }
  const ids = new Map();
  const get = id => {if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id);};
  const saved = Object.fromEntries(['document', 'window', 'location', 'fetch', 'setInterval', 'getComputedStyle'].map(key => [key, globalThis[key]]));
  const job = {id: 'a'.repeat(32), name: '新客厅', status: 'running', created: 1};
  const office = {id: 'office', name: '办公室', dir: '../samples/office'};
  let deleted = [], allow = false, failDelete = false, deletes = 0, sample = null;
  globalThis.document = {getElementById: get, createElement: () => new Element(), addEventListener() {}};
  globalThis.window = {addEventListener() {}, confirm: () => allow};
  globalThis.location = {href: 'http://localhost/web/', hash: ''};
  globalThis.setInterval = () => 1;
  globalThis.getComputedStyle = () => ({getPropertyValue: () => '4'});
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    let data;
    if (options.method === 'DELETE') {
      deletes++;
      if (failDelete) return {ok: false, json: async () => ({error: '无法保存'})};
      deleted.push(url.split('/').at(-1)); data = {};
    } else if (url.endsWith('rooms.json')) {
      const rooms = sample ? [office, sample] : [office];
      if (job.status === 'completed') rooms.push({id: `scan-${job.id}`, name: job.name, dir: '/assets/new'});
      data = {rooms: rooms.filter(room => !deleted.includes(room.id)), deleted};
    } else if (url.endsWith('/jobs')) data = {jobs: [job]};
    else data = {groups: [{}, {}]};
    return {ok: true, json: async () => data};
  };
  const settle = async () => {for (let i = 0; i < 30; i++) await Promise.resolve();};
  const cards = () => get('rooms').children.filter(item => item.className === 'room');
  try {
    await import('../home.mjs'); await settle();
    assert.equal(cards().length, 2);
    assert.equal(get('rooms').children.length, 8);
    assert.equal(cards()[1].children[0].href, `replay.html?job=${job.id}`);
    const help = await readFile(new URL('../index.html', import.meta.url), 'utf8');
    const enterLabel = cards()[0].children[0].children[1].children[2].textContent;
    assert.ok(help.includes(`标有“${enterLabel}”的房间卡片`));
    assert.equal(cards()[1].children[0].children[1].children[2].textContent, '实时查看');
    assert.equal(cards()[1].children[0].children[0].children[1].children[0].textContent, '正在重建');
    const remove = cards()[0].children[1].children[1];
    await remove.onclick(); assert.equal(deletes, 0);
    allow = true; failDelete = true;
    await remove.onclick(); assert.equal(cards()[0].children[2].textContent, '无法保存');
    assert.equal(cards().length, 2);
    failDelete = false;
    await remove.onclick(); await settle();
    assert.equal(cards().length, 1);
    assert.deepEqual(deleted, ['office']);
    job.status = 'completed'; job.room = {id: `scan-${job.id}`};
    await get('refresh-jobs').onclick(); await settle();
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].children[0].href, `editor/?room=scan-${job.id}`);
    await cards()[0].children[1].children[1].onclick(); await settle();
    assert.equal(cards().length, 0);
    assert.equal(get('rooms').children.length, 8);
    assert.ok(get('rooms').children.every(item => item.className === 'room-empty'));
    assert.equal(get('reconstruction-jobs').hidden, true);
    // A sample copied from that reconstruction stands in for it: the room is listed once.
    deleted = [];
    sample = {id: 'copy', name: '新客厅', dir: '../samples/copy', scan: job.id};
    await get('retry-rooms').onclick(); await settle();
    assert.deepEqual(cards().map(card => card.children[0].href), ['editor/?room=office', 'editor/?room=copy']);
  } finally {
    Object.assign(globalThis, saved);
  }
});
