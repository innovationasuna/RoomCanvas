// A persistent server queue owns the work; closing this page never cancels reconstruction.
const API = '/room-reconstruction';
const labels = {ingest: '读取扫描与提取素材', reconstruct: '重建场景物体', seed: '建立房间结构', author: '生成完整房间', publish: '导出房间模型', articulate: '生成可动部件'};
export function scanError(file, name) {
  if (!name.trim() || name.trim().length > 80) return '请填写房间名称（最多 80 个字符）。';
  if (!file || !/\.zip$/i.test(file.name)) return '请选择完整的房间扫描 ZIP。';
  if (!file.size || file.size > 2 * 1024 ** 3) return '扫描 ZIP 需在 2 GB 以内且不能为空。';
  return '';
}
export function jobDescription(job) {
  if (job.status === 'failed') return job.error || '重建未完成，可以重试。';
  if (job.status === 'completed') return '重建完成，已加入房间列表。';
  if (job.status === 'queued') return '已提交，等待服务器开始重建。';
  if (job.status === 'preparing') return '正在整理模型与可布置的物品。';
  const stages = job.stages || [];
  const names = Object.keys(labels).filter(name => name !== 'articulate' || stages.some(stage => stage.name === name));
  const next = names.find(name => !stages.some(stage => stage.name === name && ['completed', 'reused'].includes(stage.status)));
  return next ? `正在${labels[next]}…` : '正在完成模型导出…';
}
async function request(path, options = {}) {
  const response = await fetch(API + path, {...options, signal: AbortSignal.timeout(15000)});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (response.status === 404 ? '网页服务尚未启用房间重建接口，请更新并重启网页服务。' : '暂时无法连接房间重建服务，请稍后重试。'));
  return data;
}

