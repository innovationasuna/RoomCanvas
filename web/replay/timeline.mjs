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

const displayMinute = (e) => e.display_minute ?? e.minute;
const standalonePass = (id) => id === 'small_objects' || id === 'articulate';

// Offline answers from the previous service still put standalone passes after the reviews.
// Move only their presentation. The minutes on the records and pictures describe the original run.
function projectCachedPasses(data) {
  const {events, stages} = data;
  const oldParts = stages.find(s => s.id === 'articulate');
  const ordered = stages.filter(s => !standalonePass(s.id)).map(s => {
    if (s.id === 'assemble') return {...s, desc: '对照照片搭建房间，整理有记录的陈设和小物品。'};
    if (s.id === 'review2') return {...s, desc: '查看当时的检查意见和修改记录。'};
    return s;
  });
  const afterBuild = (id) => ['parts', 'review', 'review2', 'revise'].includes(id);
  const boundary = ordered.findIndex(s => afterBuild(s.id));
  if (oldParts && !ordered.some(s => s.id === 'parts')) {
    ordered.splice(boundary < 0 ? ordered.length : boundary, 0, {...oldParts, id: 'parts'});
  }

  const main = events.filter(e => !standalonePass(e.stage));
  const cut = main.findIndex(e => afterBuild(e.stage));
  const anchor = displayMinute((cut >= 0 ? main[cut] : main.at(-1)) || {minute: 0});
  const revision = main.find(e => e.stage === 'revise')?.minute ?? Infinity;
  const passes = [], revised = [];
  const rank = e => {
    if (e.id === 'articulated_published') return 2;
    return e.model || e.kind === 'milestone' ? 1 : 0;
  };
  let latest = main.at(-1), latestMinute = latest ? displayMinute(latest) : -Infinity;
  let lastSave = -Infinity, lastPass = -Infinity;
  for (const [from, stage] of [['small_objects', 'assemble'], ['articulate', 'parts']]) {
    const batch = events.filter(e => e.stage === from);
    // Old responses ordered cached saves by file mtime. They close the pass after its item records.
    batch.sort((a, b) => rank(a) - rank(b));
    let minute = -Infinity;
    for (const e of batch) {
      minute = Math.max(minute, e.minute);
      if (minute >= latestMinute) {latest = e; latestMinute = minute;}
      if (minute >= revision) {
        revised.push({...e, stage: 'revise', recorded_stage: from, display_minute: minute});
      } else {
        passes.push({...e, stage, recorded_stage: from, display_minute: anchor});
        lastPass = Math.max(lastPass, minute);
        if (data.models?.[e.model]) lastSave = Math.max(lastSave, minute);
      }
    }
  }
  const before = cut < 0 ? main : main.slice(0, cut);
  const after = cut < 0 ? [] : main.slice(cut);
  // Review images and verdicts describe their original snapshots. An older room must not
  // replace the enhanced room on screen just because its review now follows the pass.
  const reviews = after.map(e => {
    const record = {...e};
    if (e.stage !== 'revise' && e.model && e.minute <= lastSave) {
      record.recorded_model = e.model;
      delete record.model;
    }
    if (e.id === 'final' && e.minute <= lastPass) record.say = '导出当时的房间';
    return record;
  });
  const projected = [...before, ...passes, ...reviews, ...revised].sort((a, b) => displayMinute(a) - displayMinute(b));
  return {...data, presentation: 'by_stage', latest_event: latest?.id, stages: ordered, events: projected};
}

// Upgrade cached responses that projected an entire post-pass room (including #157 caches). A pass
// without a saved room or without an item made from photos keeps the old presentation.
function projectSmallItems(data) {
  const small = data.events.filter(e => e.recorded_stage === 'small_objects');
  const usable = small.some(e => data.models?.[e.model || e.overlay_model]) && small.some(e => e.work === 'small' && e.object_id);
  if (!usable || small.every(e => e.stage === 'assemble' && !e.model)
      && !data.events.some(e => e.recorded_model)) return data;
  const base = data.events.filter(e => e.recorded_stage !== 'small_objects').map(e => {
    if (!e.recorded_model) return e;
    const {recorded_model, ...record} = e;
    return {...record, model: recorded_model};
  });
  const cut = base.findIndex(e => ['parts', 'review', 'review2', 'revise'].includes(e.stage));
  const split = cut < 0 ? base.length : cut;
  const anchor = displayMinute(base[split] || base.at(-1) || {minute: 0});
  const placed = small.map(({model, ...e}) => ({...e, stage: 'assemble', display_minute: anchor,
    ...(model ? {overlay_model: model} : {})}));
  return {...data, events: [...base.slice(0, split), ...placed, ...base.slice(split)]};
}

