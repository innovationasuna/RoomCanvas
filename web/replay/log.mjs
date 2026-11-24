// The replay's record (left column): events gathered into cards, each reading as one thing. Only the column
// gathers them; the events, their times and the 3D view still go one by one, and a card shows only what had
// happened by the moment played (dragged into a card, its count and pictures are those up to there).
//   objects  the same work done to several objects in a row (clear pictures, models, shape checks, rebuilt
//            small objects): one line with how many, and a picture of each with its name;
//   work     a stretch of the modelling agent's own work in one session (at most GROUP_MAX lines, none more
//            than GROUP_MINUTES after the one before): its first and latest lines and one or two pictures it
//            looked at, the rest folded;
//   same     anything else, alone, or said again in a row: once, with how many times.
// A stage, a restart, a check's verdict or any other record ends a card.
export const GROUP_MAX = 6;
export const GROUP_MINUTES = 3;
export const WORK = {image: '已生成 {n} 件物品的清晰图', model: '已做好 {n} 件物品的模型', shape: '已检查 {n} 件物品的形状',
                     small: '已准备 {n} 件小物品的照片模型'};

const agent = (e) => typeof e.session === 'string';
const type = (e) => (e.work && e.object_id ? 'objects' : agent(e) ? 'work' : 'same');

// [{key, stage, type, members: [event index, ...]}], each card's members consecutive.
export function cards(events) {
  const out = [];
  events.forEach((e, k) => {
    const card = out.at(-1), first = card && events[card.members[0]], last = card && events[card.members.at(-1)];
    const joins = card && first.stage === e.stage && card.type === type(e) && (
      card.type === 'objects' ? e.work === first.work :
      card.type === 'work' ? e.session === first.session && card.members.length < GROUP_MAX && e.minute - last.minute <= GROUP_MINUTES :
      e.say === last.say && e.kind === last.kind && !e.img && !last.img && !e.model);
    if (joins) card.members.push(k);
    else out.push({key: String(e.id ?? k), stage: e.stage, type: type(e), members: [k]});
  });
  return out;
}

// The members of a card that had happened by event index idx.
export const upTo = (card, idx) => card.members.filter((k) => k <= idx);

// Assign numbers once per job, including objects seen before a live timeline was revised.
export function objectNames(events, names = new Map()) {
  for (const e of events) {
    if (!e.object_id || !e.work) continue;
    const name = e.object_name || '';
    if (!names.has(name)) names.set(name, new Map());
    const ids = names.get(name);
    if (!ids.has(e.object_id)) ids.set(e.object_id, ids.size + 1);
  }
  return names;
}

// One entry per object, in the order they first came: its latest event (k) and picture (with the part of it
// showing the object, crop, when the picture shows much more).
export function objects(events, members, names = objectNames(events)) {
  const by = new Map();
  for (const k of members) {
    const e = events[k], prev = by.get(e.object_id);
    const name = e.object_name || '', ids = names.get(name);
    const label = ids?.size > 1 ? `${name} ${ids.get(e.object_id)}` : name;
    by.set(e.object_id, {id: e.object_id, name, label, k, img: e.img || prev?.img || null,
      crop: e.img ? cropOf(e) : prev?.crop || null});
  }
  return [...by.values()];
}

// Resolve a picture once so thumbnails, zoom and the strip filter all use the same revision.
export function pictureUrls(event, files) {
  const url = (src, version) => files(src) + (version == null ? '' : `?v=${encodeURIComponent(version)}`);
  const media = event.media?.map((m) => ({...m, src: url(m.src, m.version)}));
  const i = event.media?.findIndex((m) => m.src === event.img) ?? -1;
  return {...event, img: i >= 0 ? media[i].src : event.img && url(event.img, event.img_version), media};
}

// Older review events carry only their first image.
export function reviewPictures(event) {
  const shots = event.media?.filter(m => m.role === 'review').map(m => m.src) || [];
  return shots.length ? shots : event.img ? [event.img] : [];
}

// The part of an event's picture that shows its object ([left, top, right, bottom], fractions), if given.
export const cropOf = (e) => (e.media || []).find((m) => m.src === e.img && m.crop)?.crop || null;

export function isStrip(width, height) {
  return width > 0 && height > 0 && (width < 0.4 * height || width > 4 * height);
}

// Lines in order, the same sentence said again in a row once: {k: its latest event, n: how many times}.
export function lines(events, members) {
  const out = [];
  for (const k of members) {
    const last = out.at(-1);
    if (last && events[last.k].say === events[k].say && events[last.k].kind === events[k].kind) {
      last.n++;
      last.k = k;
    } else {
      out.push({k, n: 1});
    }
  }
  return out;
}

// The pictures of a stretch of work, latest first, each once: those its lines name (each line's own first,
// then the others it looked at), none made up.
export function pictures(events, members, max = 2, allowed = () => true) {
  const latest = [...members].reverse();
  const out = [];
  for (const [k, src] of [...latest.map((k) => [k, events[k].img]), ...latest.flatMap((k) => (events[k].media || []).map((m) => [k, m.src]))]) {
    if (src && out.length < max && allowed(src) && !out.some((p) => p.src === src)) out.push({k, src});
  }
  return out;
}