export function mountRoomReconstruction({onRoomsChanged}) {
  const $ = id => document.getElementById(id);
  const dialog = $('reconstruction-dialog'), form = $('reconstruction-form');
  let connected = false, uploading = false, selected = null, uploadID = null;
  let polling = false, fingerprint = '', completed = null;
  const report = message => { $('reconstruction-error').textContent = message; $('reconstruction-error').hidden = !message; };
  const controls = () => {
    $('submit-reconstruction').disabled = uploading || !connected || !!scanError(selected, $('reconstruction-name').value);
    $('reconstruction-name').disabled = uploading;
    $('reconstruction-file').disabled = uploading;
    $('close-reconstruction').disabled = uploading;
    $('submit-reconstruction').textContent = uploading ? '正在提交…' : '上传并开始重建';
  };
  async function check() {
    $('check-reconstruction').disabled = true;
    $('reconstruction-service').textContent = '正在检查重建服务…';
    try {
      await request('/health'); connected = true;
      $('reconstruction-service').textContent = '房间重建服务已连接';
    } catch (error) {
      connected = false;
      $('reconstruction-service').textContent = error.message;
    } finally { $('check-reconstruction').disabled = false; controls(); }
  }
  function pick(file) {
    if (uploading) return;
    selected = file; uploadID = null;
    $('scan-selected').textContent = file ? `${file.name} · ${(file.size / 1024 ** 2).toFixed(1)} MB` : '选择或拖入扫描 ZIP';
    report(file ? scanError(file, $('reconstruction-name').value || '房间') : '');
    controls();
  }
  $('reconstruct-room').onclick = () => { dialog.showModal(); void check(); };
  $('close-reconstruction').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (uploading) event.preventDefault(); });
  $('check-reconstruction').onclick = check;
  $('reconstruction-file').onchange = event => pick(event.target.files[0]);
  $('reconstruction-name').oninput = () => {uploadID = null; controls();};
  const drop = $('scan-drop');
  drop.ondragover = event => {event.preventDefault(); if (!uploading) drop.classList.add('dragging');};
  drop.ondragleave = () => drop.classList.remove('dragging');
  drop.ondrop = event => {
    event.preventDefault(); drop.classList.remove('dragging');
    if (uploading) return;
    if (event.dataTransfer.files.length !== 1) return report('每次请选择一个房间的扫描 ZIP。');
    $('reconstruction-file').value = ''; pick(event.dataTransfer.files[0]);
  };
  // Keep a drop-selected file valid even though the native file picker is empty.
  form.noValidate = true;
  form.onsubmit = async event => {
    event.preventDefault();
    if (uploading || !connected) return;
    const name = $('reconstruction-name').value.trim(), error = scanError(selected, name);
    if (error) return report(error);
    uploading = true; controls(); report('');
    uploadID ||= crypto.randomUUID().replaceAll('-', '');
    $('scan-upload-progress').hidden = false;
    $('scan-progress').value = 0;
    $('scan-progress-label').textContent = '正在上传扫描包…';
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', API + '/jobs'); xhr.timeout = 15 * 60 * 1000;
        xhr.setRequestHeader('Content-Type', 'application/zip');
        xhr.setRequestHeader('X-Room-Name', encodeURIComponent(name));
        xhr.setRequestHeader('X-Upload-ID', uploadID);
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) {
            const percent = Math.round(event.loaded / event.total * 100);
            $('scan-progress').value = percent;
            $('scan-progress-label').textContent = percent === 100 ? '上传完成，正在校验扫描包并提交…' : `正在上传扫描包 · ${percent}%`;
          }
        };
        xhr.onload = () => {
          let data = {}; try {data = JSON.parse(xhr.responseText);} catch {}
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || '提交失败，请检查服务连接后重试。'));
        };
        xhr.onerror = xhr.ontimeout = () => reject(new Error('提交响应中断，请先刷新任务状态；重新提交同一文件不会重复创建任务。'));
        xhr.send(selected);
      });
      dialog.close();
      form.reset(); selected = null; uploadID = null;
      $('scan-selected').textContent = '选择或拖入扫描 ZIP';
      await refresh();
      $('reconstruction-jobs').scrollIntoView({block: 'nearest'});
    } catch (error) { report(error.message); void refresh(); }
    finally { uploading = false; $('scan-upload-progress').hidden = true; controls(); }
  };
  async function refresh() {
    if (polling) return;
    polling = true; $('refresh-jobs').disabled = true;
    try {
      const {jobs} = await request('/jobs');
      if (!Array.isArray(jobs)) throw new Error('任务列表格式无效，请检查重建服务版本。');
      $('jobs-message').textContent = '';
      $('reconstruction-jobs').hidden = !jobs.length;
      const roomIDs = jobs.filter(j => j.status === 'completed').map(j => j.id).sort().join(',');
      if (completed !== null && completed !== roomIDs) await onRoomsChanged();
      completed = roomIDs;
      const next = JSON.stringify(jobs);
      if (next !== fingerprint) {
        fingerprint = next;
        const rows = jobs.filter(j => j.status !== 'completed').concat(jobs.filter(j => j.status === 'completed').slice(0, 3));
        $('jobs-list').replaceChildren(...rows.map(job => {
          const row = document.createElement('article'); row.className = 'reconstruction-job';
          const copy = document.createElement('div'), name = document.createElement('strong'), time = document.createElement('time'), note = document.createElement('p');
          name.textContent = job.name;
          const date = new Date(job.created * 1000); time.dateTime = date.toISOString();
          time.textContent = date.toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
          note.textContent = jobDescription(job);
          copy.append(name, time, note); row.append(copy);
          if (job.status === 'completed' && job.room) {
            const link = document.createElement('a'); link.className = 'home-button'; link.textContent = '进入布置';
            link.href = `editor/?room=${encodeURIComponent(job.room.id)}`; row.append(link);
          } else if (job.status === 'failed') {
            const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'home-button'; retry.textContent = '重试';
            retry.onclick = async () => {
              retry.disabled = true;
              try { await request(`/jobs/${job.id}/retry`, {method: 'POST'}); await refresh(); }
              catch (error) { $('jobs-message').textContent = error.message; }
              finally { retry.disabled = false; }
            };
            row.append(retry);
          }
          return row;
        }));
      }
    } catch (error) {
      if (fingerprint) { $('reconstruction-jobs').hidden = false; $('jobs-message').textContent = `${error.message} 已保留上次状态。`; }
    } finally {polling = false; $('refresh-jobs').disabled = false;}
  }
  $('refresh-jobs').onclick = refresh;
  void refresh();
  const schedule = () => setInterval(() => {if (!document.hidden) void refresh();}, 10000);
  let timer = schedule();
  document.addEventListener('visibilitychange', () => {if (!document.hidden) void refresh();});
  window.addEventListener('pagehide', () => clearInterval(timer));
  window.addEventListener('pageshow', event => {if (event.persisted) {timer = schedule(); void refresh();}});
  if (location.hash === '#reconstruct') $('reconstruct-room').click();
}
