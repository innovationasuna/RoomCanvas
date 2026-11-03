// Room identities and previews come from the manifest; furniture counts come from each room's data.
import {mountRoomReconstruction} from './room-reconstruction.mjs';
const list = document.getElementById('rooms');
const state = document.getElementById('room-state');
const count = document.getElementById('room-count');
const retry = document.getElementById('retry-rooms');
const manifest = new URL('rooms.json', location.href);
const create = (tag, className, text) => Object.assign(document.createElement(tag), {className, textContent: text || ''});

async function describe(room) {
  const dir = new URL(room.dir.replace(/\/?$/, '/'), manifest);
  const card = create('a', 'room');
  card.href = `editor/?room=${encodeURIComponent(room.id)}`;
  card.setAttribute('aria-label', `${room.name}，进入布置`);
  const preview = create('div', 'room-preview');
  const image = Object.assign(document.createElement('img'), {
    src: new URL('thumbnail.jpg', dir).href, alt: '', loading: 'lazy', width: 960, height: 600,
  });
  image.onerror = () => {
    const fallback = create('span', 'preview-missing');
    fallback.innerHTML = '<svg aria-hidden="true"><use href="#icon-room"/></svg><span>房间预览暂不可用</span>';
    preview.replaceChildren(fallback);
  };
  preview.append(image);
  const copy = create('div', 'room-copy'), titleRow = create('div', 'room-title-row');
  const facts = create('span', 'room-facts', '读取中…');
  titleRow.append(create('h2', '', room.name), facts);
  const enter = create('span', 'room-open');
  enter.innerHTML = '<span>进入布置</span><svg aria-hidden="true"><use href="#icon-enter"/></svg>';
  copy.append(titleRow, create('p', 'room-note', room.summary || room.note), enter);
  card.append(preview, copy);
  list.append(card);
  try {
    const response = await fetch(new URL('room_objects.json', dir), {cache: 'no-cache'});
    if (!response.ok) throw new Error('Room metadata unavailable');
    const objects = await response.json();
    if (!Array.isArray(objects.groups)) throw new Error('Invalid furniture list');
    facts.textContent = `${objects.groups.length} 件家具`;
  } catch {
    facts.textContent = '房间信息暂不可用';
    facts.classList.add('error');
  }
}

async function loadRooms() {
  retry.hidden = true; retry.disabled = true;
  state.hidden = false; count.hidden = true;
  list.setAttribute('aria-busy', 'true');
  document.getElementById('state-title').textContent = '正在读取房间…';
  document.getElementById('state-copy').textContent = '即将显示可布置的空间。';
  try {
    const response = await fetch(manifest, {cache: 'no-cache'});
    if (!response.ok) throw new Error('Room list unavailable');
    const {rooms} = await response.json();
    if (!Array.isArray(rooms) || rooms.some(room => !room || ['id', 'name', 'dir'].some(key => typeof room[key] !== 'string' || !room[key]))) throw new Error('Invalid room list');
    list.replaceChildren();
    count.textContent = `${rooms.length} 个房间`; count.hidden = false;
    if (!rooms.length) {
      document.getElementById('state-title').textContent = '还没有可布置的房间';
      document.getElementById('state-copy').textContent = '房间准备好后，会显示在这里。';
      retry.hidden = false;
    } else {
      state.hidden = true;
      await Promise.all(rooms.map(describe));
    }
  } catch {
    list.replaceChildren();
    state.hidden = false; count.hidden = true;
    document.getElementById('state-title').textContent = '暂时无法读取房间';
    document.getElementById('state-copy').textContent = '请稍后重试。';
    retry.hidden = false;
  } finally {
    list.setAttribute('aria-busy', 'false'); retry.disabled = false;
  }
}
retry.onclick = loadRooms;
void loadRooms();
mountRoomReconstruction({onRoomsChanged: loadRooms});