// Keep detached pictures, including ones hidden by folding or seeking back, without retaining their cards.
export class CardImages {
  byCard = new Map();
  strips = new Set();

  collect(card) {
    const key = card.dataset.key;
    for (const img of [...card.querySelectorAll('img')].reverse()) {
      const src = img.dataset.file;
      if (this.strips.has(src) && !img.closest('.cell')) continue;
      if (!this.byCard.has(key)) this.byCard.set(key, new Map());
      const bySrc = this.byCard.get(key);
      if (!bySrc.has(src)) bySrc.set(src, []);
      bySrc.get(src).push(img);
      img.remove();
    }
  }

  take(key, src) {
    const bySrc = this.byCard.get(key), matches = bySrc?.get(src);
    if (!matches) return;
    let kept;
    while (matches.length && !kept) {
      const img = matches.pop();
      if (!img.complete || img.naturalWidth) kept = img;
    }
    if (!matches.length) bySrc.delete(src);
    if (!bySrc.size) this.byCard.delete(key);
    return kept;
  }

  attach(key, img, onLoad) {
    const kept = this.take(key, img.dataset.file);
    if (kept) {
      kept.style.cssText = img.style.cssText;
      img.replaceWith(kept);
    } else {
      img.addEventListener('load', onLoad, {once: true});
      img.src = img.dataset.file;
    }
  }

  prune(deck, events) {
    const cards = new Map(deck.map((card) => [card.key, card]));
    for (const [key, bySrc] of this.byCard) {
      const card = cards.get(key), members = card?.members || [];
      const sources = new Set(members.flatMap((k) => [events[k].img, ...(events[k].media || []).map((m) => m.src)]));
      const grid = card?.type === 'objects';
      for (const src of bySrc.keys()) if (!sources.has(src) || (!grid && this.strips.has(src))) bySrc.delete(src);
      if (!bySrc.size) this.byCard.delete(key);
    }
  }
}

export const nearEnd = (log, distance = 48) => log.scrollHeight - log.scrollTop - log.clientHeight < distance;

export function appendedEvents(previous, next) {
  if (!previous.length) return next.length > 0;
  const last = previous.at(-1), tail = next.at(-1);
  if (!tail) return false;
  // Splitting a summary changes its row IDs, but preserves the last raw record it covers.
  const sameSession = (e) => last.end_seq != null && e.end_seq != null && e.session === last.session;
  if (sameSession(tail)) return tail.end_seq > last.end_seq;
  if (tail.id === last.id) return false;
  if (tail.t !== last.t) return tail.t > last.t;
  return next.some((e) => e.t === last.t && (sameSession(e) ? e.end_seq === last.end_seq : e.id === last.id));
}

export function keepReading(log, events, appended = false) {
  const scroll = log.scrollTop, {top, bottom} = log.getBoundingClientRect();
  if (nearEnd(log, appended ? 48 : 1)) return () => {log.scrollTop = log.scrollHeight;};
  const card = [...log.querySelectorAll('[data-key]')].find((el) => el.getBoundingClientRect().bottom > top);
  const cardTop = card?.getBoundingClientRect().top;
  // In an expanded card the sticky heading stays put while the lines underneath it scroll.
  const rows = cardTop < top ? [...card.querySelectorAll('[data-i]')] : [];
  const first = rows[0];
  const heading = first && getComputedStyle(first).position === 'sticky' && first.getBoundingClientRect();
  const row = rows.find((el) => {
    const r = el.getBoundingClientRect();
    const start = Math.max(r.top, top), end = Math.min(r.bottom, bottom);
    return end > start && (!heading || (el !== first && (start < heading.top || end > heading.bottom)));
  });
  const id = row && events[row.dataset.i].id;
  const rowTop = row && row.getBoundingClientRect().top;
  return (updated = events) => {
    const next = card && log.querySelector(`[data-key="${CSS.escape(card.dataset.key)}"]`);
    const k = row && (id != null ? updated.findIndex((e) => e.id === id) : row.dataset.i);
    const line = row && log.querySelector(`${row.tagName}${row.classList.contains('lead') ? '.lead' : ':not(.lead)'}[data-i="${k}"]`);
    if (line && getComputedStyle(line).position !== 'sticky') log.scrollTop += line.getBoundingClientRect().top - rowTop;
    else if (next) log.scrollTop += next.getBoundingClientRect().top - cardTop;
    else log.scrollTop = scroll;
  };
}

// Scroll by the smallest amount for a whole card. For a tall one, show its start if the current line fits too.
export function cardScroll(top, bottom, current, height, heading = 0) {
  const gap = 12;
  if (bottom - top > height - 2 * gap) {
    if (current.bottom - top <= height - 2 * gap) return top - gap;
    return Math.min(current.top - heading - gap, current.bottom - height + gap);
  }
  if (top < gap) return top - gap;
  return Math.max(0, bottom - height + gap);
}
