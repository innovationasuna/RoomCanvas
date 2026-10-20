import { zipSync } from 'fflate';
import { jsonBody, request } from './local-client';
import type { RoomRecord } from './room-types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escape = (text: string) => text.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]!));
function roomArt(cover: string) {
  const furniture = cover === 'bedroom'
    ? '<path d="m115 138 90-49 87 49-89 49z" fill="#b6ae97"/><path d="m115 138 88 49v32l-88-49z" fill="#9a927b"/><path d="m203 187 89-49v32l-89 49z" fill="#c8bea8"/><path d="m128 137 77-41 75 42-76 42z" fill="#e8e1ce"/><path d="m179 112 25-14 28 16-25 14z" fill="#faf5e8"/><path d="m213 131 23-12 30 16-25 14z" fill="#faf5e8"/>'
    : '<path d="m104 143 94-52 38 22-94 52z" fill="#b29c77"/><path d="m104 143 38 22v7l-38-22z" fill="#948568"/><path d="m142 165 94-52v7l-94 52z" fill="#c4b08d"/><path d="M111 151v41m32-20v38m85-88v39" stroke="#827863" stroke-width="4"/><path d="m150 122 27-15v-27l-27 15z" fill="#53645c"/><path d="m156 99 16-9v15l-16 9z" fill="#77867a"/><path d="m180 173 27-15 27 15-27 15z" fill="#67746a"/><path d="m180 173 27 15v28l-27-15z" fill="#4d5b54"/><path d="m207 188 27-15v28l-27 15z" fill="#7e897c"/><path d="M183 202v15m25 0v14m22-29v15" stroke="#4e554a" stroke-width="3"/>';
  return `<svg viewBox="0 0 400 275" aria-hidden="true" class="room-illustration"><ellipse cx="200" cy="235" rx="145" ry="19" fill="#575442" opacity=".07"/><path d="m57 157 143-79 143 79-143 79z" fill="#d6cfbb"/><path d="m57 157 143 79v8L57 165z" fill="#bcb49e"/><path d="m200 236 143-79v8l-143 79z" fill="#c7c0ab"/><path d="M57 157V66l143-79v91z" transform="translate(0 41)" fill="#e6e1d1"/><path d="m200 28 143 79v91l-143-79z" fill="#ddd8c8"/><path d="m74 111 63-34v48l-63 34z" fill="#f3eee1"/><path d="m78 113 55-30v38l-55 30z" fill="#b4c0b3"/><path d="m105 98 0 40m-27-4 55-30" stroke="#ede8da" stroke-width="3"/>${furniture}<path d="m280 179 13-7 13 7-13 7z" fill="#9e8d70"/><path d="m280 179 13 7 13-7-4 28-9 5-9-5z" fill="#ad9675"/><path d="M293 181v-54" stroke="#7f8466" stroke-width="2"/><path d="M293 160q-27-2-23-23 24-1 23 23m0-17q20-4 19-23-21 2-19 23m0-12q-20-2-17-19 17 2 17 19" fill="#7e8a6d"/></svg>`;
}