// Old offline answers used fixed success text before saves recorded joints and publication.
export function readReplay(data) {
  const stages = data.stages.map(s => {
    const old = s.id === 'articulate' || s.id === 'parts';
    const name = old && s.name === '装上可开合部件' ? '处理可开合部件' : withoutScores(s.name);
    let desc = s.id === 'articulate' && s.desc === '找出柜门、抽屉等能开合的部件，装上转轴或滑轨，这就是发布的房间。'
      ? '检查柜门和抽屉，按需添加转轴或滑轨。' : withoutScores(s.desc);
    if (s.id === 'parts' && s.desc === '找出柜门、抽屉等能开合的部件，装上转轴或滑轨，装好后检查房间。') {
      desc = '检查柜门和抽屉，按需添加转轴或滑轨，再检查房间。';
    }
    if (s.id === 'revise' && s.desc === '房间发布后收到修改意见，建模 agent 回到这间房间逐条改进，再检查、发布一次。') {
      desc = '对照修改意见逐项调整房间，并检查修改效果。';
    }
    return {...s, name, desc};
  });
  const events = withoutErrors(data.events || []).map(e => {
    if (e.say === '按检查出的问题修好了房间') return {...e, say: '已完成本轮修改'};
    if (e.work === 'small' && e.say?.endsWith('换成了按照片重建的模型')) {
      return {...e, say: e.say.replace('换成了按照片重建的模型', '的照片模型已就绪')};
    }
    if (e.say === '逐个看房间里的小物品，挑出需要按照片重做的') return {...e, say: '整理小物品的照片和模型'};
    if (e.say?.startsWith('小物品处理好了')) {
      return {...e, say: e.say.replace('小物品处理好了', '小物品处理完成').replace('按照片重做', '采用照片模型')};
    }
    const standalone = e.model === 'articulated' && e.say === '装好可开合部件，这就是发布的房间';
    const integrated = e.kind === 'milestone' && /^parts\d+$/.test(e.id) && e.say === '装好可开合部件';
    if (!standalone && !integrated) return e;
    const say = (e.joints > 0 ? '装好可开合部件' : '完成开合处理') + (e.published ? '，已发布这版房间' : '');
    return {...e, say};
  });
  let answer = {...data, stages, events};
  if (data.presentation === 'by_stage' && !('latest_event' in data) && events.some(e => standalonePass(e.recorded_stage))) {
    // An already projected cache still has the source stage, model and clock.
    answer.events = events.map(e => {
      if (standalonePass(e.recorded_stage)) {
        const {recorded_stage, display_minute, ...record} = e;
        return {...record, stage: recorded_stage};
      }
      if (!e.recorded_model) return e;
      const {recorded_model, ...record} = e;
      return {...record, model: recorded_model};
    }).sort((a, b) => displayMinute(a) - displayMinute(b));
  }
  if (answer.events.some(e => standalonePass(e.stage))) answer = projectCachedPasses(answer);
  else if (stages.some(s => standalonePass(s.id))) answer.stages = stages.filter(s => !standalonePass(s.id));
  answer = projectSmallItems(answer);
  if (answer.hidden_nodes) return answer;
  // A cached timeline only identifies the items with a successful per-object record.
  // On integrated runs, full review/final rooms already include those models.
  const nodes = new Set(events.filter(e => e.work === 'small' && e.object_id).map(e => e.object_id));
  if (!nodes.size) return answer;
  const standalone = [...new Set(answer.events.filter(e => e.recorded_stage === 'small_objects' && e.object_id)
    .map(e => e.object_id))];
  const hidden = {assembly: [...nodes]};
  for (const key of Object.keys(data.models || {})) {
    if (key === 'seed' || key.startsWith('draft')) {
      hidden[key] = hidden.assembly;
    } else if (standalone.length && /^(final|round\d+)$/.test(key)) hidden[key] = standalone;
  }
  const reveal = data.build?.reveal.filter(r => !nodes.has(r.node));
  return {...answer, hidden_nodes: hidden, build: reveal?.length ? {reveal, base: reveal[0].minute} : null};
}

