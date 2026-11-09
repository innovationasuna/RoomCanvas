// Replay timeline: map a job's events (real minutes) onto a short playback (seconds).
// Playback time follows real time in proportion, except that long waits with nothing new are squeezed,
// and each object taking shape in the room keeps enough time to watch it. The clock shows real time.
export const DURATION = 90;       // seconds, unless the objects need more (see FORM_SECONDS)
const FORM_SECONDS = 4.5;         // camera moves in (~1.2 s), then the object takes shape (3 s)
const FORM_SHARE = 0.6;           // objects taking shape fill at most this share of the playback
const EVENT_SECONDS = 0.25;       // any two events stay apart at least this long
const STAGE_SECONDS = 2;          // a stage's first event keeps this long, so quick stages still show what they do
const UNFOLD_SECONDS = 6;         // the scan stage at least: the scan unfolds slowly
const TAIL = 0.03;                // share of the playback after the last event

// Real minutes a wait counts for: short waits as they are, long ones squeezed (total: the whole run).
export function squeeze(minutes, total) {
  const cap = Math.max(total * 0.04, 1);
  return minutes <= cap ? minutes : cap + (minutes - cap) * 0.1;
}

export function buildTimeline(data, duration = DURATION) {
  const events = (data.events || []).map((e, i) => ({...e, i}));
  const reached = (data.stages || []).filter((s) => events.some((e) => e.stage === s.id));
  let end = 0;
  const stages = reached.map((s) => {
    const own = events.filter((e) => e.stage === s.id);
    // Continuous real intervals; an event on a boundary belongs to the earlier stage.
    const real = [end, Math.max(end, ...own.map((e) => e.minute))];
    end = real[1];
    return {...s, real, count: own.length};
  });
  // From the modelling stage on, the room shell shows and a finished object takes shape in place; so do the
  // parts the modelling agent adds to the final model.
  const order = (data.stages || []).map((s) => s.id), plan = order.indexOf('plan');
  const forms = (e) => plan >= 0 && order.indexOf(e.stage) >= plan && !!e.show?.some((k) => k !== '@boxes');
  const build = data.build || null;
  const points = [
    ...events.map((e, k) => ({minute: e.minute, form: forms(e), opens: !k || events[k - 1].stage !== e.stage, scan: e.stage === 'scan'})),
    // parts named at the same minute appear together
    ...(build && data.models?.final ? [...new Set(build.reveal.map((r) => r.minute))].map((minute) => ({minute, form: true})) : []),
  ].sort((a, b) => a.minute - b.minute || a.form - b.form);
  const forming = points.filter((p) => p.form).length;
  duration = Math.max(duration, forming * FORM_SECONDS / FORM_SHARE);
  // Each gap between two points gets max(its least time, squeezed real time × scale); find the scale that
  // fills the playback (less the tail).
  const last = points.at(-1)?.minute ?? 0, first = points[0]?.minute ?? 0;
  const gaps = points.slice(1).map((p, k) => ({
    real: squeeze(Math.max(p.minute - points[k].minute, 0), last - first),
    least: Math.max(points[k].form ? FORM_SECONDS : 0, points[k].opens ? STAGE_SECONDS : 0, EVENT_SECONDS),
  }));
  // The scan stage's events share UNFOLD_SECONDS at least.
  const scanGaps = gaps.filter((g, k) => points[k].scan);
  scanGaps.forEach((g) => (g.least = Math.max(g.least, UNFOLD_SECONDS / scanGaps.length)));
  const room = duration * (1 - TAIL);
  const fill = (scale) => gaps.reduce((n, g) => n + Math.max(g.least, g.real * scale), 0);
  let lo = 0, hi = 1;
  while (fill(hi) < room && hi < 1e9) hi *= 2;
  for (let k = 0; k < 60; k++) {const mid = (lo + hi) / 2; if (fill(mid) < room) lo = mid; else hi = mid;}
  const scale = gaps.length && fill(0) < room ? hi : 0;
  const leastSum = fill(0), shrink = leastSum > room ? room / leastSum : 1;  // too many points: shrink evenly
  // keys: [playback seconds, real minutes], one per point
  const keys = [];
  let at = 0;
  points.forEach((p, k) => {
    if (k) {const g = gaps[k - 1]; at += Math.max(g.least, g.real * scale) * shrink;}
    keys.push([at, p.minute]);
  });
  // Events in order of time: each takes the next key at its minute.
  const used = new Set();
  for (const e of [...events].sort((a, b) => a.minute - b.minute || a.i - b.i)) {
    let k = keys.findIndex((x, j) => !used.has(j) && x[1] >= e.minute - 1e-9);
    if (k < 0) k = keys.length - 1;
    used.add(k);
    e.at = keys[k][0];
  }
  // A stage runs from its first event to the next stage's first event.
  for (const s of stages) s.replay = [Math.min(...events.filter((e) => e.stage === s.id).map((e) => e.at)), 0];
  if (stages.length) stages[0].replay[0] = 0;
  stages.forEach((s, k) => (s.replay[1] = k + 1 < stages.length ? stages[k + 1].replay[0] : duration));
  if (events.length) events[0].at = 0;
  return {
    duration, stages, events, build, models: data.models || {},
    stageAt: (t) => stages.findLast((s) => t >= s.replay[0]) || stages[0],
    indexAt: (t) => events.findLastIndex((e) => e.at <= t),
    // Playback time -> real minutes, interpolated between keys.
    realAt(t) {
      const k = keys.findLastIndex((x) => x[0] <= t);
      if (k < 0) return 0;
      if (k === keys.length - 1) return keys[k][1];
      const [t0, r0] = keys[k], [t1, r1] = keys[k + 1];
      return t1 > t0 ? r0 + (Math.max(r1, r0) - r0) * (t - t0) / (t1 - t0) : r0;
    },
  };
}

