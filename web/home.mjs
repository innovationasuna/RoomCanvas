// Room identities and previews come from the manifest; furniture counts come from each room's data.
import {mountRoomReconstruction, jobDescription} from './room-reconstruction.mjs';
import {mountRoomTrash} from './room-trash.mjs';
const list = document.getElementById('rooms');
const state = document.getElementById('room-state');
const count = document.getElementById('room-count');
const retry = document.getElementById('retry-rooms');
const manifest = new URL('rooms.json', location.href);
const create = (tag, className, text) => Object.assign(document.createElement(tag), {className, textContent: text || ''});

let jobs = [], hiddenRooms = new Set(), loadVersion = 0;

// Keep at least two rows, with a complete vacant row after the occupied rows.
function fillRoomSlots() {
  for (const slot of list.querySelectorAll('.room-empty')) slot.remove();
  const columns = Number(getComputedStyle(list).getPropertyValue('--room-columns')) || 4;
  const occupied = list.children.length;
  const totalRows = Math.max(2, Math.ceil(occupied / columns) + 1);
  const vacancies = totalRows * columns - occupied;
  for (let index = 0; index < vacancies; index++) {
    const slot = create('button', 'room-empty');
    slot.type = 'button';
    slot.setAttribute('aria-label', '在空房间位重建房间');
    const preview = create('span', 'room-empty-preview');
    preview.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    const copy = create('span', 'room-empty-copy');
    copy.append(create('span', 'room-empty-title', '空房间位'), create('span', 'room-empty-note', '点击重建房间'));
    slot.append(preview, copy);
    slot.onclick = () => document.getElementById('reconstruct-room').click();
    list.append(slot);
  }
}
if (typeof ResizeObserver !== 'undefined') {
  let previousColumns = '';
  new ResizeObserver(() => {
    const columns = getComputedStyle(list).getPropertyValue('--room-columns');
    if (columns !== previousColumns && !count.hidden) {previousColumns = columns; fillRoomSlots();}
  }).observe(list);
}

async function describe(room) {
  const job = room.job;
  const dir = new URL((room.dir || './').replace(/\/?$/, '/'), manifest);
  const card = create('article', 'room');
  const link = create('a', 'room-link');
  const action = job ? '实时查看' : '进入布置';
  link.href = job ? `replay.html?job=${encodeURIComponent(job.id)}` : `editor/?room=${encodeURIComponent(room.id)}`;
  link.setAttribute('aria-label', `${room.name}，${action}`);
  const preview = create('div', 'room-preview');
  const image = Object.assign(document.createElement('img'), {
    src: new URL('thumbnail.jpg', dir).href, alt: '', loading: 'lazy', width: 960, height: 600,
  });
  const media = create('div', 'room-media');
  image.onerror = () => {
    const fallback = create('span', 'preview-missing');
    fallback.innerHTML = '<svg aria-hidden="true"><use href="#icon-room"/></svg><span>房间预览暂不可用</span>';
    media.replaceChildren(fallback);
  };
  if (job) {
    preview.classList.add('room-building');
    const pending = create('span', 'preview-missing');
    pending.innerHTML = '<svg aria-hidden="true"><use href="#icon-room"/></svg><span>正在构建你的空间</span>';
    media.append(pending);
  } else media.append(image);
  preview.append(media);
  const copy = create('div', 'room-copy'), titleRow = create('div', 'room-title-row');
  const facts = create('span', 'room-facts', job ? (job.status === 'queued' ? '等待重建' : '正在重建') : '读取中…');
  titleRow.append(create('h2', '', room.name));
  const overlay = create('div', 'room-overlay');
  if (job) facts.classList.add('room-status');
  const hint = create('span', 'room-open', action);
  overlay.append(facts);
  preview.append(overlay);
  copy.append(titleRow, create('p', 'room-note', job ? jobDescription(job) : room.summary || room.note), hint);
  link.append(preview, copy);
  const menu = create('details', 'room-menu');
  const toggle = create('summary', 'room-menu-toggle');
  toggle.setAttribute('aria-label', `${room.name}的更多操作`);
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
  const remove = create('button', 'room-delete', '删除房间');
  menu.append(toggle, remove);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { menu.open = false; toggle.focus(); }
  });
  menu.addEventListener('focusout', event => {
    if (!menu.contains(event.relatedTarget)) menu.open = false;
  });
  remove.type = 'button';
  remove.setAttribute('aria-label', `删除房间：${room.name}`);
  const error = create('p', 'room-delete-error error');
  error.setAttribute('role', 'alert'); error.hidden = true;
  remove.onclick = async () => {
    if (!window.confirm(`将“${room.name}”移入回收站？可以随时恢复，扫描和模型文件会保留。${job ? '服务器上的重建会继续运行。' : ''}`)) return;
    remove.disabled = true; error.hidden = true;
    try {
      const response = await fetch(`/web/rooms/${encodeURIComponent(room.id)}`, {method: 'DELETE'});
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '删除失败，请检查网页服务后重试。');
      await loadRooms();
      await reconstruction.refresh();
    } catch (reason) {error.textContent = reason.message; error.hidden = false; remove.disabled = false;}
  };
  card.append(link, menu, error);
  list.append(card);
  if (job) return;
  try {
    const response = await fetch(new URL('room_objects.json', dir), {cache: 'no-cache'});
    if (!response.ok) throw new Error('Room metadata unavailable');
    const objects = await response.json();
    if (!Array.isArray(objects.groups)) throw new Error('Invalid furniture list');
    facts.textContent = `${objects.groups.length} 件物品`;
  } catch {
    facts.textContent = '房间信息暂不可用';
    facts.classList.add('error');
  }
}

