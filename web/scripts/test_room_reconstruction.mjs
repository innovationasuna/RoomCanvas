import test from 'node:test';
import assert from 'node:assert/strict';
import {scanError, jobDescription, mountRoomReconstruction} from '../room-reconstruction.mjs';
test('scan input accepts ZIP and TAR variants and rejects photos, empty and oversized archives', () => {
  for (const name of ['客厅.zip', '客厅.tar', '客厅.tar.gz', '客厅.tgz', '客厅.TAR', '客厅.TAR.GZ']) {
    assert.equal(scanError({name, size: 100}, '客厅'), '');
    assert.ok(scanError({name, size: 0}, '客厅'));
    assert.ok(scanError({name, size: 2 * 1024 ** 3 + 1}, '客厅'));
  }
  for (const file of [null, {name: 'x.jpg', size: 1}, {name: 'x.tar.exe', size: 1}, {name: 'x.gz', size: 1}]) assert.ok(scanError(file, '客厅'));
  assert.ok(scanError({name: 'x.zip', size: 100}, '  '));
});

test('file picker and drag/drop upload the original archive without labelling TAR as ZIP', async () => {
  class Element {
    constructor() {this.value = ''; this.classList = {add() {}, remove() {}};}
    addEventListener() {}
    replaceChildren() {}
    scrollIntoView() {}
    showModal() {}
    close() {}
    reset() {}
    focus() {this.focused = true;}
  }
  const ids = new Map(), get = id => {if (!ids.has(id)) ids.set(id, new Element()); return ids.get(id);};
  const saved = Object.fromEntries(['document', 'window', 'location', 'fetch', 'setInterval', 'XMLHttpRequest'].map(key => [key, globalThis[key]]));
  const uploads = [];
  globalThis.document = {getElementById: get, addEventListener() {}};
  globalThis.window = {addEventListener() {}};
  globalThis.location = {hash: ''};
  globalThis.setInterval = () => 1;
  globalThis.fetch = async () => ({ok: true, json: async () => ({jobs: [], preview: false})});
  globalThis.XMLHttpRequest = class {
    constructor() {this.headers = {}; this.upload = {};}
    open(method, url) {this.method = method; this.url = url;}
    setRequestHeader(key, value) {this.headers[key] = value;}
    send(file) {uploads.push({file, headers: this.headers, method: this.method, url: this.url}); this.status = 202; this.responseText = '{}'; this.onload();}
  };
  try {
    mountRoomReconstruction({onRoomsChanged: async () => {}});
    await get('check-reconstruction').onclick();
    for (const extension of ['zip', 'tar', 'tar.gz', 'tgz']) for (const method of ['picker', 'drop']) {
      get('reconstruction-name').value = '客厅';
      const file = {name: `客厅.${extension}`, size: 123, type: ''};
      if (method === 'picker') get('reconstruction-file').onchange({target: {files: [file]}});
      else get('scan-drop').ondrop({preventDefault() {}, dataTransfer: {files: [file]}});
      assert.equal(get('remove-scan').hidden, false);
      get('reconstruction-error').textContent = '扫描包校验失败';
      get('reconstruction-error').hidden = false;
      get('reconstruction-file').value = 'old-file.tar';
      const beforeRemoval = uploads.length;
      get('remove-scan').onclick();
      assert.equal(uploads.length, beforeRemoval);
      assert.equal(get('reconstruction-file').value, '');
      assert.equal(get('reconstruction-file').focused, true);
      assert.equal(get('remove-scan').hidden, true);
      assert.equal(get('reconstruction-error').hidden, true);
      assert.equal(get('submit-reconstruction').disabled, true);
      if (method === 'picker') get('reconstruction-file').onchange({target: {files: [file]}});
      else get('scan-drop').ondrop({preventDefault() {}, dataTransfer: {files: [file]}});
      assert.equal(get('submit-reconstruction').disabled, false);
      assert.match(get('scan-selected').textContent, new RegExp(extension));
      await get('reconstruction-form').onsubmit({preventDefault() {}});
      const sent = uploads.at(-1);
      assert.equal(sent.file, file);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.url, '/room-reconstruction/jobs');
      assert.equal(sent.headers['Content-Type'], extension === 'zip' ? 'application/zip' : 'application/octet-stream');
      assert.equal(sent.headers['X-Room-Name'], encodeURIComponent('客厅'));
      assert.match(sent.headers['X-Upload-ID'], /^[0-9a-f]{32}$/);
      assert.match(get('scan-selected').textContent, /ZIP \/ TAR/);
      assert.equal(get('remove-scan').hidden, true);
    }
    assert.equal(uploads.length, 8);
  } finally {Object.assign(globalThis, saved);}
});
test('progress reflects real stages and keeps errors distinct from completion', () => {
  assert.match(jobDescription({status: 'queued'}), /等待/);
  assert.match(jobDescription({status: 'running', stages: [{name: 'ingest', status: 'reused'}]}), /重建场景物体/);
  assert.match(jobDescription({status: 'preparing'}), /整理/);
  assert.equal(jobDescription({status: 'failed', error: '模型不可用'}), '模型不可用');
  assert.match(jobDescription({status: 'completed'}), /已加入房间列表/);
});
