// Objects rebuilt by ViewForge (object-reconstruction/), read through its layout API:
//   catalog → {runs: [run id]}, assets/<run> → {base, calibration}, assets/<run>/{result,preview}.glb.
// web/scripts/serve.py forwards /viewforge/layouts/ to the ViewForge server so the editor can
// read it from its own origin. ViewForge stores the model in its own units with a display
// transform; one measured edge (axis + meters) gives the real size, as in its layout page.
export const API = '/viewforge/layouts/';
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
// with the footprint centred on the origin and the bottom at y = 0. ViewForge's Babylon page
// applies the same transform, then the same centring, then the same scale.
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

async function json(path, fetcher) {
  const response = await fetcher(API + path, {cache: 'no-store'});
  if (!response.ok) throw new Error(`ViewForge 读取失败（${response.status}）`);
  return response.json();
}
export const readCatalog = (fetcher = fetch) => json('catalog', fetcher);
export const readAsset = (run, fetcher = fetch) => json(`assets/${encodeURIComponent(run)}`, fetcher);
export const modelURL = (run, file) => `${API}assets/${encodeURIComponent(run)}/${file}`;
