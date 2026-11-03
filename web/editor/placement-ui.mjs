// DOM adapter for the user-selected placement sample. Geometry and persistence
// stay in the scene adapter; this module only presents the current transaction.
const $ = selector => document.querySelector(selector);

// Dimensions are the model's X/Y/Z extents; layout values are offsets from its initial pose.
export function furnitureReadouts(dimensions, value = {}) {
  const number = (value, digits, signed = false) => {
    if (!Number.isFinite(value)) return '—';
    const rounded = Number(value.toFixed(digits));
    return `${signed && rounded > 0 ? '+' : ''}${(rounded === 0 ? 0 : rounded).toFixed(digits)}`;
  };
  return {
    width: number(dimensions?.[0], 2), depth: number(dimensions?.[2], 2), height: number(dimensions?.[1], 2),
    x: number(value.x, 3, true), y: number(value.y ?? 0, 3, true), z: number(value.z, 3, true),
    rotation: Number.isFinite(value.yaw) ? `${number(value.yaw * 180 / Math.PI, 1)}°` : '—',
  };
}

export function updateFurnitureReadouts(dimensions, value) {
  const data = furnitureReadouts(dimensions, value);
  for (const key of ['width', 'depth', 'height']) $('#dimension-'+key).textContent = data[key];
  for (const key of ['x', 'y', 'z']) $('#offset-'+key).textContent = data[key];
  $('#rotation').textContent = data.rotation;
}

export function updatePlacementPanel({pending, wall, wallRelocation, value}) {
  const valid = wallRelocation ? wallRelocation.valid : pending?.valid;
  $('.rc-state').classList.toggle('is-invalid', !!pending && !valid);
  $('#session-status').textContent = pending ? `${wallRelocation ? wallRelocation.message : pending.message}` : '拖动下方控件调整 · 确认后保存';
  $('#confirm-placement').disabled = !pending || !valid;
  $('#cancel-placement').disabled = !pending;
  $('#session-rotate-left').disabled = $('#session-rotate-right').disabled = !!wall;
  $('#lock-preview').textContent = wallRelocation ? '锁定墙面后微调' : pending?.locked ? '在画面中选择位置' : '停止跟随鼠标';
  $('#lock-preview').setAttribute('aria-pressed', String(!!pending?.locked));
  $('#interaction-help').textContent = pending ? wallRelocation ? '移动鼠标选择墙面 · 单击锁定后微调' : pending.locked ? '拖动家具或使用右侧工具 · Enter 确认' : wall ? '移动鼠标选择墙面 · 单击锁定' : '移动鼠标摆放 · 单击锁定 · R 旋转' : '中键拖动旋转 · 右键拖动平移 · 滚轮缩放';
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
  for (const button of document.querySelectorAll('button[data-mode]')) button.onclick = () => actions.setMode(button.dataset.mode);
}