export function buildTimeline(data) {
  const events = (data.events || []).map((e, i) => ({...e, i}));
  const hiddenNodes = data.hidden_nodes || {};
  const hiddenDuringBuild = [...new Set([...(hiddenNodes.final || []), ...(hiddenNodes.assembly || [])])];
  const reached = (data.stages || []).filter((s) => events.some((e) => e.stage === s.id));
  let end = 0;
  const stages = reached.map((s) => {
    const own = events.filter((e) => e.stage === s.id);
    // Continuous real intervals; an event on a boundary belongs to the earlier stage.
    const real = [end, Math.max(end, ...own.map(displayMinute))];
    end = real[1];
    return {...s, real, count: own.length};
  });
  // From the modelling stage on, the room shell shows and a finished object takes shape in place, the first
  // time it shows (made again, it is already there); so do the parts the modelling agent adds to the final
  // model, until a later room model shows instead (see sceneAt).
  const order = (data.stages || []).map((s) => s.id), plan = order.indexOf('plan'), seen = new Set();
  const forms = (e) => (plan >= 0 && order.indexOf(e.stage) >= plan && e.show || [])
    .filter((k) => k !== '@boxes' && !seen.has(k) && seen.add(k)).length;
  const pass = events.find(e => e.overlay_model && data.models?.[e.overlay_model]);
  const made = events.filter(e => e.recorded_stage === 'small_objects' && e.work === 'small' && e.object_id);
  const ids = [...new Set(made.map(e => e.object_id))];
  const photoItems = pass && ids.length ? {ids, model: pass.overlay_model, digest: pass.artifact_digest, minute: pass.minute,
    members: pass.overlay_members || {}, objects: pass.overlay_objects ? new Set(pass.overlay_objects) : null} : null;
  // A schedule only describes its own snapshot. An older cache inferred it from the final GLB, which after a
  // revision holds just the revision's additions: then the first review's room stands for the build.
  const target = data.build && (data.build.model || 'final');
  const build = photoItems && target === 'final' && events.some(e => e.stage === 'revise') ? null : data.build || null;
  const firstReview = events.find(e => e.stage === 'review' && /^round\d+$/.test(e.model) && data.models?.[e.model]);
  const buildModel = build ? target : photoItems && firstReview ? firstReview.model : 'final';
  const model = (minute) => events.findLast((e) => e.model && displayMinute(e) <= minute)?.model;
  // Checks after a projected pass show the rooms they checked. The replay still ends on the room published last
  // (the pass's openable-parts room, if every room shown after it was saved before the passes' records), once
  // the last of those rooms has had its turn.
  const rooms = events.filter(e => e.model), passRoom = rooms.findLast(e => e.recorded_stage === 'articulate' && data.models?.[e.model]);
  const passEnd = Math.max(...events.filter(e => standalonePass(e.recorded_stage)).map(e => e.minute));
  const later = rooms.slice(rooms.indexOf(passRoom) + 1);
  const ending = passRoom && later.length && later.every(e => e.minute <= passEnd) ? {event: passRoom, from: later.at(-1)} : null;
  // parts named at the same minute appear together
  const batches = new Map();
  if (build && data.models?.[buildModel]) for (const r of build.reveal) batches.set(r.minute, (batches.get(r.minute) || 0) + 1);
  // form: how many things take shape at this point (an event keeps its own count as e.forms)
  // Each photo item appears at its own record, the camera moving in on it as on an object taking shape.
  const placed = new Set(), appears = e => photoItems && made.includes(e) && !placed.has(e.object_id) && placed.add(e.object_id);
  const points = [
    ...events.map((e, k) => ({e, minute: displayMinute(e), form: (e.forms = forms(e)) || (appears(e) ? 1 : 0),
      opens: !k || events[k - 1].stage !== e.stage, scan: e.stage === 'scan'})),
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
  if (photoItems) {
    photoItems.at = made[0].at;  // the photo items' card
    photoItems.times = new Map(made.toReversed().map(e => [e.object_id, e.at]));  // each item's own record
  }
  if (ending) ending.at = events[events.indexOf(ending.from) + 1]?.at ?? duration;
  const latest = data.latest_event && events.find(e => e.id === data.latest_event);
  return {
    latestAt: latest && latest !== events.at(-1) ? latest.at : duration,
    duration, stages, events, build, buildModel, photoItems, ending, models: data.models || {}, hiddenNodes, hiddenDuringBuild,
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

// A projected pass has a display position separate from the photo's recorded minute.
// Its after-picture becomes available when the pass's saved room is presented.
export function comparisonAt(event, tl, t) {
  const picture = event.media?.findLast(m => m.role === 'comparison');
  if (!picture) return null;
  if (event.work === 'small' && event.display_minute != null) {
    return tl.events.some(e => e.at >= event.at && e.at <= t && (event.recorded_stage === 'small_objects'
      ? e.overlay_model && tl.models[e.overlay_model] : ['small_objects', 'articulated'].includes(e.model)))
      ? picture : null;
  }
  return picture.minute <= tl.realAt(t) ? picture : null;
}

// The photo pass's own room, or an openable-parts room made from it (perhaps split and renamed), already holds
// the photo models. Every other room takes the overlay, an earlier integrated small-object room included. So does
// an openable-parts room whose source is not known to be that room: one named without a digest (source_known),
// or an older answer with no source at all. Missing the photo items is worse than a doubled part at a joint,
// and the overlay still hides the room's own nodes of the same name.
function holdsPhotos(items, event) {
  if (!event || !items.digest) return false;
  if (event.model.startsWith('small_')) return [event.model, `small_${event.artifact_digest}`].includes(`small_${items.digest}`);
  return event.model === 'articulated' && event.source_digest === items.digest;
}

// What the 3D view shows at playback time t.
export function sceneAt(tl, t) {
  const by = Object.fromEntries(tl.stages.map((s) => [s.id, s]));
  const clamp = (x) => Math.min(Math.max(x, 0), 1);
  const past = tl.events.filter((e) => e.at <= t);
  const built = new Set();
  past.forEach((e) => e.show?.forEach((x) => built.add(x)));
  const modelEvent = (tl.ending && t >= tl.ending.at && tl.ending.event) || past.findLast((e) => e.model);
  let model = modelEvent?.model || null;
  // While the modelling agent works no room model is saved: show the final model with the parts the agent
  // added appearing when its log first names them (build schedule from the room service).
  let added = null;
  const real = tl.realAt(t);
  const reviewBuild = /^round\d+$/.test(tl.buildModel);
  const card = !!tl.photoItems && t >= tl.photoItems.at;
  if (tl.models[tl.buildModel] && (!model || model === 'seed')) {
    if (tl.build && real >= tl.build.base && (!reviewBuild || t >= by.assemble?.replay[0])) {
      model = tl.buildModel;
      added = new Set(tl.build.reveal.filter(r => (reviewBuild && card) || r.minute <= real).map(r => r.node));
    } else if (!tl.build && reviewBuild && card) {
      model = tl.buildModel;  // no schedule for it: the built room as it was first reviewed, from the end of the build
    }
  }
  const current = model === modelEvent?.model ? modelEvent : null;
  const photos = tl.photoItems && by.assemble && t >= by.assemble.replay[0] && !!model && !holdsPhotos(tl.photoItems, current);
  const photoShow = photos ? new Set(tl.photoItems.ids.filter(id => tl.photoItems.times.get(id) <= t)) : null;
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
    buildModel: tl.buildModel,
    photoItems: tl.photoItems,  // the source, also while it is not shown (a rewind keeps it loaded)
    // From the build the stand-ins of the photo items are hidden; each photo model shows from its own record.
    photoShow,
    hiddenNodes: added ? tl.hiddenDuringBuild : tl.hiddenNodes[model || 'seed'],
    modelEvent: current,
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
  if (fix?.kind === 'result') return {passed: false, repaired: true, text: fix.say?.includes('没有变化')
    ? '检查未通过，修改尝试结束时房间没有变化' : '检查未通过，随后完成了修改，尚无复查结论'};
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
