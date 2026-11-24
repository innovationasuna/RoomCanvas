// Objects rebuilt by ViewForge (object-reconstruction/), read through its object asset API:
//   catalog → {runs: [run id]}, <run> → {base, calibration}, <run>/{result,preview}.glb.
// web/scripts/serve.py forwards /viewforge/assets/ to the ViewForge server so the editor can
// read it from its own origin. ViewForge stores the model in its own units with a display
// transform; one measured edge (axis + meters) gives the real size.
export const API = '/viewforge/assets/';
const LEGACY_API = '/viewforge/layouts/';
let assetAPI = API;
export const AXES = ['X', 'Y', 'Z'];

// 20260926_sofa_web_114146_561893 → sofa; 20260913_stuffed_toy_slim_a01 → stuffed_toy_slim.
export function objectLabel(runId) {
  return runId.replace(/^\d{8}_/, '').replace(/_web_\d+_\d+$/, '').replace(/_(a\d+|\d{8}(_a\d+)?)$/, '') || runId;
}

// Meters per model unit from one measured edge.
export function metricScale(base, axis, meters) {
  const length = base?.lengths?.[axis];
  if (!AXES.includes(axis) || !(length > 0)) throw new Error('模型没有这条边的长度');
  if (!(typeof meters === 'number' && Number.isFinite(meters) && meters > 0 && meters < 100)) throw new Error('请输入 0–100 米之间的实测长度');
  return meters / length;
}

// The saved measurement, if the object was calibrated in ViewForge.
export function savedMeasurement(asset) {
  const c = asset?.calibration;
  return c && AXES.includes(c.axis) && c.dimensions_m?.[c.axis] > 0 ? {axis: c.axis, meters: c.dimensions_m[c.axis]} : null;
}

const multiply = (a, b) => Array.from({length: 16}, (_, i) => {
  const row = i % 4, column = Math.floor(i / 4);
  return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
});

// Column-major matrix (Three.js Matrix4 order) from the model's own coordinates to meters,
// with the footprint centred on the origin and the bottom at y = 0.
export function placementMatrix(base, scale) {
  const {min, max} = base.bounds;
  const center = [0, 1, 2].map((i) => i === 1 ? min[1] : (min[i] + max[i]) / 2);
  const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -center[0], -center[1], -center[2], 1];
  const resize = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, 1];
  return multiply(resize, multiply(shift, base.transform));
}

export function sizeInMeters(base, scale) {
  return [0, 1, 2].map((i) => (base.bounds.max[i] - base.bounds.min[i]) * scale);
}

async function json(url, fetcher) {
  const response = await fetcher(url, {cache: 'no-store'});
  if (!response.ok) {
    const data = await response.json?.().catch(() => ({}));
    const error = new Error(data?.error || `未能读取物品模型，请稍后重试（${response.status}）`);
    error.status = response.status;
    error.state = data?.state;
    throw error;
  }
  return response.json();
}
export async function readCatalog(fetcher = fetch) {
  try {
    const catalog = await json(API + 'catalog', fetcher);
    assetAPI = API;
    return catalog;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  // A running backend or local proxy may precede the object-only API migration.
  // Only read object assets through the old paths; no scene endpoints are used.
  const catalog = await json(LEGACY_API + 'catalog', fetcher);
  assetAPI = LEGACY_API + 'assets/';
  return catalog;
}
export const readAsset = (run, fetcher = fetch) => json(assetAPI + encodeURIComponent(run), fetcher);
export const modelURL = (run, file) => `${assetAPI}${encodeURIComponent(run)}/${file}`;

// A geometry-only proxy is independent of the full display/PBR asset. Legacy runs
// fall back to their preview, then a separate scene sharing the original geometry.
export async function loadModels(run, load) {
  const [full, preview] = await Promise.all([
    load(modelURL(run, 'result.glb')),
    load(modelURL(run, 'collision.glb')).catch(() => load(modelURL(run, 'preview.glb')).catch(() => null)),
  ]);
  return {full, light: preview || {scene: full.scene.clone(true)}};
}
