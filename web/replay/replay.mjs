// Reconstruction replay page: live while a job runs (polls the room service), replay afterwards.
import {buildTimeline, clock, sceneAt, outcome, DURATION} from './timeline.mjs';

// Playback length: set by the timeline (longer when many objects take shape).
const span = () => tl?.duration ?? DURATION;
import {Player, esc} from './player.mjs';
import {RoomView} from './room-view.mjs';

const $ = (id) => document.getElementById(id);
const job = new URLSearchParams(location.search).get('job') || '';
const api = `/room-reconstruction/jobs/${job}/replay`;
const files = (rel) => `${api}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
const KIND = {tool: '操作', image: '图片', result: '检查', error: '出错'};
const POLL = 5000;
const WATCH = 3400;  // ms the camera stays on an object once there: it takes shape in 3 s

let lastAdded = null;
let data = null, tl = null, following = true, lastIdx = -2, shownTo = -1, lastKey = '', hold = 0, wasPlaying = false, posed = false;
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
  return response.json();
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
  rebuild();
  $('loading').remove();
  if (data.live) {
    player.seek(span());
    setTimeout(poll, POLL);
  } else {
    player.play();
  }
}

async function poll() {
  view.ensureScaffold();
  try {
    const next = await fetchData();
    if (next.events.length !== data.events.length || next.live !== data.live || JSON.stringify(next.models) !== JSON.stringify(data.models)) {
      const wasEnd = player.t >= span() - 0.01;
      data = next;
      rebuild();
      if (following || wasEnd) player.seek(span());
    }
    $('liveError').hidden = true;
  } catch {
    $('liveError').hidden = false;
  }
  if (data.live) setTimeout(poll, POLL);
  else render(player.t, player, true);
}

// ---------- rebuild everything that depends on the event list ----------
// Door / window ids in build order, so Wall0_Door_0 maps to the assembled room's Door0 and so on.
let openings = {};
function rebuild() {
  tl = buildTimeline(data);
  player.duration = tl.duration;
  openings = {Door: [], Window: []};
  for (const e of tl.events) for (const id of e.show || []) {
    const m = id.match(/_(Door|Window)_\d+$/);
    if (m && !openings[m[1]].includes(id)) openings[m[1]].push(id);
  }
  Object.values(openings).forEach((list) => list.sort());
  lastIdx = -2; lastKey = '';
  $('log').innerHTML = `<div class="user">帮我把「${esc(data.name || '这个房间')}」的扫描重建成能在网页里编辑的 3D 房间。</div><div class="who"><i>R</i>RoomCanvas</div>`;
  shownTo = -1;
  if (!tl.events.length) $('log').insertAdjacentHTML('beforeend', '<p class="pending">任务排队中，开始重建后这里会实时显示过程。</p>');
  $('dots').innerHTML = data.stages.map((s, k) => `<i data-k="${k}" title="${esc(s.name)}"></i>`).join('');
  const pct = (t) => `${t / span() * 100}%`;
  $('track').innerHTML = tl.stages.map((s) => `<div class="seg" data-s="${s.id}" title="${esc(s.name)}" style="left:${pct(s.replay[0])};width:calc(${pct(s.replay[1] - s.replay[0])} - 3px)"><div class="fill"></div></div>` +
    `<span class="lab" data-s="${s.id}" style="left:${pct(s.replay[0])}">${esc(s.name)}</span>`).join('') +
    tl.events.filter((e) => e.model || e.kind === 'review').map((e) => `<i class="mk ${e.kind === 'review' ? 'r' : 'v'}" style="left:${pct(e.at)}" title="${esc(e.say)}"></i>`).join('') +
    '<div class="head" id="head"></div>';
  fitLabels();
  $('live').hidden = !data.live;
  render(player.t, player, true);
}

// ---------- left: the record, newest at the bottom ----------
const talk = (e) => `<p class="say ${e.kind === 'milestone' ? 'ms' : e.kind === 'review' ? 'rv' : ''}" data-i="${e.i}">${esc(e.say)}</p>`;
const chip = (e) => `<div class="chip ${e.kind === 'error' ? 'err' : ''}" data-i="${e.i}"><span class="app">${KIND[e.kind] || '操作'}</span><span>${esc(e.say)}</span></div>`;
const shot = (e) => e.img ? `<div class="shot" data-z="${e.i}"><img src="${files(e.img)}" alt="" loading="lazy"></div>` : '';
function renderLog(idx) {
  if (idx < shownTo) {
    $('log').querySelectorAll('[data-e]').forEach((el) => +el.dataset.e > idx && el.remove());
    shownTo = idx;
  }
  for (let i = shownTo + 1; i <= idx; i++) {
    const e = tl.events[i], prev = tl.events[i - 1];
    const head = !prev || prev.stage !== e.stage ? `<div class="stage-h">${esc(data.stages.find((s) => s.id === e.stage)?.name)}</div>` : '';
    const body = ['think', 'milestone', 'review'].includes(e.kind) ? talk(e) : chip(e);
    $('log').insertAdjacentHTML('beforeend', `<div data-e="${i}">${head}${body}${shot(e)}</div>`);
  }
  const grew = idx > shownTo;
  shownTo = idx;
  $('log').querySelectorAll('.now').forEach((el) => el.classList.remove('now'));
  $('log').querySelector(`[data-i="${idx}"]`)?.classList.add('now');
  if (grew) $('log').scrollTop = 1e9;
}
$('log').addEventListener('click', (ev) => {
  const z = ev.target.closest('[data-z]');
  if (z) {
    const e = tl.events[+z.dataset.z];
    player.pause();
    $('lb').innerHTML = `<div><img src="${files(e.img)}" alt=""><div class="cap">${esc(e.say)}</div></div>`;
    $('lb').classList.add('on');
    return;
  }
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
  player.seek(t);
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
addEventListener('keyup', (ev) => {if (ev.code === 'Space') ev.preventDefault();});
addEventListener('keydown', (ev) => {
  if (ev.code === 'Space') {ev.preventDefault(); if (!ev.repeat) {following = false; player.toggle();}}
  if (ev.code === 'ArrowLeft') step(-1);
  if (ev.code === 'ArrowRight') step(1);
  if (ev.code === 'Escape') $('lb').classList.remove('on');
});

// ---------- camera: slow spin while playing; turn to what was just built; layout from above ----------
function directCamera(t, p) {
  if (p.playing && !wasPlaying) view.release();
  wasPlaying = p.playing;
  const end = t >= span();
  const inLayout = !end && tl.stageAt(t)?.id === 'layout';
  if (inLayout && !posed) {view.pose(0.75, 0.6); posed = true; hold = 0;}
  if (!inLayout && posed) {view.pose(null, view.defaultPolar); posed = false; hold = 1;}
  if (hold && view.settledFor() > hold) {view.clearAim(); hold = 0;}
  view.spin(p.playing || end);
}

player.on((t, p) => render(t, p));
function render(t, p, force = false) {
  if (!tl || !view) return;
  directCamera(t, p);
  if ($('play').dataset.on !== String(p.playing)) {
    $('play').dataset.on = p.playing;
    $('play').innerHTML = `<svg><use href="#i-${p.playing ? 'pause' : 'play'}"/></svg>`;
  }
  const atEnd = t >= span() - 0.01, done = atEnd && !data.live;
  // The room is finished: light it as the room preview does (物理光照).
  view.physical(done);
  $('head') && ($('head').style.left = `${t / span() * 100}%`);
  $('clock').textContent = clock(tl.realAt(t));
  $('total').textContent = '/ ' + clock(tl.events.at(-1)?.minute || 0);
  $('latest').hidden = !data.live || following || atEnd;
  const st = tl.stageAt(t), si = st ? data.stages.findIndex((s) => s.id === st.id) : -1;
  tl.stages.forEach((s) => {
    const f = atEnd || s.replay[1] <= t ? 1 : s === st ? (t - s.replay[0]) / (s.replay[1] - s.replay[0]) : 0;
    const fill = $('track').querySelector(`.seg[data-s="${s.id}"] .fill`);
    if (fill) fill.style.width = `${Math.min(f, 1) * 100}%`;
  });
  const result = done ? outcome(tl.events) : null;
  const key = `${si}-${done}-${data.status}`;
  if (key !== lastKey || force) {
    lastKey = key;
    $('track').querySelectorAll('.lab').forEach((el) => el.classList.toggle('now', !done && el.dataset.s === st?.id));
    hideCovered();
    [...$('dots').children].forEach((el, k) => {
      el.className = done ? (result && !result.passed && k === si ? 'fail' : k <= si ? 'done' : '') : k < si ? 'done' : k === si ? 'now' : '';
    });
    // A job that stopped after an acceptance review ends with that verdict, not as a crash.
    const failed = data.status === 'failed' && done && !result;
    $('planN').textContent = data.live ? `进行中 · 第 ${si + 1} 步 / 共 ${data.stages.length} 步` : done ? '重建结束' : `第 ${si + 1} 步 / 共 ${data.stages.length} 步`;
    $('planName').textContent = failed ? '重建中途出错' : result ? (result.passed ? '验收通过' : '没有通过最后检查') : st?.name || '等待开始';
    $('planName').classList.toggle('fail', failed || (result && !result.passed));
    $('planDesc').textContent = failed ? '服务器上的重建没有完成，可以在任务列表里重试。' : result ? result.text : st?.desc || '';
    $('result').innerHTML = result ? `<span class="tag ${result.passed ? 'ok' : 'warn'}">${result.passed ? '验收通过' : '没通过最后检查 · 没有发布'}</span>` : '';
  }
  const scene = sceneAt(tl, t);
  const addedAll = tl.build?.reveal.map((r) => r.node);
  view.apply(scene, {quiet: !p.playing && !following, modelUrl: (k) => data.models[k] && files(data.models[k]), openings, addedAll});
  // Turn to the parts the agent just added (while playing forward).
  const newly = scene.added && lastAdded ? [...scene.added].filter((n) => !lastAdded.has(n) && !/^Ceiling/i.test(n)) : [];
  lastAdded = scene.added;
  if (p.playing && newly.length && view.aim(newly, {close: true})) hold = WATCH;
  const idx = tl.indexAt(t);
  if (idx === lastIdx && !force) return;
  const prevIdx = lastIdx;
  lastIdx = idx;
  const e = tl.events[idx];
  // Once the room shell shows, a finished object takes shape in place: move in close to watch it.
  if (idx === prevIdx + 1 && e?.show && view.aim(e.show.filter((k) => k !== '@boxes'), {close: scene.shell})) hold = scene.shell ? WATCH : 2000;
  renderLog(idx);
}

start();
