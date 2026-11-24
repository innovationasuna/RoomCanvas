// Reconstruction replay page: live while a job runs (polls the room service), replay afterwards.
import {buildTimeline, clock, comparisonAt, sceneAt, outcome, withoutScores, readReplay, DURATION} from './timeline.mjs';

// Playback length: set by the timeline (longer when many objects take shape).
const span = () => tl?.duration ?? DURATION;
import {Player, esc} from './player.mjs';
import {RoomView} from './room-view.mjs';
import {cards, upTo, objects, objectNames, pictureUrls, reviewPictures, lines, pictures, cropOf, isStrip, CardImages, keepReading, appendedEvents, nearEnd, cardScroll, WORK} from './log.mjs';

const $ = (id) => document.getElementById(id);
const job = new URLSearchParams(location.search).get('job') || '';
const api = `/room-reconstruction/jobs/${job}/replay`;
const files = (rel) => `${api}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
const KIND = {tool: '操作', image: '图片', result: '检查'};
const POLL = 5000;
// ms the camera stays on an object once there (it takes shape in 3 s); long enough that it goes on to the
// next object rather than backing out in between.
const WATCH = 6000;

let lastAdded = null;
let data = null, tl = null, following = true, lastIdx = -2, shownTo = -1, lastKey = '', hold = 0, posed = false;
let framing = null;  // a photo item reached in playback before anything of it could be framed: {idx, id}
// The record's cards (log.mjs), the card of each event, the last card shown, the cards a reader opened (kept
// across live updates), and whether the next update should bring the current record into view (a seek).
let deck = [], cardOf = [], shownCard = -1, reveal = false;
const open = new Set();
const cardImages = new CardImages(), names = new Map();
const player = window.player = new Player(span());
let view = null;

function fail(message) {
  $('loading').textContent = message;
  $('loading').classList.add('error');
}

// Opened without ?job=: list the reconstruction jobs to pick from.
const STATUS = {queued: '排队中', running: '重建中', preparing: '整理中', completed: '已完成', failed: '未完成'};
const connectionHint = '暂时连不上房间重建服务。请确认电脑已连接服务器，再刷新页面。';
async function replayJSON(path, missing) {
  const response = await fetch(path, {cache: 'no-store'}).catch(() => {throw new Error(connectionHint);});
  if (response.status === 401) throw new Error('房间重建服务未接受当前凭证。请联系管理员检查服务凭证后重试。');
  if (response.status === 404 && missing) throw new Error(missing);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const hint = [502, 503, 504].includes(response.status) ? connectionHint : `未能读取重建记录，请稍后重试（${response.status}）。`;
    throw new Error(data?.error || hint);
  }
  if (!data) throw new Error('无法读取重建记录，请联系管理员检查记录。');
  return data;
}
async function choose() {
  let jobs;
  try {
    const data = await replayJSON('/room-reconstruction/jobs');
    jobs = data.jobs.filter((j) => j.status !== 'queued').sort((a, b) => b.created - a.created);
  } catch (error) {
    return fail(error.message);
  }
  if (!jobs.length) return fail('暂时没有可回放的记录。可以返回房间列表开始重建，或等排队中的任务开始后再来。');
  const when = (t) => new Date(t * 1000).toLocaleString('zh-CN', {hour12: false}).slice(0, -3);
  $('loading').innerHTML = `<div class="pick"><div class="pick-title">选择要查看的重建任务</div>` + jobs.map((j) =>
    `<a href="?job=${j.id}"><b>${esc(j.name || '房间')}</b><span>${STATUS[j.status] || ''} · ${when(j.created)}</span></a>`).join('') + '</div>';
}

async function fetchData() {
  const data = readReplay(await replayJSON(api, '没有找到这条记录，请返回房间列表重新选择。'));
  data.events = data.events.map(e => pictureUrls(e, files));
  return data;
}

async function start() {
  if (!/^[0-9a-f]{32}$/.test(job)) return choose();
  try {
    data = await fetchData();
  } catch (error) {
    return fail(error.message);
  }
  document.title = `${data.name || '房间'} · 重建过程`;
  view = window.view = new RoomView($('view'), {files, scaffold: {points: `${api}/scaffold/points.bin`, layout: `${api}/scaffold/layout.json`, colors: `${api}/scaffold/colors.bin`}});
  setRate();
  rebuild(data.live);
  $('loading').remove();
  if (data.live) {
    setTimeout(poll, POLL);
  } else {
    player.play();
  }
}

async function poll() {
  view.ensureScaffold();
  try {
    const next = await fetchData();
    // Also when only a line's wording or picture changed (a batch condensed), not just when records were added.
    if (JSON.stringify(next.events) !== JSON.stringify(data.events) || next.live !== data.live || next.latest_event !== data.latest_event
        || JSON.stringify(next.models) !== JSON.stringify(data.models)
        || JSON.stringify(next.chair_clusters) !== JSON.stringify(data.chair_clusters)
        || JSON.stringify(next.hidden_nodes) !== JSON.stringify(data.hidden_nodes)) {
      // New records only pull a reader down while the replay follows the live end, not while one looks back.
      const follow = following || player.t === tl.latestAt;
      const restore = keepReading($('log'), tl.events, follow && appendedEvents(data.events, next.events));
      data = next;
      rebuild(follow);
      restore(tl.events);
    }
    $('liveError').hidden = true;
  } catch (error) {
    $('liveError').textContent = error.message;
    $('liveError').hidden = false;
  }
  if (data.live) setTimeout(poll, POLL);
}

// ---------- rebuild everything that depends on the event list ----------
let addedAll;
function rebuild(followLatest) {
  const previous = tl?.events[tl.indexAt(player.t)];
  const offset = previous ? player.t - previous.at : 0;
  tl = buildTimeline(data);
  const date = data.start && new Date(data.start * 1000).toLocaleString('zh-CN', {hour12: false}).slice(0, -3);
  $('context').innerHTML = `<b>${esc(data.name || '房间')}</b>重建过程` + (date ? ` · ${date}` : '');
  addedAll = tl.build?.reveal.map((r) => r.node);
  view.objectIds = new Set(tl.events.flatMap(e => e.show || []));
  view.chairClusters = data.chair_clusters;
  player.duration = tl.duration;
  deck = cards(tl.events);
  objectNames(tl.events, names);
  cardOf = deck.flatMap((card, c) => card.members.map(() => c));
  lastIdx = -2; lastKey = ''; framing = null;
  $('log').querySelectorAll('[data-key]').forEach((el) => cardImages.collect(el));
  cardImages.prune(deck, tl.events);
  $('log').innerHTML = `<div class="user">帮我把「${esc(data.name || '这个房间')}」的扫描重建成能在网页里编辑的 3D 房间。</div><div class="who"><i>R</i>RoomCanvas</div>`;
  shownTo = -1;
  shownCard = -1;
  if (!tl.events.length) $('log').insertAdjacentHTML('beforeend', '<p class="pending">任务排队中，开始重建后这里会实时显示过程。</p>');
  $('dots').innerHTML = data.stages.map((s, k) => `<i data-k="${k}" title="${esc(s.name)}"></i>`).join('');
  const pct = (t) => `${t / span() * 100}%`;
  $('track').innerHTML = tl.stages.map((s) => `<div class="seg" data-s="${s.id}" title="${esc(s.name)}" style="left:${pct(s.replay[0])};width:${pct(s.replay[1] - s.replay[0])}"><div class="bar"><div class="fill"></div></div></div>` +
    `<span class="lab" data-s="${s.id}" style="left:${pct(s.replay[0])}">${esc(s.name)}</span>`).join('') +
    tl.events.filter((e) => e.model || e.kind === 'review').map((e) => `<i class="mk ${e.kind === 'review' ? 'r' : 'v'}" style="left:${pct(e.at)}" title="${esc(withoutScores(e.say))}"></i>`).join('') +
    '<div class="head" id="head"></div>';
  fitLabels();
  $('live').hidden = !data.live;
  if (followLatest) player.seek(data.live ? tl.latestAt : span(), {animate: data.live});
  else {
    const record = previous?.id && tl.events.find(e => e.id === previous.id);
    const end = record && (tl.events[record.i + 1]?.at ?? span());
    player.seek(record ? Math.min(record.at + offset, end - 0.001) : player.t);
  }
}

// ---------- left: the record, newest at the bottom ----------
// Cards (log.mjs): a line with a small picture beside it; a run of objects with a picture of each; a stretch of
// the agent's work with its first and latest lines, the rest folded. A card shows only what had happened by the
// current record, so moving the playhead into a card adds or takes away its lines and pictures.
const say = (e) => esc(withoutScores(e.say));
// A picture; with a crop, only that part of it (an item on a shelf whose photo shows the whole shelf), zoomed to fill.
function image(src, crop) {
  if (!crop) return `<img data-file="${esc(src)}" alt="" loading="lazy">`;
  const [x0, y0, x1, y1] = crop, w = x1 - x0, h = y1 - y0, pct = (v) => `${(v * 100).toFixed(2)}%`;
  return `<span class="cut"><img data-file="${esc(src)}" alt="" loading="lazy" style="width:${pct(1 / w)};height:${pct(1 / h)};left:${pct(-x0 / w)};top:${pct(-y0 / h)}"></span>`;
}
const pic = (k, src, crop) => `<span class="th" data-z="${k}" data-src="${esc(src)}">${image(src, crop)}</span>`;
function line(k, n = 1) {
  const e = tl.events[k], talk = ['think', 'milestone', 'review'].includes(e.kind);
  return `<p class="line${e.kind === 'milestone' ? ' ms' : e.kind === 'review' ? ' rv' : ''}" data-i="${k}">` +
    (talk ? '' : `<span class="k">${KIND[e.kind] || '操作'}</span>`) + say(e) + (n > 1 ? `<span class="times">×${n}</span>` : '') + '</p>';
}
const fold = (text) => `<button type="button" class="fold" data-more>${text}</button>`;
function single(ks) {
  const k = ks.at(-1), e = tl.events[k];
  // A check's verdict keeps its photo / model pair whole, low and wide under the words.
  const src = !cardImages.strips.has(e.img) && e.img;
  if (e.kind === 'review') {
    const shots = reviewPictures(e).filter(url => !cardImages.strips.has(url));
    return line(k) + (shots.length ? '<div class="review-pics">' + shots.map(url =>
      `<span class="wide" data-z="${k}" data-src="${esc(url)}">${image(url)}</span>`).join('') + '</div>' : '');
  }
  return `<div class="row">${line(k, ks.length)}${src ? pic(k, src, cropOf(e)) : ''}</div>`;
}
function objectCard(ks) {
  const items = objects(tl.events, ks, names), shown = items.filter((o) => o.img), bare = items.filter((o) => !o.img);
  const cells = shown.map((o) => `<span class="cell" data-z="${o.k}" data-src="${esc(o.img)}" data-i="${o.k}">` +
    `${image(o.img, o.crop)}<span class="nm" title="${esc(o.label)}">${esc(o.label)}</span></span>`).join('');
  return `<div class="card objects"><p class="line lead" data-i="${ks.at(-1)}">${WORK[tl.events[ks[0]].work].replace('{n}', items.length)}</p>` +
    (cells ? `<div class="grid">${cells}</div>` : '') + (bare.length ? `<p class="bare">${bare.map(o => esc(o.label)).join('、')}</p>` : '') + '</div>';
}
function workCard(ks, opened) {
  const all = lines(tl.events, ks), shots = pictures(tl.events, ks, 2, (src) => !cardImages.strips.has(src));
  const text = opened || all.length <= 2 ? all.map((l) => line(l.k, l.n)).join('') + (all.length > 2 ? fold('收起') : '')
    : line(all[0].k, all[0].n) + fold(`… 另有 ${all.length - 2} 条`) + line(all.at(-1).k, all.at(-1).n);
  return `<div class="card work"><div class="text">${text}</div>` +
    (shots.length ? `<div class="pics n${shots.length}">${shots.map((p) => pic(p.k, p.src)).join('')}</div>` : '') + '</div>';
}
function draw(c, idx) {
  const card = deck[c], ks = upTo(card, idx), stage = card.stage !== deck[c - 1]?.stage;
  const opened = open.has(card.key);
  const body = card.type === 'objects' ? objectCard(ks)
    : ks.length > 1 && card.type === 'work' ? workCard(ks, opened) : single(ks);
  const holder = document.createElement('div');
  holder.innerHTML = `<div data-c="${c}" data-key="${esc(card.key)}">` +
    (stage ? `<div class="stage-h">${esc(data.stages.find((s) => s.id === card.stage)?.name)}</div>` : '') + body + '</div>';
  const old = $('log').querySelector(`[data-c="${c}"]`), fresh = holder.firstChild;
  if (old) cardImages.collect(old);
  fresh.querySelectorAll('img').forEach((img) => cardImages.attach(card.key, img, filterStrip));
  if (old) old.replaceWith(fresh);
  else $('log').append(fresh);
}
function renderLog(idx) {
  const follow = nearEnd($('log')), grew = idx > shownTo;
  const last = idx < 0 ? -1 : cardOf[idx];
  for (let c = shownCard; c > last; c--) {
    const el = $('log').querySelector(`[data-c="${c}"]`);
    if (!el) continue;
    cardImages.collect(el);
    el.remove();
  }
  // The card shown last may have gained or lost lines; the ones after it are new.
  for (let c = Math.max(0, Math.min(shownCard, last)); c <= last; c++) draw(c, idx);
  shownCard = last;
  shownTo = idx;
  mark(idx);
  if (!reveal && grew && follow) $('log').scrollTop = $('log').scrollHeight;
}
function revealCard() {
  const log = $('log'), card = log.querySelector(`[data-c="${shownCard}"]`);
  if (!card) return;
  const box = log.getBoundingClientRect(), r = card.getBoundingClientRect();
  const active = card.querySelector('.cell.now') || card.querySelector('.now:not(.lead)');
  const first = card.querySelector('.lead, .work .text > .line');
  const heading = first && getComputedStyle(first).position === 'sticky' ? first : null;
  const row = active && active !== heading ? active.getBoundingClientRect() : {top: r.top, bottom: r.top};
  log.scrollTop += cardScroll(r.top - box.top, r.bottom - box.top,
    {top: row.top - box.top, bottom: row.bottom - box.top}, log.clientHeight, heading?.getBoundingClientRect().height || 0);
}
function mark(idx) {
  $('log').querySelectorAll('.now').forEach((el) => el.classList.remove('now'));
  $('log').querySelectorAll(`[data-i="${idx}"]`).forEach((el) => el.classList.add('now'));
}
function zoom(k, src) {
  const e = tl.events[k];
  // A rebuilt small object: once the room was rendered with it, the photo beside the rebuilt model.
  const later = comparisonAt(e, tl, player.t);
  player.pause();
  $('lb').innerHTML = `<div><img src="${esc(later?.src || src || e.img)}" alt=""><div class="cap">${say(e)}</div></div>`;
  $('lb').classList.add('on');
}
$('log').addEventListener('click', (ev) => {
  const more = ev.target.closest('[data-more]');
  if (more) {
    const c = +more.closest('[data-c]').dataset.c, key = deck[c].key;
    open.has(key) ? open.delete(key) : open.add(key);
    draw(c, shownTo);
    mark(shownTo);
    return;
  }
  const z = ev.target.closest('[data-z]');
  if (z) return zoom(+z.dataset.z, z.dataset.src);
  const c = ev.target.closest('[data-i]');
  if (c) seekTo(tl.events[+c.dataset.i].at + 0.01);
});
$('lb').onclick = () => $('lb').classList.remove('on');
$('dots').onclick = (ev) => {
  const d = ev.target.closest('[data-k]');
  const s = d && tl.stages.find((x) => x.id === data.stages[+d.dataset.k].id);
  if (s) seekTo(s.replay[0] + 0.01);
};

// ---------- timeline ----------
function seekTo(t) {
  following = data.live && Math.abs(t - tl.latestAt) < 0.01;
  reveal = true;  // the record moved to is brought into view (seek renders at once)
  player.seek(t, {pause: true});
  revealCard();
  reveal = false;
}
function fitLabels() {
  const width = $('track').clientWidth;
  $('track').querySelectorAll('.lab').forEach((el) => {
    const st = tl.stages.find((x) => x.id === el.dataset.s);
    el.classList.toggle('tight', el.scrollWidth + 6 > width * (st.replay[1] - st.replay[0]) / span());
    el.classList.toggle('end', st.replay[0] / span() * width + el.scrollWidth > width);
    el.style.left = `${(el.classList.contains('end') ? st.replay[1] : st.replay[0]) / span() * 100}%`;
  });
}
// The current stage's name always shows; names it would cover are hidden instead of half-covered.
function hideCovered() {
  const labs = [...$('track').querySelectorAll('.lab')], now = labs.find((el) => el.classList.contains('now'));
  labs.forEach((el) => el.classList.remove('covered'));
  if (!now) return;
  const r = now.getBoundingClientRect();
  for (const el of labs) {
    if (el === now) continue;
    const q = el.getBoundingClientRect();
    if (q.left < r.right + 8 && q.right > r.left - 8) el.classList.add('covered');
  }
}
new ResizeObserver(() => {if (tl) {fitLabels(); hideCovered();}}).observe($('track'));
$('track').addEventListener('pointerdown', (ev) => {
  const seek = (x) => {const r = $('track').getBoundingClientRect(); seekTo((x - r.left) / r.width * span());};
  seek(ev.clientX);
  const move = (m) => seek(m.clientX);
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => removeEventListener('pointermove', move), {once: true});
});
const step = (d) => {
  if (!tl?.events.length) return;
  const i = tl.indexAt(player.t);
  seekTo(tl.events[Math.min(Math.max(i + d, 0), tl.events.length - 1)].at + 0.01);
};
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('play').onclick = () => {following = false; player.toggle();};
$('latest').onclick = () => seekTo(tl.latestAt);
// Playback speed. The view decides the speed of the moment: sped up, it still plays what is worth watching
// (the camera moving in, an object taking shape) at normal speed, and render() passes that on to the clock.
function setRate() {
  player.rate = +$('speed').value;
  if (view) view.speed = player.rate;
}
// Back to the page afterwards, so Space and the arrows keep driving the replay rather than the list.
$('speed').onchange = () => {setRate(); $('speed').blur();};
addEventListener('keyup', (ev) => {if (ev.code === 'Space') ev.preventDefault();});
addEventListener('keydown', (ev) => {
  if (ev.code === 'Space') {ev.preventDefault(); if (!ev.repeat) {following = false; player.toggle();}}
  if (ev.code === 'ArrowLeft') step(-1);
  if (ev.code === 'ArrowRight') step(1);
  if (ev.code === 'Escape') $('lb').classList.remove('on');
});

// ---------- camera: slow spin while playing; turn to what was just built; layout from above ----------
function directCamera(t, p) {
  const end = t >= span();
  // Paused, the view holds still; at the end the finished room keeps its slow turn.
  view.setPlaying(p.playing, end && !data.live);
  if (!p.playing) {hold = 0; posed = false; return;}
  const inLayout = !end && tl.stageAt(t)?.id === 'layout';
  if (inLayout && !posed) {view.pose(0.75, 0.6); posed = true; hold = 0;}
  if (!inLayout && posed) {view.pose(null, view.defaultPolar); posed = false; hold = 1;}
  if (hold && view.settledFor() > hold) {view.clearAim(); hold = 0;}
}

player.on(render);
function render(t, p, animate = p.playing) {
  if (!tl || !view) return;
  p.rate = view.rate;
  directCamera(t, p);
  if ($('play').dataset.on !== String(p.playing)) {
    $('play').dataset.on = p.playing;
    $('play').innerHTML = `<svg><use href="#i-${p.playing ? 'pause' : 'play'}"/></svg>`;
  }
  const atEnd = t >= span() - 0.01, done = atEnd && !data.live;
  // The room is finished: light it as the room preview does (物理光照).
  view.physical(done);
  $('head') && ($('head').style.left = `${t / span() * 100}%`);
  const projected = data.presentation === 'by_stage';
  $('clock').textContent = projected ? '回放 ' + clock(t / 60) : clock(tl.workAt(tl.realAt(t)));
  $('total').textContent = '/ ' + clock(projected ? span() / 60 : tl.workAt(tl.realAt(span())));
  $('latest').hidden = !data.live || following || t === tl.latestAt;
  const st = tl.stageAt(t), si = st ? data.stages.findIndex((s) => s.id === st.id) : -1;
  tl.stages.forEach((s) => {
    const f = atEnd || s.replay[1] <= t ? 1 : s === st ? (t - s.replay[0]) / (s.replay[1] - s.replay[0]) : 0;
    const fill = $('track').querySelector(`.seg[data-s="${s.id}"] .fill`);
    if (fill) fill.style.width = `${Math.min(f, 1) * 100}%`;
  });
  const result = done ? outcome(tl.events) : null;
  const key = `${si}-${done}-${data.status}`;
  if (key !== lastKey) {
    lastKey = key;
    $('track').querySelectorAll('.lab').forEach((el) => el.classList.toggle('now', !done && el.dataset.s === st?.id));
    hideCovered();
    [...$('dots').children].forEach((el, k) => {
      el.className = done ? (result && !result.passed && k === si ? 'fail' : k <= si ? 'done' : '') : k < si ? 'done' : k === si ? 'now' : '';
    });
    // A job that stopped after an acceptance review ends with that verdict, not as a crash.
    const failed = data.status === 'failed' && done && !result;
    $('planN').textContent = data.live ? `进行中 · 第 ${si + 1} 步 / 共 ${data.stages.length} 步` : done ? '重建结束' : `第 ${si + 1} 步 / 共 ${data.stages.length} 步`;
    $('planName').textContent = failed ? '重建还没完成' : result ? (result.repaired ? '修改流程结束' : result.passed ? '检查通过' : '没有通过检查') : st?.name || '等待开始';
    $('planName').classList.toggle('fail', !!(result && !result.passed));
    $('planDesc').textContent = failed ? '这次停在了中途，在任务列表里点“重试”，会接着已做好的部分继续。' : result ? result.text : st?.desc || '';
    $('result').innerHTML = result ? `<span class="tag ${result.passed ? 'ok' : 'warn'}">${result.repaired ? '修改流程结束' : result.passed ? '检查通过' : '没通过检查'}</span>` : '';
  }
  const scene = sceneAt(tl, t);
  view.apply(scene, {quiet: !animate, modelUrl: (k) => data.models[k] && files(data.models[k]), addedAll});
  // Turn to the parts the agent just added (while playing forward).
  const newly = scene.added && lastAdded ? [...scene.added].filter((n) => !lastAdded.has(n) && !/^Ceiling/i.test(n)) : [];
  lastAdded = scene.added;
  if (p.playing && newly.length && view.aim(newly, {close: true})) hold = WATCH;
  const idx = tl.indexAt(t);
  // Its model has arrived while its record still plays: move in on it now. A drag or the next record drops it.
  if (framing && (!p.playing || idx !== framing.idx)) framing = null;
  if (framing && !view.boundsOf(framing.id).isEmpty()) {
    if (view.aim([framing.id], {close: true})) hold = WATCH;
    framing = null;
  }
  if (idx === lastIdx) return;
  const prevIdx = lastIdx;
  lastIdx = idx;
  const e = tl.events[idx];
  // Once the room shell shows, a finished object takes shape in place: move in close to watch it (not to
  // one made again, which is already there and passes in a moment).
  if (p.playing && idx === prevIdx + 1 && e?.show && (e.forms || !scene.shell) && view.aim(e.show.filter((k) => k !== '@boxes'), {close: scene.shell})) hold = scene.shell ? WATCH : 2000;
  // A photo item appears at its own record: move in on it, one after another.
  if (p.playing && idx === prevIdx + 1 && e?.work === 'small' && scene.photoShow?.has(e.object_id)) {
    if (view.boundsOf(e.object_id).isEmpty()) framing = {idx, id: e.object_id};
    else if (view.aim([e.object_id], {close: true})) hold = WATCH;
  }
  renderLog(idx);
}

// A picture squeezed into a thin strip (a narrow wall's stitch or mask) shows as a dark bar: leave it out.
function filterStrip(event) {
  const img = event.target;
  if (!isStrip(img.naturalWidth, img.naturalHeight)) return;
  if (!cardImages.strips.has(img.dataset.file)) {
    cardImages.strips.add(img.dataset.file);
    cardImages.prune(deck, tl.events);
  }
  const holder = img.closest('.th, .wide');
  if (holder?.isConnected) {
    const restore = keepReading($('log'), tl.events);
    draw(+holder.closest('[data-c]').dataset.c, shownTo);
    mark(shownTo);
    restore();
  }
}

start();
