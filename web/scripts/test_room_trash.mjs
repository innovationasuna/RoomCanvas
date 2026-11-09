import test from 'node:test';
import assert from 'node:assert/strict';
import {mountRoomTrash} from '../room-trash.mjs';

test('recycle bin opens, reports failure, restores rooms and returns focus', async () => {
  class Element {
    constructor(tag = '') {this.tagName = tag; this.children = []; this.listeners = {}; this.open = false; this.hidden = false;}
    append(...items) {this.children.push(...items);}
    replaceChildren(...items) {this.children = items;}
    setAttribute(name, value) {this[name] = value;}
    addEventListener(name, fn) {this.listeners[name] = fn;}
    querySelectorAll(selector) {return this.children.flatMap(item => [...(item.tagName === selector ? [item] : []), ...item.querySelectorAll(selector)]);}
    querySelector(selector) {return this.querySelectorAll(selector)[0];}
    showModal() {this.open = true;}
    close() {this.open = false; this.listeners.close?.();}
    focus() {focused = this;}
  }
  let focused;
  const ids = new Map(), get = id => {
    if (!ids.has(id)) ids.set(id, new Element());
    return ids.get(id);
  };
  const saved = Object.fromEntries(['document', 'fetch', 'location'].map(key => [key, globalThis[key]]));
  globalThis.document = {getElementById: get, createElement: tag => new Element(tag)};
  globalThis.location = {href: 'http://localhost/web/'};
  let rooms = [{id: 'office', name: '办公室', dir: '../samples/office', summary: '办公桌与会客桌椅。'}];
  let failRead = false, failRestore = false, changed = 0, restorations = 0;
  globalThis.fetch = async (path, options = {}) => {
    if (options.method === 'POST') {
      assert.equal(path, '/web/rooms/office/restore');
      if (failRestore) return {ok: false, json: async () => ({error: '恢复未保存'})};
      restorations++; rooms = [];
      return {ok: true, json: async () => ({restored: 'office'})};
    }
    assert.equal(path, '/web/rooms/trash');
    return {ok: !failRead, json: async () => failRead ? {error: '服务未连接'} : {rooms}};
  };
  const settle = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
  try {
    const trash = mountRoomTrash({onRoomsChanged: async () => {changed++;}});
    trash.setCount(1);
    assert.equal(get('trash-count').textContent, '1');
    get('open-trash').onclick(); await settle();
    assert.equal(get('trash-dialog').open, true);
    assert.equal(get('open-trash')['aria-expanded'], 'true');
    assert.equal(get('trash-list').children[0].children[1].children[0].textContent, '办公室');
    assert.equal(get('trash-list').children[0].children[0].children[0].src, 'http://localhost/samples/office/thumbnail.jpg');
    const restore = () => get('trash-list').querySelector('button');
    failRestore = true;
    await restore().onclick();
    assert.equal(get('trash-error').textContent, '恢复未保存');
    assert.equal(restore().disabled, false);
    assert.equal(changed, 0);
    assert.equal(restorations, 0);
    failRestore = false;
    await restore().onclick();
    assert.equal(changed, 1);
    assert.equal(restorations, 1);
    assert.equal(get('trash-list').children.length, 0);
    assert.equal(get('trash-count').hidden, true);
    assert.match(get('trash-status').textContent, /已恢复“办公室”/);
    assert.equal(focused, get('close-trash'));
    get('close-trash').onclick();
    assert.equal(get('open-trash')['aria-expanded'], 'false');
    assert.equal(focused, get('open-trash'));
    get('open-trash').onclick(); await settle();
    assert.match(get('trash-status').textContent, /回收站是空的/);
    failRead = true;
    await get('refresh-trash').onclick();
    assert.equal(get('trash-error').hidden, false);
    assert.equal(get('trash-list')['aria-busy'], 'false');
    failRead = false;
    await get('refresh-trash').onclick();
    assert.equal(get('trash-error').hidden, true);
  } finally {Object.assign(globalThis, saved);}
});
