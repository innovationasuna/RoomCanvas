import test from 'node:test';
import {PlacementSession} from '../placement-session.mjs';
import {initialLayout} from '../layout.mjs';
import assert from 'node:assert/strict';
import { connectGestureBridge, parseMessage, PROTOCOL, CONFIRM_MAX_AGE_MS } from '../gesture-bridge.mjs';

function bridge() {
  const listeners = {}, calls = [];
  const parent = { postMessage() {} };
  const win = { parent, location: { search: '?gesture_origin=http://127.0.0.1:8800&gesture_session=s' },
    addEventListener(type, fn) { listeners[type] = fn; }, setInterval() { return 1; }, clearInterval() {} };
  const doc = { hidden: false, addEventListener() {} };
  const state = { busy: false, mode: 'height', selectedId: 'chair', layoutReady: true, phase: 'idle', message: '',
    previewId: 'p1', canConfirm: true, capabilities: ['thumb-confirm-v1'] };
  const input = { active: false, dual: false, leftActive: false,
    reset() { calls.push('reset'); }, interrupt() { calls.push('interrupt'); }, input() { calls.push('frame'); } };
  const port = { input, state: () => state, confirm() { calls.push('confirm'); }, setMode() {}, stop() {} };
  const clock = { timeOrigin: 100000, now: () => 1000 };
  connectGestureBridge(port, { win, doc, clock });
  let sequence = 0;
  const send = (patch = {}, event = {}) => {
    const data = { protocol: PROTOCOL, session: 's', sequence: ++sequence, type: 'confirm',
      sampleTime: 101000, previewId: 'p1', ...patch };
    listeners.message({ data, source: parent, origin: 'http://127.0.0.1:8800', ...event });
    return data;
  };
  return { send, state, input, port, doc, calls };
}

test('确认消息校验预览标识与采样时间，不能使用缺失或无效值', () => {
  const valid = { protocol: PROTOCOL, session: 's', sequence: 1, type: 'confirm', previewId: 'p1', sampleTime: 1000 };
  assert.equal(parseMessage(valid), valid);
  for (const previewId of [undefined, null, '', 12, 'x'.repeat(129)]) assert.equal(parseMessage({ ...valid, previewId }), null);
  for (const sampleTime of [undefined, '1000', NaN, Infinity]) assert.equal(parseMessage({ ...valid, sampleTime }), null);
});

test('只确认已连接父窗口的当前预览，拒绝旧序号、旧会话、旧预览及其他来源', () => {
  const b = bridge();
  b.send(); assert.deepEqual(b.calls, []);
  b.send({ type: 'hello' });
  const confirmed = b.send();
  assert.deepEqual(b.calls, ['reset', 'confirm']);
  b.send(confirmed);
  b.send({ session: 'old' });
  b.send({}, { origin: 'http://elsewhere.test' });
  b.send({}, { source: {} });
  b.state.previewId = 'p2'; b.send();
  assert.deepEqual(b.calls, ['reset', 'confirm']);
  b.send({ previewId: 'p2' });
  assert.equal(b.calls.filter(c => c === 'confirm').length, 2);
});

test('隐藏、过期、未就绪、拖动、缩放和校验中都拒绝确认，不排队补发', () => {
  const cases = [
    b => { b.doc.hidden = true; },
    b => { b.state.layoutReady = false; },
    b => { b.state.busy = true; },
    b => { b.state.canConfirm = false; },
    b => { b.state.previewId = null; },
    b => { b.input.active = true; },
    b => { b.input.dual = true; },
  ];
  for (const block of cases) {
    const b = bridge(); b.send({ type: 'hello' }); block(b); b.send();
    assert.deepEqual(b.calls, ['reset']);
  }
  const b = bridge(); b.send({ type: 'hello' });
  b.send({ sampleTime: 101000 - CONFIRM_MAX_AGE_MS - 1 });
  b.send({ sampleTime: 101051 });
  assert.deepEqual(b.calls, ['reset']);
  b.send({ sampleTime: 101000 - CONFIRM_MAX_AGE_MS });
  assert.deepEqual(b.calls, ['reset', 'confirm']);
});

test('右手确认共用房间放置入口，不重置仍在环绕的左手', () => {
  const b = bridge(); b.send({ type: 'hello' }); b.input.leftActive = true; b.state.phase = 'observing';
  b.send();
  assert.equal(b.input.leftActive, true);
  assert.deepEqual(b.calls, ['reset', 'confirm']);
});

test('放置入口拒绝碰撞后仍保留预览，确认通过后的过期请求不能再放置', () => {
  const b = bridge(); b.send({ type: 'hello' });
  let collision = true, committed = 0;
  b.port.confirm = () => {
    if (collision) { b.state.message = '落下路径被其他家具阻挡'; return; }
    committed++; b.state.previewId = null; b.state.canConfirm = false;
  };
  b.send(); assert.equal(committed, 0); assert.equal(b.state.previewId, 'p1');
  assert.match(b.state.message, /阻挡/);
  collision = false; b.send(); assert.equal(committed, 1);
  b.send(); assert.equal(committed, 1);
});

for (const warehouse of [false, true]) {
  test(`拇指向下通过桥接取消预览并恢复${warehouse ? '物品库状态' : '原位置和高度'}`, () => {
    const b = bridge(); b.send({type: 'hello'});
    const before = initialLayout(['chair']); before.chair.visible = !warehouse;
    const session = new PlacementSession(before, 'chair');
    let layout = structuredClone(before);
    layout.chair = {...layout.chair, x: 9, y: 2, yaw: 1, visible: true};
    session.update(layout, false, '预览');
    b.port.cancel = () => {layout = session.cancel(); b.calls.push('cancel'); b.state.previewId = null;};
    b.send({type: 'cancel', previewId: 'old'});
    b.send({type: 'cancel', sampleTime: 0});
    b.input.active = true; b.send({type: 'cancel'}); b.input.active = false;
    assert.equal(layout.chair.x, 9);
    b.send({type: 'cancel'});
    assert.deepEqual(layout, before);
    b.send({type: 'cancel'});
    assert.deepEqual(b.calls, ['reset', 'cancel']);
  });
}