export function setupLibrary(port: {open: (room: RoomRecord) => void; notice: (message: string, undo?: () => void) => void; created: () => void}) {
  let rooms: RoomRecord[] = [], loaded = false, importFiles: File[] = [], importing = false, photoURL = '';
  const grid = $('room-grid'), search = $<HTMLInputElement>('room-search'), sort = $<HTMLSelectElement>('room-sort');
  const dialog = $<HTMLDialogElement>('room-dialog'), rename = $<HTMLInputElement>('rename-input');
  let editing: RoomRecord | undefined, deleting = false;
  function render() {
    const query = search.value.trim().toLocaleLowerCase();
    const visible = rooms.filter(room => room.name.toLocaleLowerCase().includes(query)).sort((a, b) => sort.value === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : sort.value === 'created' ? b.createdAt - a.createdAt : (b.openedAt || b.updatedAt) - (a.openedAt || a.updatedAt));
    $('room-count').textContent = String(rooms.length).padStart(2, '0');
    $('rooms-status').textContent = !loaded ? '正在打开房间列表…' : query && !visible.length ? '没有找到这个房间' : rooms.length ? '' : '你的第一个房间，从这里开始。';
    grid.innerHTML = visible.map((room, index) => `<article class="room-card" style="--card-index:${Math.min(index, 8)}"><button class="room-open" data-room-open="${room.id}" aria-label="打开 ${escape(room.name)}"><div class="room-cover ${room.cover}-cover">${roomArt(room.cover)}</div></button><div class="room-copy"><div class="room-meta"><span>${room.kind === 'example' ? '示例房间' : '我的房间'}</span><span>${room.objectCount} 件家具</span></div><div class="room-card-heading"><button data-room-open="${room.id}" class="room-name">${escape(room.name)}</button><details class="room-menu"><summary aria-label="管理 ${escape(room.name)}">···</summary><div><button data-room-rename="${room.id}">重命名</button><button data-room-delete="${room.id}" class="danger-text">删除房间</button></div></details></div></div></article>`).join('') + (!query ? '<a class="new-room" href="#create"><span class="new-room-plus" aria-hidden="true">＋</span><strong>创建新房间</strong></a>' : '');
  }
  async function reload() {
    try {rooms = (await request<{rooms: RoomRecord[]}>('/api/rooms')).rooms; loaded = true; render();}
    catch (error) {$('rooms-status').textContent = (error as Error).message; throw error;}
  }
  search.addEventListener('input', render); sort.addEventListener('change', render);
  function edit(room: RoomRecord, remove: boolean) {
    editing = room; deleting = remove;
    $('room-dialog-title').textContent = remove ? '删除这个房间？' : '给房间换个名字';
    $('room-dialog-description').textContent = remove ? `「${room.name}」将从我的房间中移除。` : '';
    $('room-dialog-description').hidden = !remove;
    rename.hidden = remove; rename.required = !remove; rename.value = room.name;
    $('room-dialog-status').textContent = '';
    $('room-dialog-submit').textContent = remove ? '删除房间' : '保存名称';
    $('room-dialog-submit').classList.toggle('danger-button', remove);
    dialog.showModal(); if (!remove) {rename.focus(); rename.select();}
  }
  grid.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('button');
    if (!target) return;
    const room = rooms.find(room => room.id === (target.dataset.roomOpen || target.dataset.roomRename || target.dataset.roomDelete));
    if (!room) return;
    grid.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu => menu.open = false);
    if (target.dataset.roomOpen) {port.open(room); return;}
    edit(room, !!target.dataset.roomDelete);
  });
  document.addEventListener('click', event => {if (!(event.target as Element).closest('.room-menu')) grid.querySelectorAll<HTMLDetailsElement>('details[open]').forEach(menu => menu.open = false);});
  document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', event => {if (event.target === dialog) {const rect = dialog.getBoundingClientRect();if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();}});
  $('room-dialog-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!editing) return;
    const room = editing, remove = deleting, submit = $<HTMLButtonElement>('room-dialog-submit');
    submit.disabled = true;
    try {
      await request(`/api/rooms/${room.id}`, {method: remove ? 'DELETE' : 'PATCH', ...(remove ? {} : jsonBody({name: rename.value}))});
      dialog.close(); await reload();
      if (remove) port.notice(`已删除「${room.name}」`, () => void request(`/api/rooms/${room.id}/restore`, {method: 'POST'}).then(reload).then(() => port.notice('房间已恢复')).catch(error => port.notice(error.message)));
      else port.notice('房间名称已更新');
    } catch (error) {$('room-dialog-status').textContent = (error as Error).message;}
    finally {submit.disabled = false;}
  });
  type CreateStep = 'back' | 'photo' | 'import';
  const createStage = $('create-stage');
  const createPanels = {back: $('create-options'), photo: $('photo-panel'), import: $('import-panel')};
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let createStep: CreateStep = 'back', createTransition = 0;
  function choose(mode: CreateStep, animate = true) {
    const previous = createStep, ticket = ++createTransition;
    const outgoing = createPanels[previous], incoming = createPanels[mode];
    const fromHeight = createStage.getBoundingClientRect().height;
    // 连续点击时撤销上一段过渡，旧动画完成后不能再隐藏当前页面。
    createStage.getAnimations().forEach(animation => animation.cancel());
    createStage.style.height = ''; createStage.style.overflow = '';
    Object.values(createPanels).forEach(panel => {
      panel.getAnimations().forEach(animation => animation.cancel());
      panel.classList.remove('is-leaving'); panel.inert = false; panel.hidden = panel !== incoming;
    });
    createStep = mode;
    $('create-back').setAttribute('href', mode === 'back' ? '#rooms' : '#create');
    if (!animate || previous === mode || reducedMotion.matches || !fromHeight) return;

    const toHeight = incoming.getBoundingClientRect().height, direction = mode === 'back' ? -1 : 1;
    createStage.style.height = `${fromHeight}px`; createStage.style.overflow = 'clip';
    outgoing.hidden = false; outgoing.inert = true; outgoing.classList.add('is-leaving');
    const timing = {duration: 440, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both'} as const;
    const animations = [
      outgoing.animate([{opacity: 1, transform: 'translateX(0)'}, {opacity: 0, transform: `translateX(${-36 * direction}px)`}], {duration: 210, easing: 'ease-out', fill: 'forwards'}),
      incoming.animate([{opacity: 0, transform: `translateX(${52 * direction}px)`}, {opacity: 1, transform: 'translateX(0)'}], timing),
      createStage.animate([{height: `${fromHeight}px`}, {height: `${toHeight}px`}], timing),
    ];
    void Promise.all(animations.map(animation => animation.finished.catch(() => {}))).then(() => {
      if (ticket !== createTransition) return;
      outgoing.hidden = true; outgoing.inert = false; outgoing.classList.remove('is-leaving');
      animations.forEach(animation => animation.cancel());
      createStage.style.height = ''; createStage.style.overflow = '';
    });
  }
  document.querySelectorAll<HTMLElement>('[data-create]').forEach(button => button.addEventListener('click', () => choose(button.dataset.create as CreateStep)));
  const fileInput = $<HTMLInputElement>('room-files');
  function chooseFiles(files: File[]) {
    if (importing) return;
    importFiles = [];
    const zip = files.length === 1 && /\.zip$/i.test(files[0].name);
    const pair = files.length === 2 && files.some(file => file.name === 'Room.glb') && files.some(file => file.name === 'room_objects.json');
    const valid = (zip || pair) && files.reduce((sum, file) => sum + file.size, 0) <= 180 * 1024 * 1024;
    if (!valid) {$('import-status').textContent = '请选择房间 ZIP，或配套的 Room.glb 和 room_objects.json（合计不超过 180 MB）';}
    else {
      importFiles = files; $('import-status').textContent = '';
      $('import-file-label').textContent = files.map(file => file.name).join(' + ');
      if (!$<HTMLInputElement>('import-name').value) $<HTMLInputElement>('import-name').value = zip ? files[0].name.replace(/\.zip$/i, '').replace(/^RoomCanvas-bedroom$/, '安静的卧室').slice(0, 40) : '新房间';
    }
    $<HTMLButtonElement>('import-submit').disabled = !valid;
  }
  fileInput.addEventListener('change', () => chooseFiles([...fileInput.files || []]));
  const drop = $('room-drop');
  for (const name of ['dragover', 'dragleave', 'drop']) drop.addEventListener(name, event => {
    event.preventDefault(); drop.classList.toggle('is-dragging', name === 'dragover');
    if (name === 'drop') chooseFiles([...(event as DragEvent).dataTransfer?.files || []]);
  });
  $('import-form').addEventListener('submit', async event => {
    event.preventDefault(); if (importing || !importFiles.length) return;
    importing = true; const submit = $<HTMLButtonElement>('import-submit'); submit.disabled = true; fileInput.disabled = true;
    $('import-status').textContent = '正在导入房间…';
    try {
      let archive: Blob;
      if (importFiles.length === 1) archive = importFiles[0];
      else {
        const contents: Record<string, Uint8Array> = {};
        for (const file of importFiles) contents[file.name] = new Uint8Array(await file.arrayBuffer());
        archive = new Blob([zipSync(contents, {level: 0}) as Uint8Array<ArrayBuffer>], {type: 'application/zip'});
      }
      const result = await request<{room: RoomRecord}>(`/api/rooms/import?name=${encodeURIComponent($<HTMLInputElement>('import-name').value)}`, {method: 'POST', body: archive, headers: {'Content-Type': 'application/zip'}});
      search.value = ''; sort.value = 'created'; await reload();
      $('import-status').textContent = ''; $<HTMLFormElement>('import-form').reset(); importFiles = [];
      $('import-file-label').textContent = '选择文件，或拖放到这里'; choose('back', false); port.created(); port.notice(`「${result.room.name}」已加入我的房间`);
    } catch (error) {$('import-status').textContent = (error as Error).message;}
    finally {importing = false; submit.disabled = !importFiles.length; fileInput.disabled = false;}
  });
  $<HTMLInputElement>('room-photo').addEventListener('change', async event => {
    const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
    if (file.size > 20 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {$('photo-status').textContent = '请选择 20 MB 以内的 JPG、PNG 或 WebP 照片'; return;}
    if (photoURL) URL.revokeObjectURL(photoURL); photoURL = URL.createObjectURL(file);
    const preview = $<HTMLImageElement>('photo-preview'); preview.src = photoURL;
    try {await preview.decode(); preview.hidden = false; $('photo-placeholder').setAttribute('hidden', ''); $('photo-file-label').textContent = file.name; $('photo-status').textContent = '照片已选好，生成功能尚未开放';}
    catch {$('photo-status').textContent = '这张照片无法读取，请选择其他照片'; preview.hidden = true; $('photo-placeholder').removeAttribute('hidden');}
  });
  return {reload, resetCreate(animate = false) {choose('back', animate);}, get rooms() {return rooms;}, find(id: string) {return rooms.find(room => room.id === id);}, opened(room: RoomRecord) {void request(`/api/rooms/${room.id}/opened`, {method: 'POST'}).then(reload).catch(error => port.notice(error.message));}};
}
