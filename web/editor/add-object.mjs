// "添加物体": a few photos → an object rebuilt on the ViewForge server (object-reconstruction/,
// scripts/objects.py). create → masks job → reconstruct job, polled at jobs/<id>; the measured
// edge is saved at /viewforge/dimensions/<run> and reused by RoomCanvas's "导入物体".
// 补拍: capture adds photos to the object of a finished run; reconstruct then names that run as the
// parent and keeps its photos. Each run's COVER suggestion (preview.json) shows where to shoot next.
// web/scripts/serve.py forwards these from the editor's own origin.
export const API = '/viewforge/objects/';
export const MIN_PHOTOS = 1, MAX_PHOTOS = 40;

// The server takes names of letters, digits, _ . - (Chinese included), up to 80 characters.
export function objectName(text) {
  const name = String(text || '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_.-]/gu, '').slice(0, 80);
  return /^[\p{L}\p{N}_]/u.test(name) ? name : '';
}

export const STAGES = [
  ['queued', '排队等 GPU'], ['preparing', '准备输入'], ['da3', '估计深度与相机'],
  ['reconstruction', '重建三维模型'], ['cover', '计算补拍建议'],
];
export function reconstructionStages(job) {
  return Array.isArray(job?.pipeline_stages) ? STAGES.filter(([id]) => job.pipeline_stages.includes(id)) : STAGES;
}
export function reconstructionPhotoLimits(capabilities, parent = false) {
  return parent ? {min: MIN_PHOTOS, max: MAX_PHOTOS} : {
    min: capabilities?.min_photos ?? MIN_PHOTOS, max: capabilities?.max_photos ?? MAX_PHOTOS,
  };
}
export function stageLabel(job) {
  if (job.status === 'queued') return STAGES[0][1];
  if (job.kind === 'masks') return '正在抠图';
  return (STAGES.find(([id]) => id === job.stage) || STAGES[1])[1];
}

export function duration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0)), m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// A phone photo the server cannot read (HEIC and the like) is redrawn as JPEG when the browser can decode it.
export const readable = (file) => file.type === 'image/jpeg' || file.type === 'image/png';

async function reply(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `服务器出错（${response.status}）`);
  return data;
}
const post = (path, body, fetcher = fetch) => fetcher(path, {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
}).then(reply);

// Upload with progress (fetch cannot report it). onProgress gets 0–1.
function upload(route, fields, files, onProgress) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const file of files) form.append('photos', file, file.name);
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', API + route);
    request.upload.onprogress = (event) => {if (event.lengthComputable) onProgress(event.loaded / event.total);};
    request.onload = () => {
      let data = {};
      try {data = JSON.parse(request.responseText);} catch {}
      if (request.status === 200) resolve(data); else reject(new Error(data.error || `上传失败（${request.status}）`));
    };
    request.onerror = () => reject(new Error('上传失败：连不上 ViewForge（检查隧道）'));
    request.send(form);
  });
}
export const createObject = (name, files, onProgress = () => {}) => upload('create', {name}, files, onProgress);
// → {object, parent, kept, images: kept + added, added}
export const captureObject = (run, files, onProgress = () => {}) => upload('capture', {run}, files, onProgress);
export const startMasks = (object, images, fetcher) => post(API + 'masks', {object, images}, fetcher);
export const startReconstruction = (object, images, masks, fetcher, parent = null) =>
  post(API + 'reconstruct', {object, images, masks, ...(parent ? {parent} : {})}, fetcher);
export const readJob = (id, fetcher = fetch) => fetcher(`${API}jobs/${id}`, {cache: 'no-store'}).then(reply);
export const previewURL = (path) => API + path.split('/').map(encodeURIComponent).join('/');
export const saveMeasurement = (run, axis, meters, fetcher) =>
  post(`/viewforge/dimensions/${encodeURIComponent(run)}`, {axis, value: meters, unit: 'm'}, fetcher);

// Poll a job until it is complete (resolves) or failed (rejects); onUpdate sees every state.
export async function follow(id, onUpdate = () => {}, {every = 2000, fetcher, signal} = {}) {
  for (;;) {
    const job = await readJob(id, fetcher);
    onUpdate(job);
    if (job.status === 'complete') return job;
    if (job.status === 'failed') throw new Error(job.error || '任务失败');
    if (signal?.aborted) throw new Error('已停止跟踪');
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

// The run's COVER manifest (cover/preview.json) → where to shoot next, in the model's display frame,
// with the matrix that takes the loaded GLB (result or preview) into that frame. null without one.
export function coverSuggestion(manifest, model = 'glb_preview') {
  const rec = manifest?.status === 'complete' && manifest.recommendation;
  const transform = (manifest?.assets?.[model] || manifest?.assets?.glb)?.transform;
  if (!rec || !Array.isArray(transform) || transform.length !== 16) return null;
  const vector = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? v : null;
  const [position, target, up] = [rec.position, rec.target, rec.up].map(vector);
  if (!position || !target || !up || !(rec.fov_y > 0)) return null;
  return {transform, position, target, up, fovDegrees: rec.fov_y * 180 / Math.PI};
}
export const readManifest = (url, fetcher = fetch) => fetcher(url, {cache: 'no-store'}).then(reply);
export const readCapabilities = (fetcher = fetch) => fetcher(API + 'capabilities', {cache: 'no-store'}).then(reply);
