// Reconstruction replay page: live while a job runs (polls the room service), replay afterwards.
import {buildTimeline, clock, sceneAt, outcome, withoutScores, withoutErrors, DURATION} from './timeline.mjs';

// Playback length: set by the timeline (longer when many objects take shape).
const span = () => tl?.duration ?? DURATION;
import {Player, esc} from './player.mjs';
import {RoomView} from './room-view.mjs';
import {cards, upTo, objects, objectNames, pictureUrls, lines, pictures, cropOf, isStrip, CardImages, keepReading, nearEnd, cardScroll, WORK} from './log.mjs';

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
async function choose() {
  let jobs;
  try {
    const response = await fetch('/room-reconstruction/jobs', {cache: 'no-store'});
    if (!response.ok) throw new Error();
    jobs = (await response.json()).jobs.filter((j) => j.status !== 'queued').sort((a, b) => b.created - a.created);
  } catch {
    return fail('房间重建服务未连接');
  }
  if (!jobs.length) return fail('还没有重建任务');
  const when = (t) => new Date(t * 1000).toLocaleString('zh-CN', {hour12: false}).slice(0, -3);
  $('loading').innerHTML = `<div class="pick"><div class="pick-title">选择要查看的重建任务</div>` + jobs.map((j) =>
    `<a href="?job=${j.id}"><b>${esc(j.name || '房间')}</b><span>${STATUS[j.status] || ''} · ${when(j.created)}</span></a>`).join('') + '</div>';
}

async function fetchData() {
  const response = await fetch(api, {cache: 'no-store'});
  if (!response.ok) throw new Error(response.status === 404 ? '没有找到这个重建任务' : '房间重建服务未连接');
  const data = await response.json();
  data.events = withoutErrors(data.events || []).map((e) => pictureUrls(e, files));
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
  $('context').innerHTML = `<b>${esc(data.name || '房间')}</b>重建过程` + (data.start ? ` · ${new Date(data.start * 1000).toLocaleString('zh-CN', {hour12: false}).slice(0, -3)}` : '');
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
    if (JSON.stringify(next.events) !== JSON.stringify(data.events) || next.live !== data.live || JSON.stringify(next.models) !== JSON.stringify(data.models)) {
      const wasEnd = player.t >= span() - 0.01, restore = keepReading($('log'), tl.events, next.events.length > data.events.length);
      data = next;
      rebuild(following || wasEnd);
      restore(tl.events);
    }
    $('liveError').hidden = true;
  } catch {
    $('liveError').hidden = false;
  }
  if (data.live) setTimeout(poll, POLL);
}

