import {DIGIT_MODES, MODE_NAMES} from './gesture-camera.mjs';

const names = {...MODE_NAMES, rotate: '旋转', view: '观察'};
const progress = value => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

// Presentation follows real recognition and placement state; percentages are hold progress.
export function gestureFeedback({frame, mode = 'move', active = false, dual = false, busy = false, target = {}, lifecycle = 'tracking'} = {}) {
  const left = frame?.leftDetection || {phase: 'missing'}, right = frame?.rightConfirmation || {};
  const leftSeen = !!left.detected, rightSeen = !!frame?.operator;
  const uncertain = phase => ['uncertain', 'ambiguous'].includes(phase);
  const hand = (seen, phase, held = false) => uncertain(phase)
    ? {state: 'uncertain', label: phase === 'ambiguous' ? '请分开双手' : '识别不稳定'}
    : {state: seen ? 'seen' : 'missing', label: seen ? held ? '捏合中' : '已识别' : '未入镜'};
  const result = {
    mode, modeName: names[mode] || names.move,
    left: hand(leftSeen, left.phase), right: hand(rightSeen, right.phase, frame?.operator?.pinching),
    candidate: null, modeProgress: null, confirmProgress: null,
    leftHint: '左手比 1 / 2 / 3 / 4，保持片刻切换动作。',
    state: 'waiting', title: '把双手放入画面', detail: '让手掌完整入镜，避免遮挡手指。',
  };
  if (lifecycle !== 'tracking') {
    const messages = {
      starting: ['正在开启摄像头', '准备好后，将双手完整放入画面。'],
      paused: ['识别已暂停', '重新伸出双手，松开捏合后继续。'],
      off: ['手势已关闭', '再次点击侧栏手势图标，即可开启。'],
      error: ['摄像头暂不可用', '请查看下方提示后重试。'],
    };
    [result.title, result.detail] = messages[lifecycle] || messages.paused;
    result.left = hand(false); result.right = hand(false);
    return result;
  }
  const candidate = DIGIT_MODES[left.digit];
  if (left.phase === 'confirming' && candidate) {
    result.candidate = candidate; result.modeProgress = progress(left.progress);
    result.leftHint = `保持手势，切换至「${names[candidate]}」。`;
  } else if (left.phase === 'selected' && candidate) result.leftHint = `已选择「${names[candidate]}」，松开左手后可再次切换。`;
  else if (left.phase === 'neutral') result.leftHint = '先张开左手，再比数字选择动作。';
  else if (left.phase === 'pose') result.leftHint = '比 1 / 2 / 4 指；3 为拇食指成圈，其余三指伸出。';
  else if (left.phase === 'blocked') result.leftHint = frame?.rightHeld ? '先松开右手，再切换动作。' : '当前操作结束后，可切换动作。';
  else if (uncertain(left.phase)) result.leftHint = left.phase === 'ambiguous' ? '请分开双手，让左手掌心朝向摄像头。' : '让左手保持稳定，五指完整入镜。';

  const next = (title, detail, state = 'waiting') => Object.assign(result, {title, detail, state});
  if (dual) return next('正在缩放场景', '双手拉开或靠近，松手结束缩放。', 'active');
  if (active) return next(`正在${{move: '移动家具', height: '抬高家具', rotate: '旋转家具', scale: '缩放场景', view: '观察场景'}[mode] || '调整家具'}`, ['scale', 'view'].includes(mode) ? '松开右手结束镜头操作。' : '松开右手保留预览，满意后竖拇指确认。', 'active');
  if (uncertain(right.phase)) return next('调整右手的位置', right.phase === 'ambiguous' ? '分开双手，让右手清楚入镜。' : '让右手保持稳定，避免遮挡手指。', 'attention');
  if (!rightSeen) return leftSeen ? next('请伸出右手', '右手捏合家具进行操作，松手保留预览。') : result;
  if (right.phase === 'sent') return next(right.action === 'cancel' ? '取消请求已发送' : '确认请求已发送', '操作结果请看场景中的提示。', 'submitted');
  if (target.allowed) {
    if (right.phase === 'neutral') return next('先放下拇指，再重新竖起', '四指收拢，保持约半秒即可提交放置。');
    result.confirmProgress = right.phase === 'confirming' ? progress(right.progress) : 0;
    return next(right.phase === 'confirming' ? (right.action === 'cancel' ? '保持拇指向下，正在取消' : '保持竖拇指，正在确认') : '拇指向上确认，向下取消', '四指收拢，保持约半秒；取消会恢复原位置。', 'confirming');
  }
  if (busy || target.previewId) return next('等待当前操作结束', '松开双手，完成放置检查后再确认。');
  if (result.candidate) return next('保持左手，等待动作切换', '进度完成后，再用右手操作。', 'active');
  if (frame?.operator?.pinching) return next('已识别捏合手势', '先松开，对准家具后再次捏合。', 'active');
  return next('捏合家具开始调整', '松手保留预览，满意后竖拇指确认。', 'ready');
}

export function mountGestureFeedback(root) {
  const $ = selector => root.querySelector(selector);
  const nodes = Object.fromEntries(['left-state', 'right', 'left-tracking', 'right-tracking', 'left', 'next', 'next-title', 'confirm', 'mode-meter', 'mode-percent', 'progress', 'confirm-meter', 'confirm-percent', 'confirm-progress'].map(key => [key, $(`#gesture-${key}`)]));
  const buttons = [...root.querySelectorAll('[data-gesture-mode]')];
  let latest = {lifecycle: 'off', mode: 'move'};
  const text = (node, value) => {if (node.textContent !== value) node.textContent = value;};
  const state = (node, value) => {if (node.dataset.state !== value) node.dataset.state = value;};
  function meter(group, output, input, value) {
    group.hidden = value === null;
    const amount = Math.round((value || 0) * 100);
    text(output, `${amount}%`);
    if (input.value !== amount / 100) input.value = amount / 100;
  }
  function update(payload) {
    latest = payload;
    const value = gestureFeedback(payload);
    text(nodes['left-state'], value.left.label); text(nodes.right, value.right.label);
    state(nodes['left-tracking'], value.left.state); state(nodes['right-tracking'], value.right.state);
    text(nodes.left, value.leftHint);
    text(nodes['next-title'], value.title); text(nodes.confirm, value.detail); state(nodes.next, value.state);
    meter(nodes['mode-meter'], nodes['mode-percent'], nodes.progress, value.modeProgress);
    meter(nodes['confirm-meter'], nodes['confirm-percent'], nodes['confirm-progress'], value.confirmProgress);
    for (const button of buttons) {
      const candidate = String(button.dataset.gestureMode === value.candidate);
      if (button.dataset.candidate !== candidate) button.dataset.candidate = candidate;
    }
  }
  update(latest);
  return {update, setMode(mode) {update({...latest, mode});}};
}
