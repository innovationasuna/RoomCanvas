import test from 'node:test';
import assert from 'node:assert/strict';
import {gestureFeedback} from '../gesture-feedback.mjs';

const frame = (extra = {}) => ({leftDetection: {detected: true, phase: 'pose'}, operator: {pinching: false}, rightConfirmation: {phase: 'waiting', progress: 0}, ...extra});

test('no hands produces one next-step prompt, without empty progress meters', () => {
  const value = gestureFeedback();
  assert.equal(value.left.label, '未入镜'); assert.equal(value.right.label, '未入镜');
  assert.equal(value.title, '把双手放入画面');
  assert.equal(value.modeProgress, null); assert.equal(value.confirmProgress, null);
});

test('a candidate gesture shows real hold progress without changing the current mode', () => {
  const value = gestureFeedback({mode: 'move', frame: frame({leftDetection: {detected: true, phase: 'confirming', digit: 4, progress: .62}})});
  assert.equal(value.modeName, '移动'); assert.equal(value.candidate, 'rotate');
  assert.equal(value.modeProgress, .62); assert.equal(value.left.label, '已识别');
  assert.match(value.leftHint, /旋转/);
  const selected = gestureFeedback({mode: 'rotate', frame: frame({leftDetection: {detected: true, phase: 'selected', digit: 4, progress: 1}})});
  assert.equal(selected.modeName, '旋转'); assert.equal(selected.modeProgress, null);
});

test('confirmation progress requires a valid placement and a visible stable right hand', () => {
  const confirming = frame({rightConfirmation: {phase: 'confirming', progress: .75}});
  assert.equal(gestureFeedback({frame: confirming, target: {allowed: true, previewId: 'chair'}}).confirmProgress, .75);
  assert.equal(gestureFeedback({frame: confirming, target: {allowed: false, previewId: 'chair'}}).confirmProgress, null);
  for (const phase of ['missing', 'uncertain', 'ambiguous']) {
    const value = gestureFeedback({frame: frame({operator: null, rightConfirmation: {phase, progress: .75}}), target: {allowed: true}});
    assert.equal(value.confirmProgress, null);
    assert.notEqual(value.right.state, 'seen');
  }
});

test('an in-flight confirmation reports submission, not successful placement', () => {
  const value = gestureFeedback({frame: frame({rightConfirmation: {phase: 'sent', progress: 1}}), target: {allowed: true}});
  assert.equal(value.state, 'submitted'); assert.equal(value.title, '确认请求已发送');
  assert.equal(value.confirmProgress, null); assert.match(value.detail, /场景/);
});

test('active adjustments and two-hand scaling take priority over confirmation hints', () => {
  const payload = {frame: frame(), active: true, mode: 'height', target: {allowed: true}};
  assert.equal(gestureFeedback(payload).title, '正在抬高物品');
  assert.equal(gestureFeedback(payload).confirmProgress, null);
  assert.equal(gestureFeedback({...payload, dual: true}).title, '正在缩放场景');
});

test('interruption clears stale hand states and progress', () => {
  const value = gestureFeedback({lifecycle: 'paused', frame: frame({leftDetection: {detected: true, phase: 'confirming', digit: 2, progress: .8}, rightConfirmation: {phase: 'confirming', progress: .9}}), target: {allowed: true}});
  assert.equal(value.title, '识别已暂停');
  assert.equal(value.left.state, 'missing'); assert.equal(value.right.state, 'missing');
  assert.equal(value.modeProgress, null); assert.equal(value.confirmProgress, null);
});
