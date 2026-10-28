import {copyLayout} from './layout.mjs';

// Predict and confirm through the same contact geometry. A partial chair/table
// edge or an obstacle in the vertical path cannot become a floor shortcut.
export function predictDrop(id, source, placement, collision, {previewOnly = false} = {}) {
  const start = dropStart(id, source, placement, {previewOnly});
  if (start.result) return start.result;
  const {base} = start, contact = collision.checkPlacement(base.candidate, base.moved);
  return dropVerdict(base, contact, contact.ok ? collision.limit(source, base.candidate, base.moved) : null);
}

// The support-only part: where the piece lands and whether it rests there. Either a final
// result, or the landing (base) still to be checked for collisions — by dropVerdict, here or
// with the results a worker computed (scene-editor.js).
export function dropStart(id, source, placement, {previewOnly = false} = {}) {
  const candidate = copyLayout(source);
  const settled = placement.settle(id, candidate);
  if (!settled.ok) return {result: {...settled, candidate, height:settled.surface?.y, label:settled.surface?.label}};
  const carried = placement.carry(id, source, candidate);
  if (!carried.ok) return {result: {...carried, candidate}};
  const state = placement.assess(id, candidate);
  const base = {candidate, moved: carried.moved, state, height:state.height, label:settled.surface?.label,
    distance: Math.max(0, (source[id].y || 0) - (candidate[id].y || 0))};
  if (state.state !== 'stable') return {result: {...base, ok:false, message:state.detail || state.label}};
  // During analog input, compute the real support projection without blocking
  // the input thread on a full triangle sweep. This result cannot be confirmed.
  if (previewOnly) return {result: {...base, ok:true, checked:false, message:`预计落到${state.label.replace(/^已放稳 · /, '')}`}};
  return {base};
}

// contact: collision.checkPlacement(candidate, moved); sweep: collision.limit(source, candidate,
// moved), needed only when contact is clear.
export function dropVerdict(base, contact, sweep) {
  if (!contact.ok) return {...base, ok:false, message:`落点会碰到${contact.other?.name || '其他物品'}`};
  // A fall that stops within 2 mm of a landing already checked clear has landed: a flat
  // base meeting a curved seat stops a hair early at its first touch.
  const short = (1 - (sweep.fraction ?? 0)) * base.distance;
  if (sweep.blocked && short > .002) return {...base, ok:false, message:`下落途中会碰到${sweep.other?.name || '其他物品'}，请调整位置或高度`};
  return {...base, ok:true, checked:true, message:`将落到${base.state.label.replace(/^已放稳 · /, '')}`};
}

// A short gravity-shaped visual animation; the validated landing remains exact.
export function fallFraction(seconds, distance, acceleration = 7) {
  if (distance <= 1e-6) return 1;
  return Math.min(1, acceleration * seconds * seconds / (2 * distance));
}