export function clock(minutes) {
  const s = Math.round(minutes * 60), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// What the 3D view shows at playback time t.
export function sceneAt(tl, t) {
  const by = Object.fromEntries(tl.stages.map((s) => [s.id, s]));
  const clamp = (x) => Math.min(Math.max(x, 0), 1);
  const past = tl.events.filter((e) => e.at <= t);
  const built = new Set();
  past.forEach((e) => e.show?.forEach((x) => built.add(x)));
  let model = past.findLast((e) => e.model)?.model || null;
  // While the modelling agent works no room model is saved: show the final model with the parts the agent
  // added appearing when its log first names them (build schedule from the room service).
  let added = null;
  const real = tl.realAt(t);
  if (tl.build && tl.models.final && (!model || model === 'seed') && real >= tl.build.base) {
    model = 'final';
    added = new Set(tl.build.reveal.filter((r) => r.minute <= real).map((r) => r.node));
  }
  const scan = by.scan?.replay, layout = by.layout?.replay;
  return {
    points: scan ? clamp((t - scan[0]) / Math.max(scan[1] - scan[0] - 0.5, 0.5)) : past.length ? 1 : 0,
    pointsDim: layout ? t >= layout[0] : false,
    walls: layout ? clamp((t - layout[0]) / 2) : model ? 1 : 0,
    boxes: built.has('@boxes') || (layout ? t >= layout[1] - 0.5 : false),
    // From the modelling stage on, the room shell shows and finished objects appear in place.
    shell: by.plan ? t >= by.plan.replay[0] : !!model,
    built,
    model,
    added,  // null: the model as it is; a set: only these agent-added parts of the final model show
  };
}

// The closing line: whether the one check passed, or the room was repaired after it (no score).
export function outcome(events) {
  const checks = events.filter((e) => e.kind === 'review');
  if (!checks.length) return null;
  if (checks.at(-1).passed) return {passed: true, repaired: false, text: '检查通过'};
  const fix = events.findLast((e) => String(e.id || '').startsWith('fix'));
  if (fix?.kind === 'result') return {passed: true, repaired: true, text: '没通过检查，已按问题修好'};
  return {passed: false, repaired: false, text: '没通过检查'};
}

// Text shown to people carries no scores (older records said "4.5 分" or "自评 6.5 分").
export function withoutScores(text) {
  const had = /\d\s*分/.test(String(text ?? ''));
  const out = String(text ?? '')
    .replace(/[（(]?\s*(?:自评|评分|打分|得分|最高)?\s*\d+(?:\.\d+)?\s*分\s*[）)]?/g, '')
    .replace(/\s+([，。、：；])/g, '$1').replace(/([，、：；])\1+/g, '$1').replace(/^[，、：；\s]+|[，、：；\s]+$/g, '')
    .replace(/轮验收/g, '次检查').replace(/验收/g, '检查');
  return out || (had ? '完成一次自查' : out);
}