// ---------- rebuild everything that depends on the event list ----------
// Door / window ids in build order, so Wall0_Door_0 maps to the assembled room's Door0 and so on.
let openings = {};
function rebuild(followLatest) {
  // Older services named the checks 验收 and scored them: show them as checks, without scores.
  data.stages = data.stages.map((s) => ({...s, name: withoutScores(s.name),
    desc: s.id === 'revise' && s.desc === '房间发布后收到修改意见，建模 agent 回到这间房间逐条改进，再检查、发布一次。'
      ? '对照修改意见逐项调整房间，并检查修改效果。' : withoutScores(s.desc)}));
  tl = buildTimeline(data);
  player.duration = tl.duration;
  deck = cards(tl.events);
  objectNames(tl.events, names);
  cardOf = deck.flatMap((card, c) => card.members.map(() => c));
  openings = {Door: [], Window: []};
  for (const e of tl.events) for (const id of e.show || []) {
    const m = id.match(/_(Door|Window)_\d+$/);
    if (m && !openings[m[1]].includes(id)) openings[m[1]].push(id);
  }
  Object.values(openings).forEach((list) => list.sort());
  lastIdx = -2; lastKey = '';
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
  if (followLatest) player.seek(span(), {animate: data.live});
  else render(player.t, player, true);
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
  if (e.kind === 'review') return line(k) + (src ? `<span class="wide" data-z="${k}" data-src="${esc(src)}">${image(src)}</span>` : '');
  return `<div class="row">${line(k, ks.length)}${src ? pic(k, src, cropOf(e)) : ''}</div>`;
}
// Names without a picture, each once with how many: 椅子 ×3、门.
function named(items) {
  const count = new Map();
  items.forEach((o) => count.set(o.name, (count.get(o.name) || 0) + 1));
  return [...count].map(([name, n]) => esc(name) + (n > 1 ? ` ×${n}` : '')).join('、');
}
function objectCard(ks, opened) {
  const items = objects(tl.events, ks, names), shown = items.filter((o) => o.img), bare = items.filter((o) => !o.img);
  // Two rows of three at most; the last place says how many more until opened.
  const fits = opened || shown.length <= 6 ? shown.length : 5;
  const cells = shown.slice(0, fits).map((o) => `<span class="cell" data-z="${o.k}" data-src="${esc(o.img)}" data-i="${o.k}">` +
    `${image(o.img, o.crop)}<span class="nm" title="${esc(o.label)}">${esc(o.label)}</span></span>`).join('') +
    (fits < shown.length ? `<button type="button" class="cell more" data-more>+${shown.length - fits}</button>` : '');
  return `<div class="card objects"><p class="line lead" data-i="${ks.at(-1)}">${WORK[tl.events[ks[0]].work].replace('{n}', items.length)}</p>` +
    (cells ? `<div class="grid">${cells}</div>` : '') + (bare.length ? `<p class="bare">另有 ${named(bare)}</p>` : '') +
    (opened ? `<div class="detail">${lines(tl.events, ks).map((l) => line(l.k, l.n)).join('')}</div>` : '') +
    fold(opened ? '收起' : `展开 ${ks.length} 条记录`) + '</div>';
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
  const body = ks.length > 1 && card.type === 'objects' ? objectCard(ks, opened)
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
  const active = card.querySelector('.detail .now') || card.querySelector('.cell.now') || card.querySelector('.now:not(.lead)');
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
  const later = (e.media || []).findLast((m) => m.role === 'comparison' && m.minute <= tl.realAt(player.t));
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
  player.pause();
  reveal = true;  // the record moved to is brought into view (seek renders at once)
  player.seek(t);
  revealCard();
  reveal = false;
  following = t >= span() - 0.01;
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
$('latest').onclick = () => seekTo(span());
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
  $('clock').textContent = clock(tl.workAt(tl.realAt(t)));
  $('total').textContent = '/ ' + clock(tl.workAt(tl.events.at(-1)?.minute || 0));
  $('latest').hidden = !data.live || following || atEnd;
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
    $('planName').textContent = failed ? '重建还没完成' : result ? (result.repaired ? '已修复' : result.passed ? '检查通过' : '没有通过检查') : st?.name || '等待开始';
    $('planName').classList.toggle('fail', !!(result && !result.passed));
    $('planDesc').textContent = failed ? '这次停在了中途，在任务列表里点“重试”，会接着已做好的部分继续。' : result ? result.text : st?.desc || '';
    $('result').innerHTML = result ? `<span class="tag ${result.passed ? 'ok' : 'warn'}">${result.repaired ? '已修复' : result.passed ? '检查通过' : '没通过检查 · 没有发布'}</span>` : '';
  }
  const scene = sceneAt(tl, t);
  const addedAll = tl.build?.reveal.map((r) => r.node);
  view.apply(scene, {quiet: !animate, modelUrl: (k) => data.models[k] && files(data.models[k]), openings, addedAll});
  // Turn to the parts the agent just added (while playing forward).
  const newly = scene.added && lastAdded ? [...scene.added].filter((n) => !lastAdded.has(n) && !/^Ceiling/i.test(n)) : [];
  lastAdded = scene.added;
  if (p.playing && newly.length && view.aim(newly, {close: true})) hold = WATCH;
  const idx = tl.indexAt(t);
  if (idx === lastIdx) return;
  const prevIdx = lastIdx;
  lastIdx = idx;
  const e = tl.events[idx];
  // Once the room shell shows, a finished object takes shape in place: move in close to watch it (not to
  // one made again, which is already there and passes in a moment).
  if (p.playing && idx === prevIdx + 1 && e?.show && (e.forms || !scene.shell) && view.aim(e.show.filter((k) => k !== '@boxes'), {close: scene.shell})) hold = scene.shell ? WATCH : 2000;
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
