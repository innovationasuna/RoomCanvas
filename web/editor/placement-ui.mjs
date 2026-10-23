// DOM adapter for the user-selected placement sample. Geometry and persistence
// stay in the scene adapter; this module only presents the current transaction.
const $ = selector => document.querySelector(selector);

export function updatePlacementPanel({pending, wall, wallRelocation, value}) {
  const valid = wallRelocation ? wallRelocation.valid : pending?.valid;
  $('.rc-state').classList.toggle('is-invalid', !!pending && !valid);
  $('#session-status').textContent = pending ? `${wallRelocation ? wallRelocation.message : pending.message}` : '选择 → 虚影预览 → 确认放置';
  $('#confirm-placement').disabled = !pending || !valid;
  $('#session-rotate-left').disabled = $('#session-rotate-right').disabled = !!wall;
  $('#lock-preview').textContent = wallRelocation ? '锁定后微调' : pending?.locked ? '继续移动预览' : '锁定预览';
  $('#lock-preview').setAttribute('aria-pressed', String(!!pending?.locked));
  $('#interaction-help').textContent = pending ? wallRelocation ? '移动鼠标选择墙面 · 单击锁定后微调' : pending.locked ? '拖动摇杆移动 · 圆盘旋转 · Enter 确认' : wall ? '移动鼠标选择墙面 · 单击锁定' : '移动鼠标摆放 · 单击锁定 · R 旋转' : '拖动空白处转动视角 · 滚轮缩放';
  if (pending) $('#save-state').textContent = '预览尚未保存 · 确认后自动保存';
  const pose = wallRelocation?.candidate?.[pending?.id] || value;
  $('#candidate-coordinate').textContent = pose ? `X ${pose.x.toFixed(2)} · ${wall ? `高度偏移 ${(pose.y || 0).toFixed(2)}` : `Y ${(pose.y || 0).toFixed(2)} · Z ${pose.z.toFixed(2)}`} · ${Math.round(pose.yaw*180/Math.PI)}°` : '';
}

export function bindPlacementPanel(actions) {
  for (const [id, action] of Object.entries({
    'confirm-placement': actions.confirm,
    'cancel-placement': actions.cancel,
    'lock-preview': actions.lock,
    'session-rotate-left': () => $('#rotate-left').click(),
    'session-rotate-right': () => $('#rotate-right').click(),
    'store-object': actions.store,
    'clear-room': actions.clear,
  })) $(`#${id}`).onclick = action;
  for (const button of document.querySelectorAll('[data-mode]')) button.onclick = () => actions.setMode(button.dataset.mode);
}
