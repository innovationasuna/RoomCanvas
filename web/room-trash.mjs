const create = (tag, className, text = '') => Object.assign(document.createElement(tag), {className, textContent: text});

export function mountRoomTrash({onRoomsChanged}) {
  const $ = id => document.getElementById(id);
  const dialog = $('trash-dialog'), list = $('trash-list'), entry = $('open-trash');
  const status = $('trash-status'), error = $('trash-error'), refreshButton = $('refresh-trash');
  let generation = 0, restoring = false;
  const report = message => {error.textContent = message; error.hidden = !message;};
  const setCount = count => {
    $('trash-count').textContent = String(count);
    $('trash-count').hidden = !count;
  };
  async function request(path, options = {}) {
    const response = await fetch(path, {...options, cache: 'no-store', signal: AbortSignal.timeout(15000)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '暂时无法读取回收站，请更新并重启网页服务后重试。');
    return data;
  }
  async function refresh() {
    const version = ++generation;
    refreshButton.disabled = true; list.setAttribute('aria-busy', 'true');
    report(''); status.textContent = '正在读取回收站…';
    try {
      const {rooms} = await request('/web/rooms/trash');
      if (version !== generation) return;
      if (!Array.isArray(rooms) || rooms.some(room => !room || typeof room.id !== 'string' || typeof room.name !== 'string')) throw new Error('回收站数据格式无效，请更新网页服务后重试。');
      list.replaceChildren(...rooms.map(renderRoom));
      setCount(rooms.length);
      status.textContent = rooms.length ? `${rooms.length} 个房间可恢复` : '回收站是空的。删除的房间会出现在这里。';
    } catch (reason) {
      if (version !== generation) return;
      list.replaceChildren(); status.textContent = ''; report(reason.message);
    } finally {
      if (version === generation) {refreshButton.disabled = false; list.setAttribute('aria-busy', 'false');}
    }
  }
  function renderRoom(room) {
    const row = create('article', 'trash-room');
    const preview = create('div', 'trash-preview');
    const fallback = () => {preview.innerHTML = '<svg aria-hidden="true"><use href="#icon-room"/></svg>';};
    fallback();
    if (room.dir) {
      const directory = new URL(room.dir.replace(/\/?$/, '/'), new URL('rooms.json', location.href));
      const image = Object.assign(document.createElement('img'), {src: new URL('thumbnail.jpg', directory).href, alt: '', loading: 'lazy'});
      image.onerror = fallback; preview.replaceChildren(image);
    }
    const copy = create('div', 'trash-copy');
    copy.append(create('h3', '', room.name), create('p', '', room.summary || room.note || '模型与扫描文件已保留。'));
    // Distinguish unavailable scan records even when the remote service cannot supply names.
    if (!room.dir && room.id.startsWith('scan-')) copy.append(create('small', '', `任务 ${room.id.slice(5, 13)}`));
    const restore = create('button', 'home-button', '恢复房间');
    restore.type = 'button'; restore.setAttribute('aria-label', `恢复房间：${room.name}`);
    restore.onclick = async () => {
      if (restoring) return;
      restoring = true; ++generation; report(''); refreshButton.disabled = true;
      const buttons = Array.from(list.querySelectorAll('button'));
      buttons.forEach(button => {button.disabled = true;});
      restore.textContent = '正在恢复…';
      let restored = false;
      try {
        await request(`/web/rooms/${encodeURIComponent(room.id)}/restore`, {method: 'POST'});
        restored = true;
        await onRoomsChanged();
        await refresh();
        if (error.hidden) status.textContent = `已恢复“${room.name}”。${list.children.length ? '' : '回收站已清空。'}`;
        if (dialog.open) (list.querySelector('button') || $('close-trash')).focus();
      } catch (reason) {
        report(restored ? `房间已恢复，但列表刷新失败，请刷新页面。${reason.message}` : reason.message);
      } finally {
        restoring = false; refreshButton.disabled = false;
        buttons.forEach(button => {button.disabled = false;}); restore.textContent = '恢复房间';
      }
    };
    row.append(preview, copy, restore);
    return row;
  }
  entry.onclick = () => {
    dialog.showModal(); entry.setAttribute('aria-expanded', 'true');
    if (!restoring) void refresh();
  };
  $('close-trash').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    entry.setAttribute('aria-expanded', 'false');
    entry.focus();
  });
  refreshButton.onclick = () => {if (!restoring) return refresh();};
  return {setCount};
}
