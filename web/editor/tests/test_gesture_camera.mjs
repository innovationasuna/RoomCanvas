import test from 'node:test';
import assert from 'node:assert/strict';
import {createGestureCamera, inputFrame, leftHandText} from '../gesture-camera.mjs';

// The bundled runtime's surface (gesture/src/embed/index.ts), recorded.
function fakeLib({starts = true} = {}) {
  const lib = {runtime: null,
    gesturePayload: (frame) => ({kind: 'pointer', operator: frame.operator}),
    observationPayload: (frame) => ({kind: 'observe', operator: frame.operator}),
    GestureRuntime: class {
      constructor(video, callbacks) {this.callbacks = callbacks; this.calls = []; lib.runtime = this;}
      async start() {this.calls.push('start'); if (!starts) this.callbacks.error('没有摄像头'); return starts;}
      interrupt(cancel, keepNumbers) {this.calls.push(['interrupt', cancel, keepNumbers]); this.callbacks.interrupted(cancel);}
      stop() {this.calls.push('stop'); this.callbacks.interrupted(true);}
    }};
  return lib;
}
function rig({canSwitch = true, starts = true} = {}) {
  const lib = fakeLib({starts}), calls = [], shown = {};
  let mode = 'view';
  const input = {input: (frame) => calls.push(['input', frame.kind]), reset: () => calls.push(['reset']), interrupt: () => calls.push(['interrupt'])};
  const port = {mode: () => mode, setMode: (next) => {mode = next; calls.push(['mode', next]);}, canSwitch: () => canSwitch, busy: () => false};
  const ui = {right: (text) => {shown.right = text;}, left: (text, progress) => {shown.left = text; shown.progress = progress;}, status: (text) => {shown.status = text;}};
  const camera = createGestureCamera({lib, video: {}, input, port, ui, clock: {now: () => 0}});
  return {lib, calls, shown, camera, get mode() {return mode;}};
}
const left = (phase, digit = null, progress = 0) => ({detected: phase !== 'missing', digit, progress, phase});
const frame = (extra = {}) => ({interrupted: false, ambiguous: false, observation: {interrupted: false}, modeSelection: null, leftDetection: left('missing'), rightHeld: false, ...extra});

test('observation mode sends the observation pinch, the other modes the pointer pinch', () => {
  const lib = fakeLib();
  assert.equal(inputFrame(lib, frame(), 'view').kind, 'observe');
  assert.equal(inputFrame(lib, frame(), 'move').kind, 'pointer');
  assert.equal(inputFrame(lib, frame(), 'rotate').kind, 'pointer');
});

test('the left hand text follows the number recogniser', () => {
  assert.equal(leftHandText(left('confirming', 2, .5)), '左手 2 → 旋转 50%');
  assert.equal(leftHandText(left('selected', 1, 1)), '左手 1 → 移动');
  assert.equal(leftHandText(left('blocked'), {rightHeld: true}), '先松开右手再选模式');
  assert.equal(leftHandText(left('blocked'), {busy: true}), '操作结束后张掌再选模式');
});

test('frames reach the input; a left-hand number switches mode from an open hand', async () => {
  const r = rig();
  assert.equal(await r.camera.start(), true);
  assert.equal(r.camera.on, true);
  r.lib.runtime.callbacks.frame(frame({operator: {pinching: true}}));
  assert.deepEqual(r.calls, [['input', 'observe']], 'in view mode the observation pinch');
  assert.equal(r.shown.right, '右手捏合');
  r.calls.length = 0;
  r.lib.runtime.callbacks.frame(frame({modeSelection: 1, leftDetection: left('selected', 1, 1)}));
  assert.deepEqual(r.lib.runtime.calls.at(-1), ['interrupt', false, true], 'the number recogniser keeps its state');
  assert.deepEqual(r.calls, [['interrupt'], ['reset'], ['mode', 'move'], ['input', 'pointer']]);
  assert.equal(r.shown.left, '左手 1 → 移动');
});

test('no mode switch while the editor is busy with an operation', async () => {
  const r = rig({canSwitch: false});
  await r.camera.start();
  r.calls.length = 0;
  r.lib.runtime.callbacks.frame(frame({modeSelection: 3}));
  assert.equal(r.camera.requestMode('rotate'), false);
  assert.deepEqual(r.calls, [['input', 'observe']]);
});

test('a camera that cannot start reports why and stays off', async () => {
  const r = rig({starts: false});
  assert.equal(await r.camera.start(), false);
  assert.equal(r.camera.on, false);
  assert.equal(r.shown.status, '没有摄像头');
});

test('turning the camera off ends the hand operation but not the preview', async () => {
  const r = rig();
  await r.camera.start();
  r.calls.length = 0;
  r.camera.stop();
  assert.equal(r.camera.on, false);
  assert.deepEqual(r.calls, [['reset']], 'reset, not the editor\'s cancel');
});
