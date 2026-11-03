// Replay timeline: map a job's events (real minutes) onto a fixed-length playback (seconds).
// Each reached stage gets time in proportion to how much happened in it; events are spread
// evenly inside their stage, and the clock still shows the real time.
export const DURATION = 90;

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
  const weight = (s) => 1.6 + s.count;
  const total = stages.reduce((n, s) => n + weight(s), 0) || 1;
  let cursor = 0;
  for (const s of stages) {
    s.replay = [cursor, cursor + weight(s) / total * duration];
    cursor = s.replay[1];
  }
  if (stages.length) stages.at(-1).replay[1] = duration;
  for (const s of stages) {
    const own = events.filter((e) => e.stage === s.id), [a, b] = s.replay;
    own.forEach((e, j) => (e.at = a + (b - a) * (j + 0.25) / own.length));
  }
  if (events.length) events[0].at = 0;
  const keys = [...stages.flatMap((s) => [[s.replay[0], s.real[0]], [s.replay[1], s.real[1]]]), ...events.map((e) => [e.at, e.minute])]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    duration, stages, events, build: data.build || null, models: data.models || {},
    stageAt: (t) => stages.findLast((s) => t >= s.replay[0]) || stages[0],
    indexAt: (t) => events.findLastIndex((e) => e.at <= t),
    // Playback time -> real minutes, interpolated between stage edges and events.
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

// The closing line: how many acceptance rounds, best score, passed or not.
export function outcome(events) {
  const rounds = events.filter((e) => e.kind === 'review' && typeof e.score === 'number');
  if (!rounds.length) return null;
  const last = rounds.at(-1), best = Math.max(...rounds.map((e) => e.score));
  return {passed: !!last.passed, text: last.passed ? `验收通过（${last.score.toFixed(1)} 分）`
    : `验收查了 ${rounds.length} 轮，最高 ${best.toFixed(1)} 分，没达到发布标准`};
}
