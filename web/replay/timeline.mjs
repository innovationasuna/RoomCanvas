// Replay timeline: map a job's events (real minutes) onto a short playback (seconds).
// Playback time goes to what there is to watch: the scan unfolding, each object taking shape in the room, a
// new room model fading in. Everything else passes quickly, however long it really took. The clock shows the
// time the reconstruction worked: real time without the stretches in which nothing shown was being worked on
// (data.idle: no run going, or a run whose work a later one replaced).
export const DURATION = 90;       // seconds, for a job with no events yet
const FORM_SECONDS = 4.5;         // camera moves in (~1.2 s), then the object takes shape (3 s)
const CASCADE_STEP = 0.25, CASCADE_SECONDS = 4;  // objects appearing together start this far apart, all within (room-view.mjs)
const MODEL_SECONDS = 2;          // a new room model fades in (room-view.mjs)
const EVENT_SECONDS = 0.1;        // any other event: the record runs on, ten lines a second
const STAGE_SECONDS = 1.5;        // a stage's first event keeps this long, to read what the stage does
const UNFOLD_SECONDS = 6;         // the scan stage at least: the scan unfolds slowly
const TAIL_SECONDS = 3;           // after the last event

// Old offline answers used fixed success text before saves recorded joints and publication.
export function readReplay(data) {
  const stages = data.stages.map(s => {
    const old = s.id === 'articulate';
    const name = old && s.name === '装上可开合部件' ? '处理可开合部件' : withoutScores(s.name);
    let desc = old && s.desc === '找出柜门、抽屉等能开合的部件，装上转轴或滑轨，这就是发布的房间。'
      ? '检查柜门和抽屉，按需添加转轴或滑轨。' : withoutScores(s.desc);
    if (s.id === 'revise' && s.desc === '房间发布后收到修改意见，建模 agent 回到这间房间逐条改进，再检查、发布一次。') {
      desc = '对照修改意见逐项调整房间，并检查修改效果。';
    }
    return {...s, name, desc};
  });
  const events = withoutErrors(data.events || []).map(e => {
    if (e.model !== 'articulated' || e.say !== '装好可开合部件，这就是发布的房间') return e;
    const say = (e.joints > 0 ? '装好可开合部件' : '完成开合处理') + (e.published ? '，已发布这版房间' : '');
    return {...e, say};
  });
  return {...data, stages, events};
}

export function buildTimeline(data) {
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
  // From the modelling stage on, the room shell shows and a finished object takes shape in place, the first
  // time it shows (made again, it is already there); so do the parts the modelling agent adds to the final
  // model, until a later room model shows instead (see sceneAt).
  const order = (data.stages || []).map((s) => s.id), plan = order.indexOf('plan'), seen = new Set();
  const forms = (e) => (plan >= 0 && order.indexOf(e.stage) >= plan && e.show || [])
    .filter((k) => k !== '@boxes' && !seen.has(k) && seen.add(k)).length;
  const build = data.build || null;
  const model = (minute) => events.findLast((e) => e.model && e.minute <= minute)?.model;
  // parts named at the same minute appear together
  const batches = new Map();
  if (build && data.models?.final) for (const r of build.reveal) batches.set(r.minute, (batches.get(r.minute) || 0) + 1);
  // form: how many things take shape at this point (an event keeps its own count as e.forms)
  const points = [
    ...events.map((e, k) => ({e, minute: e.minute, form: (e.forms = forms(e)), opens: !k || events[k - 1].stage !== e.stage, scan: e.stage === 'scan'})),
    ...[...batches].filter(([minute]) => [undefined, 'seed'].includes(model(minute))).map(([minute, form]) => ({minute, form})),
  ].sort((a, b) => a.minute - b.minute);
  // Each point keeps only the time it takes to watch what it brings (a batch: its last object starts later);
  // the last point, the tail.
  const keep = points.map((p, k) => Math.max(
    p.form ? FORM_SECONDS + Math.min((p.form - 1) * CASCADE_STEP, CASCADE_SECONDS) : 0, p.e?.model ? MODEL_SECONDS : 0,
    p.opens ? STAGE_SECONDS : 0, k === points.length - 1 ? TAIL_SECONDS : 0, EVENT_SECONDS));
  // The scan stage's events share UNFOLD_SECONDS at least.
  const scans = points.filter((p) => p.scan).length;
  points.forEach((p, k) => p.scan && (keep[k] = Math.max(keep[k], UNFOLD_SECONDS / scans)));
  // keys: [playback seconds, real minutes], one per point
  let at = 0;
  const keys = points.map((p, k) => {
    const key = [at, p.minute];
    if (p.e) p.e.at = at;
    at += keep[k];
    return key;
  });
  const duration = at || DURATION;
  // A stage runs from its first event to the next stage's first event.
  for (const s of stages) s.replay = [Math.min(...events.filter((e) => e.stage === s.id).map((e) => e.at)), 0];
  if (stages.length) stages[0].replay[0] = 0;
  stages.forEach((s, k) => (s.replay[1] = k + 1 < stages.length ? stages[k + 1].replay[0] : duration));
  if (events.length) events[0].at = 0;
  return {
    duration, stages, events, build, models: data.models || {},
    stageAt: (t) => stages.findLast((s) => t >= s.replay[0]) || stages[0],
    indexAt: (t) => events.findLastIndex((e) => e.at <= t),
    // Real minutes -> minutes the reconstruction worked (the clock).
    workAt: (minute) => minute - (data.idle || []).reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, minute) - a), 0),
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
  const modelEvent = past.findLast((e) => e.model);
  let model = modelEvent?.model || null;
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
    // The scan shows while it is read; it fades out as the layout stage draws the walls and boxes over it.
    pointsFade: layout ? 1 - clamp(t - layout[0]) : 1,
    walls: layout ? clamp((t - layout[0]) / 2) : model ? 1 : 0,
    boxes: built.has('@boxes') || (layout ? t >= layout[1] - 0.5 : false),
    // From the modelling stage on, the room shell shows and finished objects appear in place.
    shell: by.plan ? t >= by.plan.replay[0] : !!model,
    built,
    model,
    modelEvent: model === modelEvent?.model ? modelEvent : null,
    added,  // null: the model as it is; a set: only these agent-added parts of the final model show
  };
}

// The closing line: whether the one check passed, or the room was repaired after it (no score).
export function outcome(events) {
  const checks = events.filter((e) => e.kind === 'review');
  if (!checks.length) return null;
  const last = checks.at(-1);
  if (last.passed) return {passed: true, repaired: false, text: '检查通过'};
  // Only a repair after the last check counts (a retried job may have repaired in an earlier run).
  const fix = events.slice(events.indexOf(last)).findLast((e) => String(e.id || '').startsWith('fix'));
  if (fix?.kind === 'result') return {passed: true, repaired: true, text: '没通过检查，已按问题修好'};
  return {passed: false, repaired: false, text: '没通过检查'};
}

// The page shows what was done, not what went wrong on the way (failed attempts, errors): those stay in
// the logs. The check's verdict and the job's own status still show.
export function withoutErrors(events) {
  return events.filter((e) => e.kind !== 'error');
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
