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
                     small: '已按照片重做 {n} 件小物品'};

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

// One entry per object, in the order they first came: its latest event (k) and picture (with the part of it
// showing the object, crop, when the picture shows much more).
export function objects(events, members) {
  const by = new Map();
  for (const k of members) {
    const e = events[k], prev = by.get(e.object_id);
    by.set(e.object_id, {id: e.object_id, name: e.object_name || '', k, img: e.img || prev?.img || null,
      crop: e.img ? cropOf(e) : prev?.crop || null});
  }
  const items = [...by.values()], names = new Map();
  for (const item of items) {
    if (!names.has(item.name)) names.set(item.name, []);
    names.get(item.name).push(item);
  }
  for (const group of names.values()) {
    group.forEach((item, i) => {item.label = group.length > 1 ? `${item.name} ${i + 1}` : item.name;});
  }
  return items;
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

  collect(card) {
    const key = card.dataset.key;
    for (const img of [...card.querySelectorAll('img')].reverse()) {
      const src = img.dataset.file;
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
    const img = matches.pop();
    if (!matches.length) bySrc.delete(src);
    if (!bySrc.size) this.byCard.delete(key);
    return img;
  }

  prune(deck, events) {
    const cards = new Map(deck.map((card) => [card.key, card]));
    for (const [key, bySrc] of this.byCard) {
      const members = cards.get(key)?.members || [];
      const sources = new Set(members.flatMap((k) => [events[k].img, ...(events[k].media || []).map((m) => m.src)]));
      for (const src of bySrc.keys()) if (!sources.has(src)) bySrc.delete(src);
      if (!bySrc.size) this.byCard.delete(key);
    }
  }
}

// Scroll by the smallest amount for a whole card. For a tall one, show its start if the current line fits too.
export function cardScroll(top, bottom, current, height, gap = 12) {
  if (bottom - top > height - 2 * gap) {
    if (current.bottom - top <= height - 2 * gap) return top - gap;
    return Math.min(current.top - gap, current.bottom - height + gap);
  }
  if (top < gap) return top - gap;
  return Math.max(0, bottom - height + gap);
}
