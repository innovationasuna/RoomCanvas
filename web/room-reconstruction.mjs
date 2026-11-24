// A persistent server queue owns the work; closing this page never cancels reconstruction.
const API = '/room-reconstruction';
const labels = {ingest: '读取扫描数据', reconstruct: '生成房间里的物品', seed: '建立房间结构', author: '生成完整房间', publish: '导出房间模型', articulate: '生成可开合部件'};
// The scanner app exports a tar; a zipped scan folder works too (the service reads either).
const SCAN_ARCHIVE = /\.(zip|tar|tar\.gz|tgz)$/i;
const jointReasons = {
  'no candidate objects': '房间里没有需要额外制作可开合部件的物品。',
  'no new joints accepted; some candidate checks failed': '部分可开合部件未通过检查，物品保留原样。',
  'candidates contain no additional openable parts': '没有发现需要补充的门、抽屉或盖子。',
  'all proposed new parts were rejected by the check': '新制作的可开合部件均未通过检查，物品保留原样。',
};
export function scanError(file, name) {
  if (!name.trim() || name.trim().length > 80) return '请填写房间名称（最多 80 个字符）。';
  if (!file || !SCAN_ARCHIVE.test(file.name)) return '请选择完整的房间扫描包（ZIP、TAR、TAR.GZ 或 TGZ）。';
  if (!file.size || file.size > 2 * 1024 ** 3) return '扫描包需在 2 GB 以内且不能为空。';
  return '';
}
export function jobDescription(job) {
  if (job.status === 'failed') return job.error || '重建未完成，可以重试。';
  if (job.replay_only) return '已有的重建记录，可以回看过程。';
  if (job.status === 'completed') {
    if (job.usable === false) return '重建已结束，但房间模型暂时无法打开。请点“查看过程”了解详情。';
    const notes = ['重建完成，已加入房间列表。'];
    if (job.quality?.status === 'warnings') notes.push('有些地方还需要改进，可以进入房间查看。');
    if (job.warnings?.length) notes.push(job.warnings.join(' '));
    if (Number.isInteger(job.enhancement?.added)) notes.push(`可开合部件原有 ${job.enhancement.existing || 0} 处，本次新增 ${job.enhancement.added} 处。`);
    if (job.enhancement?.added === 0 && job.enhancement.zero_added_reason) notes.push(jointReasons[job.enhancement.zero_added_reason] || job.enhancement.zero_added_reason);
    return notes.join(' ');
  }
  if (job.status === 'queued') return '已提交，等待服务器开始重建。';
  if (job.status === 'preparing') return '正在整理模型与可布置的物品。';
  if (job.gpu_waiting) return '正在排队，轮到后会自动开始重建。';
  const stages = job.stages || [];
  const names = Object.keys(labels).filter(name => name !== 'articulate' || stages.some(stage => stage.name === name));
  const next = names.find(name => !stages.some(stage => stage.name === name && ['completed', 'reused'].includes(stage.status)));
  return next ? `正在${labels[next]}…` : '正在完成模型导出…';
}
async function request(path, options = {}) {
  const response = await fetch(API + path, {...options, signal: AbortSignal.timeout(15000)}).catch(() => {
    throw new Error('暂时连不上房间重建服务。请确认电脑已连接服务器，再重试。');
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || (response.status === 404 ? '当前网页服务还不支持房间重建，请联系管理员更新服务后重试。' : '暂时无法连接房间重建服务，请稍后重试。'));
  // While the reconstruction service is unreachable the web service answers with the last kept state.
  return response.headers?.get('X-RoomCanvas-Cache') === 'stale' ? {...data, stale: true} : data;
}

export function mountRoomReconstruction({onRoomsChanged, onJobsChanged = async () => {}, isRoomHidden = () => false}) {
  const $ = id => document.getElementById(id);
  const dialog = $('reconstruction-dialog'), form = $('reconstruction-form');
  let connected = false, uploading = false, selected = null, uploadID = null;
  let polling = false, fingerprint = '', completed = null;
  const report = message => { $('reconstruction-error').textContent = message; $('reconstruction-error').hidden = !message; };
  const controls = () => {
    $('submit-reconstruction').disabled = uploading || !connected || !!scanError(selected, $('reconstruction-name').value);
    $('reconstruction-name').disabled = uploading;
    $('reconstruction-file').disabled = uploading;
    $('remove-scan').hidden = !selected;
    $('remove-scan').disabled = uploading;
    $('close-reconstruction').disabled = uploading;
    $('submit-reconstruction').textContent = uploading ? '正在提交…' : '上传并开始重建';
  };
  async function check() {
    $('check-reconstruction').disabled = true;
    $('reconstruction-service').textContent = '正在检查重建服务…';
    try {
      const health = await request('/health');
      connected = !health.preview;
      $('reconstruction-service').textContent = health.preview ? '当前只能浏览房间和回放。要重建新房间，请连接支持重建的服务器。' : '房间重建服务已连接';
    } catch (error) {
      connected = false;
      $('reconstruction-service').textContent = error.message;
    } finally { $('check-reconstruction').disabled = false; controls(); }
  }
  function pick(file) {
    if (uploading) return;
    selected = file; uploadID = null;
    $('scan-selected').textContent = file ? `${file.name} · ${(file.size / 1024 ** 2).toFixed(1)} MB` : '选择或拖入完整扫描包';
    report(file ? scanError(file, $('reconstruction-name').value || '房间') : '');
    controls();
  }
  $('reconstruct-room').onclick = () => { dialog.showModal(); void check(); };
  $('close-reconstruction').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (uploading) event.preventDefault(); });
  $('check-reconstruction').onclick = check;
  $('reconstruction-file').onchange = event => pick(event.target.files[0]);
  $('remove-scan').onclick = () => {
    if (uploading) return;
    $('reconstruction-file').value = '';
    $('scan-upload-progress').hidden = true;
    $('scan-progress').value = 0;
    pick(null);
    $('reconstruction-file').focus();
  };
  $('reconstruction-name').oninput = () => {uploadID = null; controls();};
  const drop = $('scan-drop');
  drop.ondragover = event => {event.preventDefault(); if (!uploading) drop.classList.add('dragging');};
  drop.ondragleave = () => drop.classList.remove('dragging');
  drop.ondrop = event => {
    event.preventDefault(); drop.classList.remove('dragging');
    if (uploading) return;
    if (event.dataTransfer.files.length !== 1) return report('每次请选择一个房间的扫描包。');
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
        xhr.setRequestHeader('Content-Type', /\.zip$/i.test(selected.name) ? 'application/zip' : 'application/octet-stream');
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
      $('scan-selected').textContent = '选择或拖入完整扫描包';
      await refresh();
      $('reconstruction-jobs').scrollIntoView({block: 'nearest'});
    } catch (error) { report(error.message); void refresh(); }
    finally { uploading = false; $('scan-upload-progress').hidden = true; controls(); }
  };
  async function refresh() {
    if (polling) return;
    polling = true; $('refresh-jobs').disabled = true;
    try {
      let {jobs, stale} = await request('/jobs');
      if (!Array.isArray(jobs)) throw new Error('任务列表格式无效，请检查重建服务版本。');
      await onJobsChanged(jobs);
      jobs = jobs.filter(job => !isRoomHidden(`scan-${job.id}`));
      $('jobs-message').textContent = stale ? '暂时连不上房间重建服务，以下是上次获取的任务状态。' : '';
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
          // Live while it runs, a replay afterwards.
          if (job.status !== 'queued') {
            const watch = document.createElement('a'); watch.className = 'home-button';
            watch.textContent = ['running', 'preparing'].includes(job.status) ? '实时查看' : '查看过程';
            watch.href = `replay.html?job=${encodeURIComponent(job.id)}`; row.append(watch);
          }
          if (job.status === 'completed' && job.room) {
            const link = document.createElement('a'); link.className = 'home-button'; link.textContent = '进入布置';
            link.href = `editor/?room=${encodeURIComponent(job.room.id)}`; row.append(link);
          } else if (job.status === 'failed' && job.retryable !== false) {
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
  return {refresh};
}
