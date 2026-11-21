const create = (tag, className, text = '') => Object.assign(document.createElement(tag), {className, textContent: text});

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) {value /= 1024; unit++;}
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function releasableBytes(rows) {
  const blobs = new Map();
  for (const row of rows) {
    // Older servers report independent file sizes, without shared-data records.
    for (const blob of row.blobs || [{id: row.id, bytes: row.bytes, refs: 1, links: 1}]) {
      const previous = blobs.get(blob.id);
      blobs.set(blob.id, {...blob, refs: blob.refs + (previous?.refs || 0)});
    }
  }
  return [...blobs.values()].reduce((sum, blob) => sum + (blob.refs >= blob.links ? blob.bytes : 0), 0);
}

export function mountCacheManager() {
  const $ = id => document.getElementById(id);
  const dialog = $('cache-dialog'), entry = $('open-cache'), list = $('cache-list');
  const error = $('cache-error'), status = $('cache-status'), message = $('cache-message');
  const selectAll = $('cache-select-all'), clearSelected = $('clear-cache-selected'), clearAll = $('clear-cache-all');
  const refreshButton = $('refresh-cache');
  let rows = [], selected = new Set(), busy = false;
  const report = text => {error.textContent = text; error.hidden = !text;};

  function updateControls() {
    const chosen = rows.filter(row => selected.has(row.id));
    $('cache-selection').textContent = chosen.length ? `已选 ${chosen.length} 项 · 预计释放 ${formatBytes(releasableBytes(chosen))}` : '选择要清理的房间缓存';
    selectAll.checked = rows.length > 0 && chosen.length === rows.length;
    selectAll.indeterminate = chosen.length > 0 && chosen.length < rows.length;
    selectAll.disabled = busy || !rows.length;
    clearSelected.disabled = busy || !chosen.length;
    clearAll.disabled = busy || !rows.length;
    refreshButton.disabled = busy;
    for (const input of list.querySelectorAll('input')) input.disabled = busy;
    list.setAttribute('aria-busy', String(busy));
  }

  function render(data) {
    if (!Array.isArray(data.entries) || data.entries.some(row => !row || typeof row.id !== 'string'
        || typeof row.name !== 'string' || !Array.isArray(row.kinds)
        || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(row.files) || row.files < 0)) {
      throw new Error('缓存列表格式无效，请更新网页服务后重试。');
    }
    rows = data.entries;
    selected = new Set([...selected].filter(id => rows.some(row => row.id === id)));
    status.textContent = rows.length ? `${rows.length} 项缓存 · ${data.total_files} 个文件 · 共 ${formatBytes(data.total_bytes)}` : '本地没有已下载的缓存。';
    $('cache-paused').hidden = !data.background_paused;
    list.replaceChildren(...rows.map(row => {
      const label = create('label', 'cache-row');
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected.has(row.id);
      input.setAttribute('aria-label', `选择缓存：${row.name}`);
      input.onchange = () => {if (input.checked) selected.add(row.id); else selected.delete(row.id); updateControls();};
      const copy = create('span', 'cache-copy');
      copy.append(create('strong', '', row.name), create('span', '', `${row.kinds.join('、')} · ${row.files} 个文件`));
      label.append(input, copy, create('span', 'cache-size', formatBytes(row.bytes)));
      return label;
    }));
    updateControls();
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {...options, cache: 'no-store', signal: AbortSignal.timeout(60000)});
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '缓存管理暂不可用，请更新并重启网页服务后重试。');
    return data;
  }

  async function refresh() {
    if (busy) return;
    busy = true; updateControls(); report(''); message.textContent = ''; status.textContent = '正在读取本地缓存…';
    try {render(await request('/web/cache'));}
    catch (reason) {rows = []; selected.clear(); list.replaceChildren(); status.textContent = ''; report(reason.message);}
    finally {busy = false; updateControls();}
  }

  async function clear(all) {
    if (busy || !(all ? rows.length : selected.size)) return;
    const chosen = all ? rows : rows.filter(row => selected.has(row.id));
    const bytes = releasableBytes(chosen);
    if (!window.confirm(`清理${all ? '全部' : '选中的'} ${chosen.length} 项本地缓存（预计释放 ${formatBytes(bytes)}）？服务器结果和已保存的布局会保留，再次查看可能需要重新下载。`)) return;
    busy = true; updateControls(); report(''); message.textContent = '正在清理…';
    try {
      const result = await request('/web/cache/clear', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(all ? {all: true} : {ids: chosen.map(row => row.id)})});
      selected.clear(); render(result.cache);
      message.textContent = `已清理 ${result.removed_files} 个文件，释放 ${formatBytes(result.freed_bytes)}。`;
      report((result.errors || []).join(' '));
    } catch (reason) {message.textContent = ''; report(reason.message);}
    finally {busy = false; updateControls();}
  }

  selectAll.onchange = () => {
    selected = new Set(selectAll.checked ? rows.map(row => row.id) : []);
    for (const input of list.querySelectorAll('input')) input.checked = selectAll.checked;
    updateControls();
  };
  clearSelected.onclick = () => clear(false);
  clearAll.onclick = () => clear(true);
  refreshButton.onclick = refresh;
  entry.onclick = () => {dialog.showModal(); entry.setAttribute('aria-expanded', 'true'); return refresh();};
  $('close-cache').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {entry.setAttribute('aria-expanded', 'false'); entry.focus();});
  updateControls();
}
