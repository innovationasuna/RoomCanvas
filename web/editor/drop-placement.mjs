import {copyLayout} from './layout.mjs';

// Predict and confirm through the same contact geometry. A partial chair/table
// edge or an obstacle in the vertical path cannot become a floor shortcut.
export function predictDrop(id, source, placement, collision, {previewOnly = false} = {}) {
  const candidate = copyLayout(source);
  const settled = placement.settle(id, candidate);
  if (!settled.ok) return {...settled, candidate, height:settled.surface?.y, label:settled.surface?.label};
  const carried = placement.carry(id, source, candidate);
  if (!carried.ok) return {...carried, candidate};
  const state = placement.assess(id, candidate);
  const base = {candidate, moved: carried.moved, state, height:state.height, label:settled.surface?.label,
    distance: Math.max(0, (source[id].y || 0) - (candidate[id].y || 0))};
  if (state.state !== 'stable') return {...base, ok:false, message:state.detail || state.label};
  // During analog input, compute the real support projection without blocking
  // the input thread on a full triangle sweep. This result cannot be confirmed.
  if (previewOnly) return {...base, ok:true, checked:false, message:`预计落到${state.label.replace(/^已放稳 · /, '')}`};
  const contact = collision.checkPlacement(candidate, carried.moved);
  if (!contact.ok) return {...base, ok:false, message:`落点会碰到${contact.other?.name || '其他物体'}`};
  const sweep = collision.limit(source, candidate, carried.moved);
  // A fall that stops within 2 mm of a landing already checked clear has landed: a flat
  // base meeting a curved seat stops a hair early at its first touch.
  const short = (1 - (sweep.fraction ?? 0)) * base.distance;
  if (sweep.blocked && short > .002) return {...base, ok:false, message:`下落途中会碰到${sweep.other?.name || '其他物体'}，请调整位置或高度`};
  return {...base, ok:true, checked:true, message:`将落到${state.label.replace(/^已放稳 · /, '')}`};
}

// A short gravity-shaped visual animation; the validated landing remains exact.
export function fallFraction(seconds, distance, acceleration = 7) {
  if (distance <= 1e-6) return 1;
  return Math.min(1, acceleration * seconds * seconds / (2 * distance));
}