async function loadRooms() {
  const version = ++loadVersion;
  retry.hidden = true; retry.disabled = true;
  state.hidden = false; count.hidden = true;
  list.setAttribute('aria-busy', 'true');
  document.getElementById('state-title').textContent = '正在读取房间…';
  document.getElementById('state-copy').textContent = '即将显示可布置的空间。';
  try {
    const response = await fetch(manifest, {cache: 'no-cache'});
    if (!response.ok) throw new Error('Room list unavailable');
    const {rooms, deleted = []} = await response.json();
    if (version !== loadVersion) return;
    if (!Array.isArray(rooms)) throw new Error('Invalid room list');
    hiddenRooms = new Set(deleted);
    trash.setCount(hiddenRooms.size);
    for (const job of jobs) {
      if (!job.replay_only && ['queued', 'running', 'preparing'].includes(job.status) && !hiddenRooms.has(`scan-${job.id}`) && !rooms.some(room => room.id === `scan-${job.id}`)) {
        rooms.push({id: `scan-${job.id}`, name: job.name, dir: './', job});
      }
    }
    if (!Array.isArray(rooms) || rooms.some(room => !room || ['id', 'name', 'dir'].some(key => typeof room[key] !== 'string' || !room[key]))) throw new Error('Invalid room list');
    list.replaceChildren();
    count.textContent = `${rooms.length} 个房间`; count.hidden = false;
    state.hidden = true;
    const descriptions = rooms.map(describe);
    fillRoomSlots();
    await Promise.all(descriptions);
  } catch {
    if (version !== loadVersion) return;
    list.replaceChildren();
    state.hidden = false; count.hidden = true;
    document.getElementById('state-title').textContent = '暂时无法读取房间';
    document.getElementById('state-copy').textContent = '请稍后重试。';
    retry.hidden = false;
  } finally {
    if (version !== loadVersion) return;
    list.setAttribute('aria-busy', 'false'); retry.disabled = false;
  }
}
const trash = mountRoomTrash({onRoomsChanged: async () => {
  await loadRooms();
  await reconstruction.refresh();
}});
retry.onclick = loadRooms;
void loadRooms();
const reconstruction = mountRoomReconstruction({onRoomsChanged: loadRooms, onJobsChanged: async next => {
  if (JSON.stringify(jobs) === JSON.stringify(next)) return;
  jobs = next; await loadRooms();
}, isRoomHidden: id => hiddenRooms.has(id)});
